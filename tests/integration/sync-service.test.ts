import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { AppError } from '../../src/errors.js';
import { extractFrontMatter } from '../../src/worklog/markdown.js';
import { baseInput, makeHarness, saveAndPreview, type Harness } from '../helpers.js';

const harnesses: Harness[] = [];

function harness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const created = makeHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  while (harnesses.length) {
    harnesses.pop()?.close();
  }
});

async function publishSaved(h: Harness, input = baseInput()) {
  const { saved } = saveAndPreview(h, input);
  const result = await h.sync.publish({
    worklogId: saved.document.worklogId,
    previewHash: h.worklogs.previewHashFor(saved.document),
    confirmation: 'PUBLISH',
  });
  return { saved, result };
}

describe('sync service', () => {
  it('refuses remote writes when they are disabled', async () => {
    const h = harness({ writesEnabled: false });
    const { saved } = saveAndPreview(h);
    await expect(
      h.sync.publish({
        worklogId: saved.document.worklogId,
        previewHash: h.worklogs.previewHashFor(saved.document),
        confirmation: 'PUBLISH',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_WRITES_DISABLED' });
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('requires the exact PUBLISH confirmation', async () => {
    const h = harness();
    const { saved } = saveAndPreview(h);
    await expect(
      h.sync.publish({
        worklogId: saved.document.worklogId,
        previewHash: h.worklogs.previewHashFor(saved.document),
        confirmation: 'yes' as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('requires a matching preview hash', async () => {
    const h = harness();
    const { saved } = saveAndPreview(h);
    await expect(
      h.sync.publish({
        worklogId: saved.document.worklogId,
        previewHash: '0'.repeat(64),
        confirmation: 'PUBLISH',
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' });
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('rejects a calendar other than the configured private calendar', async () => {
    const h = harness();
    const { saved } = saveAndPreview(h);
    await expect(
      h.sync.publish({
        worklogId: saved.document.worklogId,
        previewHash: h.worklogs.previewHashFor(saved.document),
        confirmation: 'PUBLISH',
        calendarId: 'another-calendar',
      }),
    ).rejects.toMatchObject({ code: 'TIMETREE_CALENDAR_MISMATCH' });
  });

  it('blocks suspected secret material before any remote write', async () => {
    const h = harness();
    const token = `github_pat_${'b'.repeat(30)}`;
    const { saved } = saveAndPreview(h, baseInput({ executiveSummary: `Do not publish ${token}` }));
    await expect(
      h.sync.publish({
        worklogId: saved.document.worklogId,
        previewHash: h.worklogs.previewHashFor(saved.document),
        confirmation: 'PUBLISH',
      }),
    ).rejects.toMatchObject({ code: 'SECRETS_DETECTED' });
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
    expect(JSON.stringify(h.provider.memosFor('cal_worklog'))).not.toContain(token);
  });

  it('publishes once and verifies the memo by reading it back', async () => {
    const h = harness();
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('PUBLISHED');
    expect(result.verified).toBe(true);
    expect(result.memoId).toBeTruthy();
    const memos = h.provider.memosFor('cal_worklog');
    expect(memos).toHaveLength(1);
    expect(memos[0]?.note).toContain(`Worklog-ID: ${saved.document.worklogId}`);
    expect(memos[0]?.note).toContain(`Worklog-Hash: ${saved.document.contentHash}`);
    expect(h.ledger.getById(saved.document.worklogId)?.sync.state).toBe('PUBLISHED');
    const parsed = extractFrontMatter(readFileSync(saved.document.markdownPath, 'utf8'));
    expect((parsed.frontMatter.sync as { state: string }).state).toBe('PUBLISHED');
  });

  it('does not create a duplicate when the same saved worklog is published again', async () => {
    const h = harness();
    const { saved, result: first } = await publishSaved(h);
    const second = await h.sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: h.worklogs.previewHashFor(
        h.worklogs.resolve({ worklogId: saved.document.worklogId }),
      ),
      confirmation: 'PUBLISH',
    });
    expect(first.state).toBe('PUBLISHED');
    expect(second.state).toBe('PUBLISHED');
    expect(second.alreadyPublished).toBe(true);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('leaves an uncertain pre-write timeout safe to retry', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'TIMEOUT',
          outcome: 'UNKNOWN',
          retryable: true,
          message: 'Mock timeout before apply',
        },
      ],
    });
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('UNCERTAIN');
    expect(result.verified).toBe(false);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
    expect(existsSync(saved.document.markdownPath)).toBe(true);

    const dry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(dry.dryRun).toBe(true);
    expect(dry.results[0]?.action).toBe('would_publish');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);

    const live = await h.sync.retryPending({
      worklogId: saved.document.worklogId,
      dryRun: false,
      confirmation: 'RETRY',
    });
    expect(live.results[0]?.action).toBe('published');
    expect(live.results[0]?.state).toBe('PUBLISHED');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('treats an unrecognized create error as an uncertain outcome', async () => {
    const h = harness();
    h.provider.createMemo = async () => {
      throw new Error('socket closed after the request was sent');
    };
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('UNCERTAIN');
    expect(result.verified).toBe(false);
    expect(result.error?.outcome).toBe('UNKNOWN');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
    expect(h.ledger.findRemoteMemo('cal_worklog', saved.document.worklogId)).toBeUndefined();
  });

  it('reconciles an uncertain post-write timeout before any retry', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'TIMEOUT',
          outcome: 'UNKNOWN',
          retryable: true,
          applyBeforeThrow: true,
          message: 'Mock timeout after apply',
        },
      ],
    });
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('UNCERTAIN');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
    expect(h.ledger.findRemoteMemo('cal_worklog', saved.document.worklogId)).toBeUndefined();

    const dry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(dry.results[0]?.action).toBe('already_published');
    expect(dry.results[0]?.state).toBe('PUBLISHED');
    expect(h.ledger.findRemoteMemo('cal_worklog', saved.document.worklogId)?.memoId).toBeTruthy();
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);

    const live = await h.sync.retryPending({
      worklogId: saved.document.worklogId,
      dryRun: false,
      confirmation: 'RETRY',
    });
    expect(live.results[0]?.action).toBe('already_published');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('stays uncertain when read-back verification fails and reconciles instead of duplicating', async () => {
    const h = harness({
      failures: [
        {
          operation: 'getMemo',
          code: 'NETWORK_ERROR',
          outcome: 'NOT_APPLIED',
          retryable: true,
          message: 'Mock read-back failure',
        },
      ],
    });
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('UNCERTAIN');
    expect(result.verified).toBe(false);
    expect(result.memoId).toBeTruthy();
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);

    const dry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(dry.results[0]?.action).toBe('already_published');
    expect(dry.results[0]?.state).toBe('PUBLISHED');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('handles a conflict without a duplicate and requires a second publish after clearing', async () => {
    const h = harness();
    const input = baseInput();
    const { saved } = saveAndPreview(h, input);
    h.provider.seedMemo({
      id: 'memo_conflict',
      calendarId: 'cal_worklog',
      title: `Work Log 2026-10-26 [${saved.document.worklogId}]`,
      note: `Worklog-ID: ${saved.document.worklogId}\nWorklog-Hash: ${'a'.repeat(64)}`,
      date: '2026-10-26',
    });
    const result = await h.sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: h.worklogs.previewHashFor(saved.document),
      confirmation: 'PUBLISH',
    });
    expect(result.state).toBe('CONFLICT');
    expect(result.verified).toBe(false);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
    expect(h.provider.calls.createMemo).toBe(0);

    h.provider.reset();
    const cleared = await h.sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: h.worklogs.previewHashFor(saved.document),
      confirmation: 'PUBLISH',
    });
    expect(cleared.state).toBe('NOT_PUBLISHED');
    expect(cleared.warnings.join(' ')).toMatch(/prior conflict is cleared/i);
    expect(h.provider.calls.createMemo).toBe(0);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);

    const recreated = await h.sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: h.worklogs.previewHashFor(
        h.worklogs.resolve({ worklogId: saved.document.worklogId }),
      ),
      confirmation: 'PUBLISH',
    });
    expect(recreated.state).toBe('PUBLISHED');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('records a rate-limit failure as retryable and a permission failure as permanent', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'RATE_LIMITED',
          outcome: 'NOT_APPLIED',
          retryable: true,
        },
        {
          operation: 'createMemo',
          code: 'AUTH_FAILED',
          outcome: 'NOT_APPLIED',
          retryable: false,
        },
      ],
    });
    const first = await publishSaved(h);
    expect(first.result.state).toBe('FAILED_RETRYABLE');

    const retry = await h.sync.retryPending({
      worklogId: first.saved.document.worklogId,
      dryRun: false,
      confirmation: 'RETRY',
    });
    expect(retry.results[0]?.state).toBe('FAILED_PERMANENT');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('allows an explicit publish to recover a permanent failure after the cause is fixed', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'AUTH_FAILED',
          outcome: 'NOT_APPLIED',
          retryable: false,
        },
      ],
    });
    const first = await publishSaved(h);
    expect(first.result.state).toBe('FAILED_PERMANENT');

    const skipped = await h.sync.retryPending({
      worklogId: first.saved.document.worklogId,
      dryRun: false,
      confirmation: 'RETRY',
    });
    expect(skipped.results[0]?.action).toBe('not_retryable');

    const recovered = await h.sync.publish({
      worklogId: first.saved.document.worklogId,
      previewHash: h.worklogs.previewHashFor(first.saved.document),
      confirmation: 'PUBLISH',
    });
    expect(recovered.state).toBe('PUBLISHED');
    expect(recovered.verified).toBe(true);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('reports a per-worklog publish failure instead of aborting the whole retry', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'RATE_LIMITED',
          outcome: 'NOT_APPLIED',
          retryable: true,
        },
      ],
    });
    const first = await publishSaved(h);
    expect(first.result.state).toBe('FAILED_RETRYABLE');
    h.provider.addFailure({
      operation: 'listCalendars',
      code: 'NETWORK_ERROR',
      outcome: 'NOT_APPLIED',
      retryable: true,
    });

    const retry = await h.sync.retryPending({
      worklogId: first.saved.document.worklogId,
      dryRun: false,
      confirmation: 'RETRY',
    });
    expect(retry.results).toHaveLength(1);
    expect(retry.results[0]?.action).toBe('failed');
    expect(retry.results[0]?.error).toContain('NETWORK_ERROR');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('does not attempt a create when reconciliation fails', async () => {
    const h = harness({
      failures: [
        {
          operation: 'listMemos',
          code: 'NETWORK_ERROR',
          outcome: 'NOT_APPLIED',
          retryable: true,
        },
      ],
    });
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('UNCERTAIN');
    expect(result.verified).toBe(false);
    expect(h.provider.calls.createMemo).toBe(0);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
    expect(existsSync(saved.document.markdownPath)).toBe(true);
  });

  it('does not expose a destructive retry for a permanent failure', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'VALIDATION_ERROR',
          outcome: 'NOT_APPLIED',
          retryable: false,
        },
      ],
    });
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('FAILED_PERMANENT');
    const retry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(retry.results[0]?.action).toBe('not_retryable');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('does not retry an operator-blocked worklog', async () => {
    const h = harness();
    const { saved } = saveAndPreview(h);
    h.ledger.updateSync(saved.document.worklogId, { state: 'BLOCKED' });

    const retry = await h.sync.retryPending({
      worklogId: saved.document.worklogId,
      dryRun: false,
      confirmation: 'RETRY',
    });
    expect(retry.results[0]?.action).toBe('not_retryable');
    expect(retry.results[0]?.state).toBe('BLOCKED');
    expect(h.provider.calls.listMemos).toBe(0);
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('reports aggregate and per-worklog status without writing', async () => {
    const h = harness();
    const empty = await h.sync.getStatus();
    expect(empty.summary.counts.NOT_PUBLISHED).toBe(0);
    expect(empty.summary.writesEnabled).toBe(true);
    expect(empty.summary.health.status).toBe('ok');

    const { saved } = await publishSaved(h);
    const status = await h.sync.getStatus({ worklogId: saved.document.worklogId });
    expect(status.worklog?.sync.state).toBe('PUBLISHED');
    expect(status.attempts?.[0]?.state).toBe('PUBLISHED');
    const summary = await h.sync.getStatus();
    expect(summary.summary.counts.PUBLISHED).toBe(1);
    expect(summary.summary.pending).toBe(0);
  });

  it('survives a process restart and still refuses to duplicate a published memo', async () => {
    const h = harness();
    const { saved } = await publishSaved(h);
    const reopened = h.reopen();
    harnesses.push(reopened);
    const status = await reopened.sync.getStatus({ worklogId: saved.document.worklogId });
    expect(status.worklog?.sync.state).toBe('PUBLISHED');
    const again = await reopened.sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: reopened.worklogs.previewHashFor(
        reopened.worklogs.resolve({ worklogId: saved.document.worklogId }),
      ),
      confirmation: 'PUBLISH',
    });
    expect(again.alreadyPublished).toBe(true);
    expect(reopened.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('marks a published worklog stale after an edit and refuses to create a second memo', async () => {
    const h = harness();
    await publishSaved(h);
    const changed = h.worklogs.save(
      baseInput({ executiveSummary: 'A corrected summary after publication.' }),
    );
    expect(changed.document.sync.state).toBe('STALE');
    expect(changed.warnings.join(' ')).toContain('prior remote publication');
    const result = await h.sync.publish({
      worklogId: changed.document.worklogId,
      previewHash: h.worklogs.previewHashFor(changed.document),
      confirmation: 'PUBLISH',
    });
    expect(result.state).toBe('CONFLICT');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(1);
  });

  it('will not silently republish a stale worklog whose memo disappeared', async () => {
    const h = harness();
    const { saved } = await publishSaved(h);
    h.worklogs.save(baseInput({ executiveSummary: 'A corrected summary after publication.' }));
    h.provider.reset();

    const reconciled = await h.sync.reconcile(saved.document.worklogId);
    expect(reconciled.state).toBe('CONFLICT');
    expect(reconciled.found).toBe(false);

    const dry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(dry.results[0]?.action).toBe('conflict');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('will not republish an uncertain create whose recorded memo has disappeared', async () => {
    const h = harness({
      failures: [
        {
          operation: 'getMemo',
          code: 'NETWORK_ERROR',
          outcome: 'NOT_APPLIED',
          retryable: true,
        },
      ],
    });
    const { saved, result } = await publishSaved(h);
    expect(result.state).toBe('UNCERTAIN');
    expect(result.memoId).toBeTruthy();
    h.provider.reset();

    const dry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(dry.results[0]?.action).toBe('conflict');
    expect(dry.results[0]?.state).toBe('CONFLICT');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('defaults retry to dry-run and requires RETRY for a live retry', async () => {
    const h = harness({
      failures: [
        {
          operation: 'createMemo',
          code: 'RATE_LIMITED',
          outcome: 'NOT_APPLIED',
          retryable: true,
        },
      ],
    });
    const { saved } = await publishSaved(h);
    await expect(
      h.sync.retryPending({ worklogId: saved.document.worklogId, dryRun: false }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const dry = await h.sync.retryPending({ worklogId: saved.document.worklogId });
    expect(dry.dryRun).toBe(true);
    expect(dry.results[0]?.action).toBe('would_publish');
    expect(h.provider.memosFor('cal_worklog')).toHaveLength(0);
  });

  it('keeps an AppError type for missing local worklogs', async () => {
    const h = harness();
    await expect(h.sync.getStatus({ worklogId: 'missing' })).rejects.toBeInstanceOf(AppError);
  });
});
