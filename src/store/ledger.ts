import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { contentHash, sha256 } from '../ids.js';
import { nowIso, timezoneSlug } from '../time.js';
import { renderWorklogMarkdown, type MarkdownMetadata } from '../worklog/markdown.js';
import type {
  NormalizedWorklog,
  SyncState,
  WorklogDocument,
  WorklogSyncState,
} from '../worklog/schema.js';
import { ftsAvailable, openDatabase, type SqliteDatabase } from './db.js';

interface WorklogRow {
  worklog_id: string;
  local_date: string;
  timezone: string;
  title: string;
  revision: number;
  content_hash: string;
  content_json: string;
  markdown_path: string;
  created_at: string;
  updated_at: string;
}

interface SyncRow {
  worklog_id: string;
  state: SyncState;
  calendar_id: string | null;
  memo_id: string | null;
  remote_title: string | null;
  remote_hash: string | null;
  published_at: string | null;
  verified_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
}

export interface SearchResult {
  worklogId: string;
  date: string;
  timezone: string;
  title: string;
  revision: number;
  syncState: SyncState;
  snippet: string;
  markdownPath: string;
}

export interface SearchOptions {
  query?: string;
  from?: string;
  to?: string;
  timezone?: string;
  syncState?: SyncState;
  limit?: number;
  offset?: number;
}

export interface SyncPatch {
  state?: SyncState;
  calendarId?: string | null;
  memoId?: string | null;
  remoteTitle?: string | null;
  remoteHash?: string | null;
  publishedAt?: string | null;
  verifiedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

export interface SyncAttempt {
  attemptId: string;
  worklogId: string;
  operation: string;
  state: string;
  requestFingerprint: string;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  memoId?: string;
}

function archivePath(archiveDir: string, worklog: NormalizedWorklog): string {
  const [year, month] = worklog.date.split('-');
  return join(archiveDir, year!, month!, `${worklog.date}--${timezoneSlug(worklog.timezone)}.md`);
}

function searchBody(worklog: NormalizedWorklog): string {
  const lines = [
    worklog.executiveSummary,
    ...worklog.completedTasks.flatMap((task) => [task.description, task.details ?? '']),
    ...worklog.workInProgress.flatMap((task) => [task.description, task.details ?? '']),
    ...worklog.blockers.flatMap((blocker) => [
      blocker.description,
      blocker.impact ?? '',
      blocker.mitigation ?? '',
    ]),
    ...worklog.decisions.flatMap((decision) => [decision.decision, decision.rationale ?? '']),
    ...worklog.nextActions.flatMap((action) => [action.action, action.owner ?? '']),
    ...worklog.evidence.flatMap((evidence) => [
      evidence.id,
      evidence.reference,
      evidence.description ?? '',
    ]),
  ];
  return lines.filter(Boolean).join('\n');
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Ignore cleanup failure.
    }
    throw error;
  }
}

function restoreFile(path: string, previous: string | undefined): void {
  try {
    if (previous === undefined) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      writeAtomic(path, previous);
    }
  } catch {
    // The original write failure is more important than a best-effort restore.
  }
}

function escapeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/["']/g, '').trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!terms.length) return '';
  return terms.map((term) => `"${term}"`).join(' AND ');
}

export class Ledger {
  private readonly db: SqliteDatabase;
  private readonly fts: boolean;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.fts = ftsAvailable(this.db);
  }

  close(): void {
    this.db.close();
  }

  get raw(): SqliteDatabase {
    return this.db;
  }

  private getWorklogRow(worklogId: string): WorklogRow | undefined {
    return this.db.prepare('SELECT * FROM worklogs WHERE worklog_id = ?').get(worklogId) as
      WorklogRow | undefined;
  }

  private getWorklogRowByDate(date: string, timezone: string): WorklogRow | undefined {
    return this.db
      .prepare('SELECT * FROM worklogs WHERE local_date = ? AND timezone = ?')
      .get(date, timezone) as WorklogRow | undefined;
  }

  private getSyncRow(worklogId: string): SyncRow | undefined {
    return this.db.prepare('SELECT * FROM sync_state WHERE worklog_id = ?').get(worklogId) as
      SyncRow | undefined;
  }

  getSyncState(worklogId: string): WorklogSyncState {
    const row = this.getSyncRow(worklogId);
    if (!row) throw new AppError('WORKLOG_NOT_FOUND', `No synchronization state for ${worklogId}`);
    return this.mapSync(row);
  }

  private mapSync(row: SyncRow): WorklogSyncState {
    return {
      state: row.state,
      ...(row.calendar_id ? { calendarId: row.calendar_id } : {}),
      ...(row.memo_id ? { memoId: row.memo_id } : {}),
      ...(row.remote_title ? { remoteTitle: row.remote_title } : {}),
      ...(row.remote_hash ? { remoteHash: row.remote_hash } : {}),
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
      ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
      ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
      updatedAt: row.updated_at,
    };
  }

  private rowToDocument(row: WorklogRow): WorklogDocument {
    const parsed = JSON.parse(row.content_json) as NormalizedWorklog;
    const sync = this.getSyncRow(row.worklog_id);
    if (!sync) throw new AppError('DATABASE_ERROR', `Missing sync state for ${row.worklog_id}`);
    let markdown = '';
    if (existsSync(row.markdown_path)) {
      markdown = readFileSync(row.markdown_path, 'utf8');
    } else {
      const revision = this.db
        .prepare('SELECT markdown FROM worklog_revisions WHERE worklog_id = ? AND revision = ?')
        .get(row.worklog_id, row.revision) as { markdown: string } | undefined;
      markdown = revision?.markdown ?? '';
    }
    return {
      ...parsed,
      worklogId: row.worklog_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      markdown,
      markdownPath: row.markdown_path,
      sync: this.mapSync(sync),
    };
  }

  getById(worklogId: string): WorklogDocument | undefined {
    const row = this.getWorklogRow(worklogId);
    return row ? this.rowToDocument(row) : undefined;
  }

  getByDate(date: string, timezone: string): WorklogDocument | undefined {
    const row = this.getWorklogRowByDate(date, timezone);
    return row ? this.rowToDocument(row) : undefined;
  }

  saveLocal(
    worklog: NormalizedWorklog,
    archiveDir: string,
    idempotencyKey?: string,
  ): { document: WorklogDocument; created: boolean; unchanged: boolean } {
    const existingById = this.getWorklogRow(worklog.worklogId);
    const existingByDate = this.getWorklogRowByDate(worklog.date, worklog.timezone);
    if (existingByDate && existingByDate.worklog_id !== worklog.worklogId) {
      throw new AppError(
        'WORKLOG_CONFLICT',
        `A different work log already exists for ${worklog.date} in ${worklog.timezone}`,
      );
    }
    const existing = existingById ?? existingByDate;
    if (existing && existing.content_hash === worklog.contentHash) {
      if (!existsSync(existing.markdown_path)) {
        const sync = this.getSyncRow(existing.worklog_id);
        if (!sync) {
          throw new AppError('DATABASE_ERROR', `Missing sync state for ${existing.worklog_id}`);
        }
        const metadata: MarkdownMetadata = {
          revision: existing.revision,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
          sync: this.mapSync(sync),
        };
        writeAtomic(existing.markdown_path, renderWorklogMarkdown(worklog, metadata));
        this.addEvent(existing.worklog_id, 'markdown.restored', {
          revision: existing.revision,
        });
      }
      this.recordIdempotency(
        idempotencyKey,
        'save_worklog',
        worklog.worklogId,
        worklog.contentHash,
      );
      return {
        document: this.rowToDocument(existing),
        created: false,
        unchanged: true,
      };
    }

    const path = archivePath(archiveDir, worklog);
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const transaction = this.db.transaction(() => {
      const now = nowIso();
      const createdAt = existing?.created_at ?? now;
      const revision = (existing?.revision ?? 0) + 1;
      const previousSync = existing ? this.getSyncRow(existing.worklog_id) : undefined;
      const sync = this.nextSync(previousSync, existing !== undefined, now);
      const metadata: MarkdownMetadata = {
        revision,
        createdAt,
        updatedAt: now,
        sync,
      };
      const markdown = renderWorklogMarkdown(worklog, metadata);
      const contentJson = JSON.stringify(worklog);

      writeAtomic(path, markdown);

      if (existing) {
        this.db
          .prepare(
            `UPDATE worklogs
             SET title = ?, revision = ?, content_hash = ?, content_json = ?, markdown_path = ?, updated_at = ?
             WHERE worklog_id = ?`,
          )
          .run(
            worklog.title,
            revision,
            worklog.contentHash,
            contentJson,
            path,
            now,
            worklog.worklogId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO worklogs
             (worklog_id, local_date, timezone, title, revision, content_hash, content_json, markdown_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            worklog.worklogId,
            worklog.date,
            worklog.timezone,
            worklog.title,
            revision,
            worklog.contentHash,
            contentJson,
            path,
            createdAt,
            now,
          );
      }

      this.db
        .prepare(
          `INSERT OR REPLACE INTO worklog_revisions
           (worklog_id, revision, content_hash, content_json, markdown, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(worklog.worklogId, revision, worklog.contentHash, contentJson, markdown, now);

      this.db
        .prepare(
          `INSERT INTO sync_state
           (worklog_id, state, calendar_id, memo_id, remote_title, remote_hash, published_at, verified_at,
            last_error_code, last_error_message, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(worklog_id) DO UPDATE SET
             state = excluded.state,
             calendar_id = excluded.calendar_id,
             memo_id = excluded.memo_id,
             remote_title = excluded.remote_title,
             remote_hash = excluded.remote_hash,
             published_at = excluded.published_at,
             verified_at = excluded.verified_at,
             last_error_code = excluded.last_error_code,
             last_error_message = excluded.last_error_message,
             updated_at = excluded.updated_at`,
        )
        .run(
          worklog.worklogId,
          sync.state,
          sync.calendarId ?? null,
          sync.memoId ?? null,
          sync.remoteTitle ?? null,
          sync.remoteHash ?? null,
          sync.publishedAt ?? null,
          sync.verifiedAt ?? null,
          sync.lastErrorCode ?? null,
          sync.lastErrorMessage ?? null,
          sync.updatedAt,
        );

      this.db.prepare('DELETE FROM worklog_fts WHERE worklog_id = ?').run(worklog.worklogId);
      this.db
        .prepare(
          'INSERT INTO worklog_fts (worklog_id, local_date, title, body) VALUES (?, ?, ?, ?)',
        )
        .run(worklog.worklogId, worklog.date, worklog.title, searchBody(worklog));

      this.recordIdempotency(
        idempotencyKey,
        'save_worklog',
        worklog.worklogId,
        worklog.contentHash,
      );
      this.addEvent(worklog.worklogId, existing ? 'worklog.updated' : 'worklog.created', {
        revision,
        contentHash: worklog.contentHash,
      });

      const document = this.rowToDocument({
        worklog_id: worklog.worklogId,
        local_date: worklog.date,
        timezone: worklog.timezone,
        title: worklog.title,
        revision,
        content_hash: worklog.contentHash,
        content_json: contentJson,
        markdown_path: path,
        created_at: createdAt,
        updated_at: now,
      });
      return { document, created: !existing, unchanged: false };
    });

    try {
      return transaction();
    } catch (error) {
      restoreFile(path, previous);
      throw error;
    }
  }

  private nextSync(
    previous: SyncRow | undefined,
    existing: boolean,
    now: string,
  ): WorklogSyncState {
    if (!previous || !existing) {
      return { state: 'NOT_PUBLISHED', updatedAt: now };
    }
    let state: SyncState = previous.state;
    if (previous.state === 'PUBLISHED' || previous.state === 'CONFLICT' || previous.memo_id) {
      state = 'STALE';
    } else if (previous.state === 'PUBLISHING' || previous.state === 'UNCERTAIN') {
      state = 'STALE';
    } else if (previous.state === 'STALE' || previous.state === 'BLOCKED') {
      state = previous.state;
    } else {
      state = 'NOT_PUBLISHED';
    }
    return {
      state,
      ...(previous.calendar_id ? { calendarId: previous.calendar_id } : {}),
      ...(previous.memo_id ? { memoId: previous.memo_id } : {}),
      ...(previous.remote_title ? { remoteTitle: previous.remote_title } : {}),
      ...(previous.remote_hash ? { remoteHash: previous.remote_hash } : {}),
      ...(previous.published_at ? { publishedAt: previous.published_at } : {}),
      ...(previous.verified_at ? { verifiedAt: previous.verified_at } : {}),
      updatedAt: now,
    };
  }

  updateSync(worklogId: string, patch: SyncPatch): WorklogSyncState {
    const previous = this.getSyncRow(worklogId);
    if (!previous) throw new AppError('WORKLOG_NOT_FOUND', `Unknown work log ${worklogId}`);
    const now = nowIso();
    const next: SyncRow = {
      ...previous,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      calendar_id: patch.calendarId !== undefined ? patch.calendarId : previous.calendar_id,
      memo_id: patch.memoId !== undefined ? patch.memoId : previous.memo_id,
      remote_title: patch.remoteTitle !== undefined ? patch.remoteTitle : previous.remote_title,
      remote_hash: patch.remoteHash !== undefined ? patch.remoteHash : previous.remote_hash,
      published_at: patch.publishedAt !== undefined ? patch.publishedAt : previous.published_at,
      verified_at: patch.verifiedAt !== undefined ? patch.verifiedAt : previous.verified_at,
      last_error_code:
        patch.lastErrorCode !== undefined ? patch.lastErrorCode : previous.last_error_code,
      last_error_message:
        patch.lastErrorMessage !== undefined ? patch.lastErrorMessage : previous.last_error_message,
      updated_at: now,
    };
    this.db
      .prepare(
        `UPDATE sync_state SET state = ?, calendar_id = ?, memo_id = ?, remote_title = ?, remote_hash = ?,
         published_at = ?, verified_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
         WHERE worklog_id = ?`,
      )
      .run(
        next.state,
        next.calendar_id,
        next.memo_id,
        next.remote_title,
        next.remote_hash,
        next.published_at,
        next.verified_at,
        next.last_error_code,
        next.last_error_message,
        next.updated_at,
        worklogId,
      );
    this.addEvent(worklogId, 'sync.state_changed', { state: next.state });
    return this.mapSync(next);
  }

  list(range?: {
    from?: string;
    to?: string;
    timezone?: string;
    syncState?: SyncState;
  }): WorklogDocument[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (range?.from) {
      clauses.push('w.local_date >= ?');
      values.push(range.from);
    }
    if (range?.to) {
      clauses.push('w.local_date <= ?');
      values.push(range.to);
    }
    if (range?.timezone) {
      clauses.push('w.timezone = ?');
      values.push(range.timezone);
    }
    if (range?.syncState) {
      clauses.push('s.state = ?');
      values.push(range.syncState);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT w.* FROM worklogs w JOIN sync_state s ON s.worklog_id = w.worklog_id
         ${where} ORDER BY w.local_date ASC, w.timezone ASC`,
      )
      .all(...values) as WorklogRow[];
    return rows.map((row) => this.rowToDocument(row));
  }

  search(options: SearchOptions): { results: SearchResult[]; total: number } {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const clauses: string[] = [];
    const values: unknown[] = [];
    const query = options.query?.trim() ?? '';

    let base: string;
    if (query && this.fts) {
      const ftsQuery = escapeFtsQuery(query);
      if (ftsQuery) {
        base = `FROM worklog_fts f JOIN worklogs w ON w.worklog_id = f.worklog_id
                 JOIN sync_state s ON s.worklog_id = w.worklog_id
                 WHERE worklog_fts MATCH ?`;
        values.push(ftsQuery);
      } else {
        base = this.likeBase(true);
        values.push(`%${query}%`, `%${query}%`);
      }
    } else if (query) {
      base = this.likeBase(true);
      values.push(`%${query}%`, `%${query}%`);
    } else {
      base = this.likeBase(false);
    }

    if (options.from) {
      clauses.push('w.local_date >= ?');
      values.push(options.from);
    }
    if (options.to) {
      clauses.push('w.local_date <= ?');
      values.push(options.to);
    }
    if (options.timezone) {
      clauses.push('w.timezone = ?');
      values.push(options.timezone);
    }
    if (options.syncState) {
      clauses.push('s.state = ?');
      values.push(options.syncState);
    }
    const where = clauses.length ? `${query ? ' AND ' : ' WHERE '}${clauses.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count ${base}${where}`).get(...values) as {
      count: number;
    };
    const rows = this.db
      .prepare(
        `SELECT w.worklog_id, w.local_date, w.timezone, w.title, w.revision, w.markdown_path,
                s.state AS sync_state,
                ${this.fts && query ? "snippet(worklog_fts, 3, '[', ']', '…', 12)" : 'substr(w.content_json, 1, 180)'} AS snippet
         ${base}${where}
         ORDER BY w.local_date DESC, w.timezone ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as Array<{
      worklog_id: string;
      local_date: string;
      timezone: string;
      title: string;
      revision: number;
      markdown_path: string;
      sync_state: SyncState;
      snippet: string;
    }>;
    return {
      total: totalRow.count,
      results: rows.map((row) => ({
        worklogId: row.worklog_id,
        date: row.local_date,
        timezone: row.timezone,
        title: row.title,
        revision: row.revision,
        syncState: row.sync_state,
        snippet: row.snippet,
        markdownPath: row.markdown_path,
      })),
    };
  }

  private likeBase(hasQuery: boolean): string {
    const where = hasQuery ? 'WHERE (w.title LIKE ? OR w.content_json LIKE ?)' : '';
    return `FROM worklogs w JOIN sync_state s ON s.worklog_id = w.worklog_id ${where}`;
  }

  countByState(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS count FROM sync_state GROUP BY state')
      .all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  listPending(): WorklogDocument[] {
    const rows = this.db
      .prepare(
        `SELECT w.* FROM worklogs w JOIN sync_state s ON s.worklog_id = w.worklog_id
         WHERE s.state IN ('PUBLISHING', 'UNCERTAIN', 'FAILED_RETRYABLE', 'STALE', 'CONFLICT')
         ORDER BY w.local_date ASC`,
      )
      .all() as WorklogRow[];
    return rows.map((row) => this.rowToDocument(row));
  }

  recordAttempt(attempt: SyncAttempt): void {
    this.db
      .prepare(
        `INSERT INTO sync_attempts
         (attempt_id, worklog_id, operation, state, request_fingerprint, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.attemptId,
        attempt.worklogId,
        attempt.operation,
        attempt.state,
        attempt.requestFingerprint,
        attempt.startedAt,
      );
  }

  finishAttempt(
    attemptId: string,
    state: string,
    result: { errorCode?: string; errorMessage?: string; memoId?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE sync_attempts SET state = ?, finished_at = ?, error_code = ?, error_message = ?, memo_id = ?
         WHERE attempt_id = ?`,
      )
      .run(
        state,
        nowIso(),
        result.errorCode ?? null,
        result.errorMessage ?? null,
        result.memoId ?? null,
        attemptId,
      );
  }

  getAttempts(worklogId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM sync_attempts WHERE worklog_id = ? ORDER BY started_at DESC LIMIT 20')
      .all(worklogId) as Array<Record<string, unknown>>;
  }

  upsertRemoteMemo(input: {
    calendarId: string;
    memoId: string;
    worklogId: string;
    title: string;
    contentHash?: string;
    remoteUpdatedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO remote_memos
         (calendar_id, memo_id, worklog_id, title, content_hash, remote_updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.calendarId,
        input.memoId,
        input.worklogId,
        input.title,
        input.contentHash ?? null,
        input.remoteUpdatedAt ?? null,
        nowIso(),
      );
  }

  findRemoteMemo(
    calendarId: string,
    worklogId: string,
  ): { memoId: string; title: string } | undefined {
    const row = this.db
      .prepare('SELECT memo_id, title FROM remote_memos WHERE calendar_id = ? AND worklog_id = ?')
      .get(calendarId, worklogId) as { memo_id: string; title: string } | undefined;
    return row ? { memoId: row.memo_id, title: row.title } : undefined;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  addEvent(worklogId: string | null, event: string, details?: unknown): void {
    this.db
      .prepare(
        'INSERT INTO local_events (worklog_id, event, details_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(worklogId, event, details === undefined ? null : JSON.stringify(details), nowIso());
  }

  private recordIdempotency(
    key: string | undefined,
    operation: string,
    worklogId: string,
    requestHash: string,
  ): void {
    if (!key) return;
    const existing = this.db
      .prepare('SELECT worklog_id, request_hash FROM idempotency_keys WHERE key = ?')
      .get(key) as { worklog_id: string; request_hash: string } | undefined;
    if (existing) {
      if (existing.worklog_id !== worklogId || existing.request_hash !== requestHash) {
        throw new AppError(
          'WORKLOG_CONFLICT',
          'This idempotency key was already used for different work-log content',
        );
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO idempotency_keys
         (key, operation, worklog_id, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, operation, worklogId, requestHash, JSON.stringify({ worklogId }), nowIso());
  }

  checkIdempotency(key: string, operation: string, requestHash: string): void {
    const existing = this.db
      .prepare('SELECT operation, request_hash FROM idempotency_keys WHERE key = ?')
      .get(key) as { operation: string; request_hash: string } | undefined;
    if (existing && (existing.operation !== operation || existing.request_hash !== requestHash)) {
      throw new AppError(
        'WORKLOG_CONFLICT',
        'This idempotency key was already used for a different request',
      );
    }
  }

  static hashContent(value: unknown): string {
    return contentHash(value);
  }

  static hashText(value: string): string {
    return sha256(value);
  }
}

export { archivePath, writeAtomic };
