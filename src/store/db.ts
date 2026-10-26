import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  migrate(db);
  if (path !== ':memory:') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
  }
  return db;
}

function migrate(db: SqliteDatabase): void {
  const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (version >= 1) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS worklogs (
      worklog_id TEXT PRIMARY KEY,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      content_json TEXT NOT NULL,
      markdown_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(local_date, timezone)
    );

    CREATE TABLE IF NOT EXISTS worklog_revisions (
      worklog_id TEXT NOT NULL REFERENCES worklogs(worklog_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      content_json TEXT NOT NULL,
      markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (worklog_id, revision)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      worklog_id TEXT PRIMARY KEY REFERENCES worklogs(worklog_id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN (
        'NOT_PUBLISHED', 'PUBLISHING', 'PUBLISHED', 'FAILED_RETRYABLE',
        'FAILED_PERMANENT', 'UNCERTAIN', 'STALE', 'CONFLICT', 'BLOCKED'
      )),
      calendar_id TEXT,
      memo_id TEXT,
      remote_title TEXT,
      remote_hash TEXT,
      published_at TEXT,
      verified_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_attempts (
      attempt_id TEXT PRIMARY KEY,
      worklog_id TEXT NOT NULL REFERENCES worklogs(worklog_id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      state TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT,
      memo_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_attempts_worklog
      ON sync_attempts(worklog_id, started_at);

    CREATE TABLE IF NOT EXISTS remote_memos (
      calendar_id TEXT NOT NULL,
      memo_id TEXT NOT NULL,
      worklog_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT,
      remote_updated_at TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (calendar_id, memo_id),
      UNIQUE (calendar_id, worklog_id)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      worklog_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worklog_id TEXT,
      event TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS worklog_fts USING fts5(
        worklog_id UNINDEXED,
        local_date UNINDEXED,
        title,
        body,
        tokenize = 'unicode61'
      );
    `);
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worklog_fts (
        worklog_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worklog_fts_date ON worklog_fts(local_date);
    `);
  }

  db.pragma('user_version = 1');
}

export function ftsAvailable(db: SqliteDatabase): boolean {
  try {
    const row = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as {
      enabled: number | bigint;
    };
    return Number(row.enabled) === 1;
  } catch {
    return false;
  }
}
