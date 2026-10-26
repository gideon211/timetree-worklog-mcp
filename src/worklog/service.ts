import { join } from 'node:path';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { sha256 } from '../ids.js';
import {
  assertIsoDate,
  assertTimeZone,
  eachDate,
  longDate,
  nowIso,
  timezoneSlug,
} from '../time.js';
import {
  archivePath,
  writeAtomic,
  type Ledger,
  type SearchOptions,
  type SearchResult,
} from '../store/ledger.js';
import {
  renderRemoteNote,
  renderWorklogMarkdown,
  type MarkdownMetadata,
  type RemotePayload,
} from './markdown.js';
import type {
  NormalizedWorklog,
  SyncState,
  WorklogDocument,
  WorklogInput,
  WorklogSyncState,
} from './schema.js';
import { findSecretWarnings, normalizeWorklog, type SecretWarning } from './validate.js';

export interface PreviewResult {
  worklogId: string;
  date: string;
  timezone: string;
  revision: number;
  contentHash: string;
  previewHash: string;
  markdown: string;
  remote: RemotePayload & { title: string };
  warnings: string[];
  secretWarnings: SecretWarning[];
  changed: boolean;
  existingRevision?: number;
}

export interface SaveResult {
  document: WorklogDocument;
  created: boolean;
  unchanged: boolean;
  warnings: string[];
  secretWarnings: SecretWarning[];
  previewHash: string;
}

export interface GetWorklogInput {
  worklogId?: string;
  date?: string;
  timezone?: string;
}

export interface ProgressReportResult {
  report: string;
  reportPath: string;
  from: string;
  to: string;
  timezone: string;
  worklogIds: string[];
  worklogCount: number;
  warnings: string[];
}

const MAX_REPORT_DAYS = 366;

function sourceLabel(source: 'user' | 'evidence'): string {
  return source === 'evidence' ? 'evidence-linked' : 'user-reported';
}

function remotePublicationWarning(
  existing: WorklogDocument | undefined,
  changed: boolean,
): string | undefined {
  if (!existing) return undefined;
  const state = existing.sync.state;
  const hasPriorPublication =
    Boolean(existing.sync.memoId) ||
    ['PUBLISHED', 'PUBLISHING', 'UNCERTAIN', 'STALE', 'CONFLICT'].includes(state);
  if (!hasPriorPublication) return undefined;
  if (!changed && state !== 'STALE' && state !== 'CONFLICT') return undefined;
  return 'This work log has a prior remote publication record. Publishing content that differs from the remote memo will not update it; reconciliation will report CONFLICT or require manual resolution.';
}

function nextSyncForPreview(existing: WorklogDocument | undefined): WorklogSyncState {
  const updatedAt = nowIso();
  if (!existing) return { state: 'NOT_PUBLISHED', updatedAt };
  const previous = existing.sync;
  let state: SyncState;
  if (
    previous.state === 'PUBLISHED' ||
    previous.state === 'CONFLICT' ||
    previous.state === 'PUBLISHING' ||
    previous.state === 'UNCERTAIN' ||
    previous.memoId
  ) {
    state = 'STALE';
  } else if (previous.state === 'STALE' || previous.state === 'BLOCKED') {
    state = previous.state;
  } else {
    state = 'NOT_PUBLISHED';
  }
  if (state === 'NOT_PUBLISHED') return { state, updatedAt };
  return {
    state,
    ...(previous.calendarId ? { calendarId: previous.calendarId } : {}),
    ...(previous.memoId ? { memoId: previous.memoId } : {}),
    ...(previous.remoteTitle ? { remoteTitle: previous.remoteTitle } : {}),
    ...(previous.remoteHash ? { remoteHash: previous.remoteHash } : {}),
    ...(previous.publishedAt ? { publishedAt: previous.publishedAt } : {}),
    ...(previous.verifiedAt ? { verifiedAt: previous.verifiedAt } : {}),
    updatedAt,
  };
}

function previewHashOf(contentHash: string, noteHash: string): string {
  return sha256(`preview:${contentHash}:${noteHash}`);
}

function formatTask(task: {
  description: string;
  details?: string;
  evidenceIds: string[];
}): string {
  const details = task.details ? ` — ${task.details}` : '';
  const evidence = task.evidenceIds.length ? ` _(evidence: ${task.evidenceIds.join(', ')})_` : '';
  return `${task.description}${details}${evidence}`;
}

export class WorklogService {
  private readonly config: AppConfig;
  private readonly ledger: Ledger;
  private readonly logger: Logger;

  constructor(config: AppConfig, ledger: Ledger, logger: Logger = defaultLogger) {
    this.config = config;
    this.ledger = ledger;
    this.logger = logger;
  }

  preview(input: WorklogInput): PreviewResult {
    const { worklog, warnings, secretWarnings } = normalizeWorklog(input, this.config.timezone);
    const existing = this.ledger.getByDate(worklog.date, worklog.timezone);
    const changed = !existing || existing.contentHash !== worklog.contentHash;
    const publicationWarning = remotePublicationWarning(existing, changed);
    if (publicationWarning) warnings.push(publicationWarning);
    const revision = existing ? existing.revision + (changed ? 1 : 0) : 1;
    const sync = changed
      ? nextSyncForPreview(existing)
      : (existing?.sync ?? nextSyncForPreview(undefined));
    const metadata: MarkdownMetadata = {
      revision,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      sync,
    };
    const markdown = renderWorklogMarkdown(worklog, metadata);
    const remote = renderRemoteNote(worklog, revision, this.config.remoteMaxChars);
    return {
      worklogId: worklog.worklogId,
      date: worklog.date,
      timezone: worklog.timezone,
      revision,
      contentHash: worklog.contentHash,
      previewHash: previewHashOf(worklog.contentHash, remote.noteHash),
      markdown,
      remote,
      warnings,
      secretWarnings,
      changed,
      ...(existing ? { existingRevision: existing.revision } : {}),
    };
  }

  save(input: WorklogInput, idempotencyKey?: string): SaveResult {
    const { worklog, warnings, secretWarnings } = normalizeWorklog(input, this.config.timezone);
    const existing = this.ledger.getByDate(worklog.date, worklog.timezone);
    const changed = !existing || existing.contentHash !== worklog.contentHash;
    const publicationWarning = remotePublicationWarning(existing, changed);
    if (publicationWarning) warnings.push(publicationWarning);
    const result = this.ledger.saveLocal(worklog, this.config.archiveDir, idempotencyKey);
    const remote = renderRemoteNote(worklog, result.document.revision, this.config.remoteMaxChars);
    return {
      document: result.document,
      created: result.created,
      unchanged: result.unchanged,
      warnings,
      secretWarnings,
      previewHash: previewHashOf(worklog.contentHash, remote.noteHash),
    };
  }

  resolve(input: GetWorklogInput): WorklogDocument {
    if (input.worklogId) {
      const found = this.ledger.getById(input.worklogId);
      if (!found) {
        throw new AppError('WORKLOG_NOT_FOUND', `No work log found with id ${input.worklogId}`);
      }
      return found;
    }
    if (!input.date) {
      throw new AppError(
        'INVALID_INPUT',
        'Provide either a worklogId or a date (with optional timezone)',
      );
    }
    assertIsoDate(input.date);
    const timezone = assertTimeZone(input.timezone ?? this.config.timezone);
    const found = this.ledger.getByDate(input.date, timezone);
    if (!found) {
      throw new AppError('WORKLOG_NOT_FOUND', `No work log found for ${input.date} in ${timezone}`);
    }
    return found;
  }

  search(options: SearchOptions): { results: SearchResult[]; total: number } {
    if (options.from) assertIsoDate(options.from);
    if (options.to) assertIsoDate(options.to);
    if (options.timezone) assertTimeZone(options.timezone);
    if (options.from && options.to && options.from > options.to) {
      throw new AppError('INVALID_INPUT', 'The search start date must not be after the end date');
    }
    return this.ledger.search(options);
  }

  list(range?: {
    from?: string;
    to?: string;
    timezone?: string;
    syncState?: SyncState;
  }): WorklogDocument[] {
    return this.ledger.list(range);
  }

  generateReport(from: string, to: string, timezone?: string): ProgressReportResult {
    assertIsoDate(from);
    assertIsoDate(to);
    const zone = assertTimeZone(timezone ?? this.config.timezone);
    if (from > to) {
      throw new AppError('INVALID_INPUT', 'The report start date must not be after the end date');
    }
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    const dayCount = Math.floor((toMs - fromMs) / 86_400_000) + 1;
    if (dayCount > MAX_REPORT_DAYS) {
      throw new AppError(
        'INVALID_INPUT',
        `Progress reports are limited to ${MAX_REPORT_DAYS} calendar days per request.`,
      );
    }
    const days = eachDate(from, to);
    const documents = this.ledger.list({ from, to, timezone: zone });
    const warnings: string[] = [];
    if (documents.length === 0) {
      warnings.push('No work logs were recorded in this period.');
    }
    if (documents.some((document) => document.sync.state === 'CONFLICT')) {
      warnings.push('At least one work log has a remote synchronization conflict.');
    }
    if (documents.some((document) => document.sync.state === 'UNCERTAIN')) {
      warnings.push('At least one work log has an uncertain remote publication outcome.');
    }

    const report = this.renderReport(from, to, zone, days, documents);
    const reportPath = join(
      this.config.reportsDir,
      `progress-${from}--${to}--${timezoneSlug(zone)}.md`,
    );
    writeAtomic(reportPath, report);
    return {
      report,
      reportPath,
      from,
      to,
      timezone: zone,
      worklogIds: documents.map((document) => document.worklogId),
      worklogCount: documents.length,
      warnings,
    };
  }

  private renderReport(
    from: string,
    to: string,
    timezone: string,
    days: string[],
    documents: WorklogDocument[],
  ): string {
    const lines: string[] = [
      `# Progress report: ${from} to ${to}`,
      '',
      `**Timezone:** ${timezone}`,
      `**Period:** ${longDate(from)} to ${longDate(to)} (${days.length} calendar day${days.length === 1 ? '' : 's'})`,
      `**Generated:** ${nowIso()}`,
      `**Work logs included:** ${documents.length}`,
      '',
      '> This report is assembled only from locally saved work logs. Statements are user-reported unless an evidence item is explicitly marked verified. Nothing in this report is inferred or invented.',
      '',
    ];

    if (documents.length === 0) {
      lines.push(
        '## Executive summary',
        '',
        'No work logs were recorded for this period. No progress, completion, decision, blocker or next action is asserted.',
        '',
        '## Work log index',
        '',
        '_No work logs._',
        '',
      );
      return `${lines.join('\n')}\n`;
    }

    lines.push('## Executive summaries', '');
    for (const document of documents) {
      lines.push(
        `### ${document.date} — ${document.title}`,
        '',
        `Work log ID: \`${document.worklogId}\` (revision ${document.revision}, sync state ${document.sync.state})`,
        '',
        document.executiveSummary.trim(),
        '',
      );
    }

    lines.push('## Completed tasks', '');
    const completed = documents.flatMap((document) =>
      document.completedTasks.map((task) => ({ document, task })),
    );
    if (!completed.length) {
      lines.push('_No completed tasks were recorded._', '');
    } else {
      for (const { document, task } of completed) {
        lines.push(
          `- ${formatTask(task)} — ${document.date} (\`${document.worklogId}\`, ${sourceLabel(task.source)})`,
        );
      }
      lines.push('');
    }

    lines.push('## Work in progress', '');
    const wip = documents.flatMap((document) =>
      document.workInProgress.map((task) => ({ document, task })),
    );
    if (!wip.length) {
      lines.push('_No work in progress was recorded._', '');
    } else {
      for (const { document, task } of wip) {
        lines.push(
          `- ${formatTask(task)} — ${document.date} (\`${document.worklogId}\`, ${sourceLabel(task.source)})`,
        );
      }
      lines.push('');
    }

    lines.push('## Blockers and risks', '');
    const blockers = documents.flatMap((document) =>
      document.blockers.map((blocker) => ({ document, blocker })),
    );
    if (!blockers.length) {
      lines.push('_No blockers or risks were recorded._', '');
    } else {
      for (const { document, blocker } of blockers) {
        const extra = [
          blocker.impact ? `Impact: ${blocker.impact}` : '',
          blocker.mitigation ? `Mitigation: ${blocker.mitigation}` : '',
        ]
          .filter(Boolean)
          .join('; ');
        lines.push(
          `- ${blocker.description}${extra ? ` — ${extra}` : ''}${blocker.evidenceIds.length ? ` _(evidence: ${blocker.evidenceIds.join(', ')})_` : ''} — ${document.date} (\`${document.worklogId}\`, ${sourceLabel(blocker.source)})`,
        );
      }
      lines.push('');
    }

    lines.push('## Decisions', '');
    const decisions = documents.flatMap((document) =>
      document.decisions.map((decision) => ({ document, decision })),
    );
    if (!decisions.length) {
      lines.push('_No decisions were recorded._', '');
    } else {
      for (const { document, decision } of decisions) {
        lines.push(
          `- ${decision.decision}${decision.rationale ? ` — ${decision.rationale}` : ''}${decision.evidenceIds.length ? ` _(evidence: ${decision.evidenceIds.join(', ')})_` : ''} — ${document.date} (\`${document.worklogId}\`, ${sourceLabel(decision.source)})`,
        );
      }
      lines.push('');
    }

    lines.push('## Next actions', '');
    const actions = documents.flatMap((document) =>
      document.nextActions.map((action) => ({ document, action })),
    );
    if (!actions.length) {
      lines.push('_No next actions were recorded._', '');
    } else {
      for (const { document, action } of actions) {
        const metadata = [
          action.owner ? `Owner: ${action.owner}` : '',
          action.dueDate ? `Due: ${action.dueDate}` : '',
        ]
          .filter(Boolean)
          .join('; ');
        lines.push(
          `- ${action.action}${metadata ? ` (${metadata})` : ''}${action.evidenceIds.length ? ` _(evidence: ${action.evidenceIds.join(', ')})_` : ''} — ${document.date} (\`${document.worklogId}\`, ${sourceLabel(action.source)})`,
        );
      }
      lines.push('');
    }

    lines.push('## Evidence and source references', '');
    const evidence = documents.flatMap((document) =>
      document.evidence.map((item) => ({ document, item })),
    );
    if (!evidence.length) {
      lines.push('_No evidence or source references were recorded._', '');
    } else {
      for (const { document, item } of evidence) {
        lines.push(
          `- [${item.verified ? 'verified' : 'reported'}] **${item.id}** (${item.kind}): ${item.reference}${item.description ? ` — ${item.description}` : ''} — ${document.date} (\`${document.worklogId}\`)`,
        );
      }
      lines.push('');
    }

    lines.push('## Work log index and synchronization status', '');
    for (const document of documents) {
      const remote = document.sync.memoId
        ? `memo ${document.sync.memoId} in calendar ${document.sync.calendarId ?? 'unknown'}`
        : 'no recorded remote memo';
      lines.push(
        `- ${document.date}: \`${document.worklogId}\`, revision ${document.revision}, sync ${document.sync.state}, ${remote}`,
      );
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  refreshMarkdown(worklogId: string): WorklogDocument {
    const document = this.ledger.getById(worklogId);
    if (!document) throw new AppError('WORKLOG_NOT_FOUND', `Unknown work log ${worklogId}`);
    const metadata: MarkdownMetadata = {
      revision: document.revision,
      createdAt: document.createdAt,
      updatedAt: nowIso(),
      sync: document.sync,
    };
    const markdown = renderWorklogMarkdown(document, metadata);
    writeAtomic(document.markdownPath, markdown);
    this.ledger.addEvent(worklogId, 'markdown.refreshed', {
      state: document.sync.state,
    });
    return { ...document, markdown };
  }

  archivePathFor(worklog: NormalizedWorklog): string {
    return archivePath(this.config.archiveDir, worklog);
  }

  remotePayloadFor(document: WorklogDocument): RemotePayload {
    return renderRemoteNote(document, document.revision, this.config.remoteMaxChars);
  }

  previewHashFor(document: WorklogDocument): string {
    const remote = this.remotePayloadFor(document);
    return previewHashOf(document.contentHash, remote.noteHash);
  }

  secretWarningsFor(document: WorklogDocument): SecretWarning[] {
    return findSecretWarnings(document);
  }
}
