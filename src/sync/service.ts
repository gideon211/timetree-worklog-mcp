import type { AppConfig } from '../config.js';
import { isRemoteConfigured } from '../config.js';
import { AppError } from '../errors.js';
import { attemptId as newAttemptId, requestFingerprint } from '../ids.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { nowIso } from '../time.js';
import type { Ledger, SyncAttempt } from '../store/ledger.js';
import type { TimeTreeProvider, ProviderMemo } from '../providers/timetree/provider.js';
import { ProviderError } from '../providers/timetree/provider.js';
import type { SyncState, WorklogDocument } from '../worklog/schema.js';
import { findSecretWarnings } from '../worklog/validate.js';
import type { WorklogService } from '../worklog/service.js';

export interface PublishInput {
  worklogId: string;
  previewHash: string;
  confirmation: 'PUBLISH';
  calendarId?: string;
}

export interface PublishResult {
  worklogId: string;
  state: SyncState;
  verified: boolean;
  alreadyPublished: boolean;
  calendarId: string;
  memoId?: string;
  remoteTitle?: string;
  attemptIds: string[];
  warnings: string[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    outcome?: string;
  };
}

export interface ReconcileResult {
  worklogId: string;
  state: SyncState;
  verified: boolean;
  found: boolean;
  memoId?: string;
  remoteHash?: string;
  message?: string;
}

export interface SyncStatusInput {
  worklogId?: string;
  date?: string;
  timezone?: string;
}

export interface SyncStatusResult {
  worklog?: {
    worklogId: string;
    date: string;
    timezone: string;
    revision: number;
    contentHash: string;
    markdownPath: string;
    sync: WorklogDocument['sync'];
    previewHash: string;
  };
  attempts?: Array<Record<string, unknown>>;
  summary: {
    counts: Record<string, number>;
    pending: number;
    writesEnabled: boolean;
    provider: string;
    calendarConfigured: boolean;
    credentialsConfigured: boolean;
    health: { status: string; message?: string };
  };
}

export interface RetryPendingInput {
  worklogId?: string;
  dryRun?: boolean;
  confirmation?: 'RETRY';
}

export interface RetryResult {
  worklogId: string;
  action:
    | 'would_publish'
    | 'published'
    | 'already_published'
    | 'conflict'
    | 'uncertain'
    | 'failed'
    | 'not_retryable'
    | 'reconcile_failed'
    | 'unchanged';
  state: SyncState;
  memoId?: string;
  message?: string;
  error?: string;
}

export interface RetryPendingResult {
  dryRun: boolean;
  pendingCount: number;
  results: RetryResult[];
}

function extractField(note: string, field: string): string | undefined {
  const match = note.match(new RegExp(`^${field}:\\s*(\\S+)\\s*$`, 'm'));
  return match?.[1];
}

function memoMatches(memo: ProviderMemo, worklogId: string): boolean {
  const declared = extractField(memo.note, 'Worklog-ID');
  return declared === worklogId || memo.title.includes(`[${worklogId}]`);
}

function memoHash(memo: ProviderMemo): string | undefined {
  return extractField(memo.note, 'Worklog-Hash');
}

export class SyncService {
  private readonly config: AppConfig;
  private readonly ledger: Ledger;
  private readonly provider: TimeTreeProvider;
  private readonly worklogs: WorklogService;
  private readonly logger: Logger;

  constructor(
    config: AppConfig,
    ledger: Ledger,
    provider: TimeTreeProvider,
    worklogs: WorklogService,
    logger: Logger = defaultLogger,
  ) {
    this.config = config;
    this.ledger = ledger;
    this.provider = provider;
    this.worklogs = worklogs;
    this.logger = logger;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    this.assertWritesEnabled();
    const calendarId = this.calendarId(input.calendarId);
    if (input.confirmation !== 'PUBLISH') {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'Publication requires confirmation: "PUBLISH". This is a deliberate remote write.',
      );
    }
    const document = this.worklogs.resolve({ worklogId: input.worklogId });

    const expectedPreview = this.worklogs.previewHashFor(document);
    if (input.previewHash !== expectedPreview) {
      throw new AppError(
        'PREVIEW_REQUIRED',
        'The preview hash does not match the saved work log. Run preview_daily_worklog again and inspect the current revision before publishing.',
        {
          details: {
            expectedPreviewHash: expectedPreview,
            suppliedPreviewHash: input.previewHash,
            localRevision: document.revision,
          },
        },
      );
    }

    const secretWarnings = findSecretWarnings(document);
    if (secretWarnings.length) {
      throw new AppError(
        'SECRETS_DETECTED',
        'Publication is blocked because the work log contains strings that look like credentials or secrets. Remove or redact them, save again, preview, and retry.',
        {
          details: {
            warnings: secretWarnings.map((warning) => ({
              label: warning.label,
              location: warning.location,
            })),
          },
        },
      );
    }

    this.assertReadReady();
    this.assertCalendarAccessible(await this.provider.listCalendars(), calendarId);

    let reconciliation: ReconcileResult;
    try {
      reconciliation = await this.reconcile(input.worklogId, calendarId);
    } catch (error) {
      const providerError = this.asProviderError(error);
      this.ledger.updateSync(input.worklogId, {
        state: 'UNCERTAIN',
        calendarId,
        lastErrorCode: providerError.code,
        lastErrorMessage: 'Reconciliation before publication failed; no create was attempted.',
      });
      this.refresh(input.worklogId);
      return {
        worklogId: input.worklogId,
        state: 'UNCERTAIN',
        verified: false,
        alreadyPublished: false,
        calendarId,
        attemptIds: [],
        warnings: [
          'No create was attempted because the pre-write reconciliation could not complete.',
        ],
        error: {
          code: providerError.code,
          message: providerError.message,
          retryable: providerError.retryable,
          outcome: providerError.outcome,
        },
      };
    }

    if (reconciliation.state === 'PUBLISHED') {
      return {
        worklogId: input.worklogId,
        state: 'PUBLISHED',
        verified: true,
        alreadyPublished: true,
        calendarId,
        ...(reconciliation.memoId ? { memoId: reconciliation.memoId } : {}),
        attemptIds: [],
        warnings: [
          'The worklog was already published and the remote memo hash matches the local content.',
        ],
      };
    }
    if (reconciliation.state === 'CONFLICT') {
      return {
        worklogId: input.worklogId,
        state: 'CONFLICT',
        verified: false,
        alreadyPublished: false,
        calendarId,
        ...(reconciliation.memoId ? { memoId: reconciliation.memoId } : {}),
        attemptIds: [],
        warnings: [
          reconciliation.message ??
            'A remote memo with this worklog ID exists but does not match the local content.',
        ],
        error: {
          code: 'SYNC_CONFLICT',
          message: 'A remote memo exists with different content. No duplicate was created.',
          retryable: false,
        },
      };
    }

    if (document.sync.state === 'CONFLICT' && reconciliation.state === 'NOT_PUBLISHED') {
      return {
        worklogId: input.worklogId,
        state: 'NOT_PUBLISHED',
        verified: false,
        alreadyPublished: false,
        calendarId,
        attemptIds: [],
        warnings: [
          'The prior conflict is cleared because no matching memo was found. Inspect the configured calendar, then call publish_worklog again if a new memo is intended.',
        ],
      };
    }

    const remote = this.worklogs.remotePayloadFor(document);
    const attempt: SyncAttempt = {
      attemptId: newAttemptId(),
      worklogId: input.worklogId,
      operation: 'create_memo',
      state: 'IN_FLIGHT',
      requestFingerprint: requestFingerprint({ title: remote.title, note: remote.note }),
      startedAt: nowIso(),
    };
    this.ledger.recordAttempt(attempt);
    this.ledger.updateSync(input.worklogId, {
      state: 'PUBLISHING',
      calendarId,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    this.refresh(input.worklogId);

    let created: ProviderMemo;
    try {
      created = await this.provider.createMemo(calendarId, {
        title: remote.title,
        note: remote.note,
        date: document.date,
      });
    } catch (error) {
      const providerError = this.asProviderError(error, 'UNKNOWN');
      const state: SyncState =
        providerError.outcome === 'UNKNOWN' || providerError.outcome === 'APPLIED'
          ? 'UNCERTAIN'
          : providerError.retryable
            ? 'FAILED_RETRYABLE'
            : 'FAILED_PERMANENT';
      this.ledger.finishAttempt(attempt.attemptId, state, {
        errorCode: providerError.code,
        errorMessage: providerError.message,
      });
      this.ledger.updateSync(input.worklogId, {
        state,
        calendarId,
        lastErrorCode: providerError.code,
        lastErrorMessage: providerError.message,
      });
      this.refresh(input.worklogId);
      return {
        worklogId: input.worklogId,
        state,
        verified: false,
        alreadyPublished: false,
        calendarId,
        attemptIds: [attempt.attemptId],
        warnings: [
          providerError.outcome === 'UNKNOWN'
            ? 'The write outcome is unknown. Do not retry blindly; run retry_pending_sync in dry-run mode to reconcile first.'
            : 'The remote create did not succeed.',
        ],
        error: {
          code: providerError.code,
          message: providerError.message,
          retryable: providerError.retryable,
          outcome: providerError.outcome,
        },
      };
    }

    let verifiedMemo: ProviderMemo | undefined;
    let verificationError: string | undefined;
    try {
      const fetched = await this.provider.getMemo(calendarId, created.id);
      const remoteHash = memoHash(fetched);
      const idMatches = memoMatches(fetched, input.worklogId);
      if (idMatches && remoteHash === document.contentHash) {
        verifiedMemo = fetched;
      } else {
        verificationError =
          'The created memo could not be verified: its worklog ID or content hash did not match.';
      }
    } catch (error) {
      verificationError = `The created memo could not be read back for verification: ${this.asProviderError(error).message}`;
    }

    if (verifiedMemo) {
      const verifiedAt = nowIso();
      this.ledger.finishAttempt(attempt.attemptId, 'PUBLISHED', { memoId: verifiedMemo.id });
      this.ledger.updateSync(input.worklogId, {
        state: 'PUBLISHED',
        calendarId,
        memoId: verifiedMemo.id,
        remoteTitle: verifiedMemo.title,
        remoteHash: document.contentHash,
        publishedAt: verifiedAt,
        verifiedAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      this.ledger.upsertRemoteMemo({
        calendarId,
        memoId: verifiedMemo.id,
        worklogId: input.worklogId,
        title: verifiedMemo.title,
        contentHash: document.contentHash,
        ...(verifiedMemo.updatedAt ? { remoteUpdatedAt: verifiedMemo.updatedAt } : {}),
      });
      const warnings = this.refresh(input.worklogId);
      return {
        worklogId: input.worklogId,
        state: 'PUBLISHED',
        verified: true,
        alreadyPublished: false,
        calendarId,
        memoId: verifiedMemo.id,
        remoteTitle: verifiedMemo.title,
        attemptIds: [attempt.attemptId],
        warnings,
      };
    }

    const unreconciledHash = memoHash(created);
    this.ledger.finishAttempt(attempt.attemptId, 'UNCERTAIN', {
      memoId: created.id,
      errorCode: 'SYNC_UNCERTAIN',
      errorMessage: verificationError,
    });
    this.ledger.updateSync(input.worklogId, {
      state: 'UNCERTAIN',
      calendarId,
      memoId: created.id,
      remoteTitle: created.title,
      remoteHash: unreconciledHash ?? null,
      lastErrorCode: 'SYNC_UNCERTAIN',
      lastErrorMessage: verificationError ?? 'Remote write could not be verified.',
    });
    this.refresh(input.worklogId);
    return {
      worklogId: input.worklogId,
      state: 'UNCERTAIN',
      verified: false,
      alreadyPublished: false,
      calendarId,
      memoId: created.id,
      remoteTitle: created.title,
      attemptIds: [attempt.attemptId],
      warnings: [
        'A memo was created but could not be verified. Do not create it again; run retry_pending_sync in dry-run mode to reconcile.',
      ],
      error: {
        code: 'SYNC_UNCERTAIN',
        message: verificationError ?? 'Remote write could not be verified.',
        retryable: true,
      },
    };
  }

  async reconcile(worklogId: string, calendarIdInput?: string): Promise<ReconcileResult> {
    const calendarId = this.calendarId(calendarIdInput);
    this.assertReadReady();
    const document = this.worklogs.resolve({ worklogId });
    let memos: ProviderMemo[];
    try {
      memos = await this.provider.listMemos(calendarId);
    } catch (error) {
      const providerError = this.asProviderError(error);
      this.logger.warn('Remote memo reconciliation failed', {
        worklogId,
        code: providerError.code,
      });
      throw providerError;
    }

    const found = memos.find((memo) => memoMatches(memo, worklogId));
    if (found) {
      const remoteHash = memoHash(found);
      if (remoteHash === document.contentHash) {
        this.ledger.upsertRemoteMemo({
          calendarId,
          memoId: found.id,
          worklogId,
          title: found.title,
          ...(remoteHash ? { contentHash: remoteHash } : {}),
          ...(found.updatedAt ? { remoteUpdatedAt: found.updatedAt } : {}),
        });
        this.ledger.updateSync(worklogId, {
          state: 'PUBLISHED',
          calendarId,
          memoId: found.id,
          remoteTitle: found.title,
          remoteHash,
          publishedAt: document.sync.publishedAt ?? nowIso(),
          verifiedAt: nowIso(),
          lastErrorCode: null,
          lastErrorMessage: null,
        });
        this.refresh(worklogId);
        return {
          worklogId,
          state: 'PUBLISHED',
          verified: true,
          found: true,
          memoId: found.id,
          remoteHash,
        };
      }
      this.ledger.updateSync(worklogId, {
        state: 'CONFLICT',
        calendarId,
        memoId: found.id,
        remoteTitle: found.title,
        remoteHash: remoteHash ?? null,
        lastErrorCode: 'SYNC_CONFLICT',
        lastErrorMessage:
          'A remote memo with this worklog ID exists but its content hash does not match the local work log.',
      });
      this.refresh(worklogId);
      return {
        worklogId,
        state: 'CONFLICT',
        verified: false,
        found: true,
        memoId: found.id,
        ...(remoteHash ? { remoteHash } : {}),
        message:
          'A remote memo with this worklog ID exists with different content. No duplicate was created; resolve the conflict manually.',
      };
    }

    const prior = document.sync.state;
    const previouslyHadMemo = Boolean(document.sync.memoId);
    let nextState: SyncState;
    if (prior === 'CONFLICT') {
      nextState = 'NOT_PUBLISHED';
    } else if (prior === 'PUBLISHED' || prior === 'STALE' || previouslyHadMemo) {
      nextState = 'CONFLICT';
    } else if (prior === 'FAILED_RETRYABLE' || prior === 'FAILED_PERMANENT') {
      nextState = prior;
    } else {
      nextState = 'NOT_PUBLISHED';
    }

    this.ledger.updateSync(worklogId, {
      state: nextState,
      calendarId,
      memoId: null,
      remoteTitle: null,
      remoteHash: null,
      ...(nextState === 'NOT_PUBLISHED' ? { lastErrorCode: null, lastErrorMessage: null } : {}),
      ...(nextState === 'CONFLICT'
        ? {
            lastErrorCode: 'SYNC_CONFLICT',
            lastErrorMessage:
              'The work log previously had a recorded memo, but no matching memo was found in the configured calendar.',
          }
        : {}),
    });
    this.refresh(worklogId);
    return {
      worklogId,
      state: nextState,
      verified: false,
      found: false,
      ...(nextState === 'CONFLICT'
        ? {
            message:
              'The previously recorded memo was not found. The state is now CONFLICT; do not republish without checking the calendar.',
          }
        : {}),
    };
  }

  async getStatus(input: SyncStatusInput = {}): Promise<SyncStatusResult> {
    const counts = this.ledger.countByState();
    const countsWithDefaults: Record<string, number> = {
      NOT_PUBLISHED: 0,
      PUBLISHING: 0,
      PUBLISHED: 0,
      FAILED_RETRYABLE: 0,
      FAILED_PERMANENT: 0,
      UNCERTAIN: 0,
      STALE: 0,
      CONFLICT: 0,
      BLOCKED: 0,
      ...counts,
    };
    const pending =
      countsWithDefaults.PUBLISHING! +
      countsWithDefaults.UNCERTAIN! +
      countsWithDefaults.FAILED_RETRYABLE! +
      countsWithDefaults.STALE! +
      countsWithDefaults.CONFLICT!;
    const health = await this.provider.health();
    const summary: SyncStatusResult['summary'] = {
      counts: countsWithDefaults,
      pending,
      writesEnabled: this.config.remoteWritesEnabled,
      provider: this.provider.name,
      calendarConfigured: Boolean(this.config.calendarId),
      credentialsConfigured: Boolean(this.config.timetreeEmail && this.config.timetreePassword),
      health,
    };

    if (!input.worklogId && !input.date) {
      return { summary };
    }

    const document = this.worklogs.resolve(input);
    const attempts = this.ledger.getAttempts(document.worklogId).map((attempt) => ({
      attemptId: attempt.attempt_id,
      operation: attempt.operation,
      state: attempt.state,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      errorCode: attempt.error_code,
      errorMessage: attempt.error_message,
      memoId: attempt.memo_id,
    }));
    return {
      worklog: {
        worklogId: document.worklogId,
        date: document.date,
        timezone: document.timezone,
        revision: document.revision,
        contentHash: document.contentHash,
        markdownPath: document.markdownPath,
        sync: document.sync,
        previewHash: this.worklogs.previewHashFor(document),
      },
      attempts,
      summary,
    };
  }

  async retryPending(input: RetryPendingInput = {}): Promise<RetryPendingResult> {
    const dryRun = input.dryRun ?? true;
    if (!dryRun) {
      this.assertWritesEnabled();
      if (input.confirmation !== 'RETRY') {
        throw new AppError(
          'CONFIRMATION_REQUIRED',
          'Live retries require confirmation: "RETRY". Use dryRun: true to inspect first.',
        );
      }
    }
    this.assertReadReady();
    const pending = input.worklogId
      ? [this.worklogs.resolve({ worklogId: input.worklogId })]
      : this.ledger.listPending();
    if (!dryRun && pending.length > 10) {
      throw new AppError(
        'INVALID_INPUT',
        'Live retry is limited to 10 work logs per call. Retry a specific worklogId.',
      );
    }

    const results: RetryResult[] = [];
    for (const document of pending) {
      if (document.sync.state === 'CONFLICT') {
        results.push({
          worklogId: document.worklogId,
          action: 'conflict',
          state: document.sync.state,
          ...(document.sync.memoId ? { memoId: document.sync.memoId } : {}),
          message: 'Manual conflict resolution is required; no write was attempted.',
        });
        continue;
      }
      if (document.sync.state === 'FAILED_PERMANENT') {
        results.push({
          worklogId: document.worklogId,
          action: 'not_retryable',
          state: document.sync.state,
          message:
            'This state is not retried automatically. Fix the cause, then use an explicit publish_worklog with a matching preview or save a new revision.',
        });
        continue;
      }
      if (document.sync.state === 'BLOCKED') {
        results.push({
          worklogId: document.worklogId,
          action: 'not_retryable',
          state: document.sync.state,
          message: 'This work log is blocked by an operator; no retry was attempted.',
        });
        continue;
      }

      let reconciled: ReconcileResult;
      try {
        reconciled = await this.reconcile(document.worklogId);
      } catch (error) {
        const providerError = this.asProviderError(error);
        results.push({
          worklogId: document.worklogId,
          action: 'reconcile_failed',
          state: document.sync.state,
          error: `${providerError.code}: ${providerError.message}`,
          message: 'Reconciliation failed; nothing was written.',
        });
        continue;
      }

      if (reconciled.state === 'PUBLISHED') {
        results.push({
          worklogId: document.worklogId,
          action: 'already_published',
          state: 'PUBLISHED',
          ...(reconciled.memoId ? { memoId: reconciled.memoId } : {}),
          message: 'Remote memo verified; no duplicate was created.',
        });
        continue;
      }
      if (reconciled.state === 'CONFLICT') {
        results.push({
          worklogId: document.worklogId,
          action: 'conflict',
          state: 'CONFLICT',
          ...(reconciled.memoId ? { memoId: reconciled.memoId } : {}),
          message: reconciled.message ?? 'A remote memo exists with different content.',
        });
        continue;
      }

      if (dryRun) {
        results.push({
          worklogId: document.worklogId,
          action: 'would_publish',
          state: reconciled.state,
          message: 'No remote memo was found for this work log. A live retry would create one.',
        });
        continue;
      }

      const current = this.worklogs.resolve({ worklogId: document.worklogId });
      let published: PublishResult;
      try {
        published = await this.publish({
          worklogId: document.worklogId,
          previewHash: this.worklogs.previewHashFor(current),
          confirmation: 'PUBLISH',
          ...(this.config.calendarId ? { calendarId: this.config.calendarId } : {}),
        });
      } catch (error) {
        const code =
          error instanceof AppError
            ? error.code
            : error instanceof ProviderError
              ? error.code
              : 'RETRY_FAILED';
        const message = error instanceof Error ? error.message : String(error);
        let state = current.sync.state;
        try {
          state = this.worklogs.resolve({ worklogId: document.worklogId }).sync.state;
        } catch {
          // Keep the state from before the failed attempt if the local record vanished.
        }
        results.push({
          worklogId: document.worklogId,
          action: 'failed',
          state,
          error: `${code}: ${message}`,
          message:
            'The work log could not be published; other pending work logs were still processed.',
        });
        continue;
      }
      const action =
        published.state === 'PUBLISHED'
          ? 'published'
          : published.state === 'CONFLICT'
            ? 'conflict'
            : published.state === 'UNCERTAIN'
              ? 'uncertain'
              : 'failed';
      results.push({
        worklogId: document.worklogId,
        action,
        state: published.state,
        ...(published.memoId ? { memoId: published.memoId } : {}),
        ...(published.error ? { error: published.error.message } : {}),
        message: published.verified
          ? 'Remote memo created and verified.'
          : 'Remote write did not reach a verified published state.',
      });
    }

    return {
      dryRun,
      pendingCount: pending.length,
      results,
    };
  }

  private assertWritesEnabled(): void {
    if (!this.config.remoteWritesEnabled) {
      throw new AppError(
        'REMOTE_WRITES_DISABLED',
        'Remote writes are disabled. Set TIMETREE_ENABLE_REMOTE_WRITES=true only after reviewing the README and providing explicit operator authorization.',
      );
    }
  }

  private assertReadReady(): void {
    if (this.config.provider === 'community' && !isRemoteConfigured(this.config)) {
      throw new AppError(
        'TIMETREE_NOT_CONFIGURED',
        'TimeTree is not fully configured. TIMETREE_EMAIL, TIMETREE_PASSWORD and TIMETREE_CALENDAR_ID are required.',
      );
    }
    if (!this.config.calendarId) {
      throw new AppError('TIMETREE_NOT_CONFIGURED', 'TIMETREE_CALENDAR_ID is required.');
    }
  }

  private calendarId(requested: string | undefined): string {
    const configured = this.config.calendarId;
    if (!configured) {
      throw new AppError('TIMETREE_NOT_CONFIGURED', 'TIMETREE_CALENDAR_ID is required.');
    }
    if (requested && requested !== configured) {
      throw new AppError(
        'TIMETREE_CALENDAR_MISMATCH',
        'Only the single configured private calendar may be used. The requested calendar does not match TIMETREE_CALENDAR_ID.',
        { details: { configuredCalendarId: configured } },
      );
    }
    return configured;
  }

  private assertCalendarAccessible(
    calendars: Array<{ id: string; writable: boolean; name: string }>,
    calendarId: string,
  ): void {
    const calendar = calendars.find((candidate) => candidate.id === calendarId);
    if (!calendar) {
      throw new AppError(
        'TIMETREE_CALENDAR_NOT_FOUND',
        'The configured TimeTree calendar was not found for this account.',
        { details: { calendarId } },
      );
    }
    if (!calendar.writable) {
      throw new AppError(
        'TIMETREE_PERMISSION_DENIED',
        'The configured TimeTree calendar is not writable by this account.',
        { details: { calendarId } },
      );
    }
  }

  private refresh(worklogId: string): string[] {
    try {
      this.worklogs.refreshMarkdown(worklogId);
      return [];
    } catch (error) {
      this.logger.error('Could not refresh the local Markdown sync metadata', {
        worklogId,
        error,
      });
      return [
        'Synchronization state changed, but the local Markdown front matter could not be refreshed.',
      ];
    }
  }

  private asProviderError(
    error: unknown,
    fallbackOutcome: 'NOT_APPLIED' | 'UNKNOWN' = 'NOT_APPLIED',
  ): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof AppError) {
      return new ProviderError('UNSUPPORTED', error.message, {
        retryable: error.retryable,
        outcome: fallbackOutcome,
      });
    }
    if (error instanceof Error) {
      return new ProviderError('NETWORK_ERROR', error.message, {
        retryable: true,
        outcome: fallbackOutcome,
      });
    }
    return new ProviderError('NETWORK_ERROR', String(error), {
      retryable: true,
      outcome: fallbackOutcome,
    });
  }
}
