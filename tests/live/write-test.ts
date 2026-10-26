/**
 * Gated live TimeTree write test.
 *
 * This is the ONLY code path that creates a real memo on a live account. It is
 * excluded from `npm test` and runs only when TIMETREE_LIVE_WRITE=1 is set AND
 * the operator has explicitly authorized one throwaway write in a dedicated
 * private calendar. It creates exactly one memo, verifies it by reading it back,
 * confirms idempotent re-publication does not duplicate it, and prints only
 * summaries. It never prints credentials, session cookies, or note contents.
 *
 * Cleanup (manual, in the TimeTree app): delete the single test memo afterward.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTimeTreeAuth, loadConfig } from '../../src/config.js';
import { Logger } from '../../src/logger.js';
import { createTimeTreeProvider } from '../../src/providers/timetree/index.js';
import { ProviderError } from '../../src/providers/timetree/provider.js';
import { Ledger } from '../../src/store/ledger.js';
import { SyncService } from '../../src/sync/service.js';
import { WorklogService } from '../../src/worklog/service.js';
import type { WorklogInput } from '../../src/worklog/schema.js';

function out(message: string): void {
  process.stdout.write(message);
}
function err(message: string): void {
  process.stderr.write(message);
}
function describeError(error: unknown): string {
  if (error instanceof ProviderError) {
    return `${error.code}: ${error.message} (outcome=${error.outcome})`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// Clearly synthetic content. No real work data.
const TEST_DATE = '2026-10-26';
const syntheticInput: WorklogInput = {
  date: TEST_DATE,
  timezone: 'Africa/Accra',
  title: 'LIVE WRITE TEST — do not keep',
  executiveSummary:
    'Synthetic memo created by the gated live write test. Safe to delete. Verifies publication end-to-end.',
  completedTasks: [
    {
      description: 'Synthetic task confirming the create-and-read-back path',
      source: 'user',
      evidenceIds: [],
    },
  ],
  workInProgress: [],
  blockers: [],
  decisions: [
    {
      decision: 'This is a throwaway test memo and carries no real work data',
      rationale: 'Live publication is verified with synthetic content only',
      source: 'user',
      evidenceIds: [],
    },
  ],
  nextActions: [
    {
      action: 'Delete this memo manually in the TimeTree app after inspection',
      owner: 'operator',
      source: 'user',
      evidenceIds: [],
    },
  ],
  evidence: [],
};

async function main(): Promise<number> {
  if (process.env.TIMETREE_LIVE_WRITE !== '1') {
    out(
      'Live TimeTree WRITE test skipped.\n' +
        'Set TIMETREE_LIVE_WRITE=1 plus TIMETREE_SESSION_COOKIE (or EMAIL/PASSWORD) to opt in.\n' +
        'This creates exactly one throwaway memo and requires explicit operator authorization.\n',
    );
    return 0;
  }

  const dir = mkdtempSync(join(tmpdir(), 'timetree-worklog-live-write-'));
  const envKeys = [
    'WORKLOG_DATA_DIR',
    'WORKLOG_DB_PATH',
    'WORKLOG_ARCHIVE_DIR',
    'WORKLOG_REPORTS_DIR',
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of envKeys) previous.set(key, process.env[key]);
  process.env.WORKLOG_DATA_DIR = dir;
  process.env.WORKLOG_DB_PATH = join(dir, 'write.sqlite');
  process.env.WORKLOG_ARCHIVE_DIR = join(dir, 'worklogs');
  process.env.WORKLOG_REPORTS_DIR = join(dir, 'reports');
  process.env.TIMETREE_ENABLE_REMOTE_WRITES = 'true';

  let ledger: Ledger | undefined;
  try {
    const config = loadConfig();
    if (config.provider !== 'community') {
      err('Write test requires TIMETREE_PROVIDER=community.\n');
      return 2;
    }
    if (!hasTimeTreeAuth(config)) {
      err('Write test requires TIMETREE_SESSION_COOKIE or TIMETREE_EMAIL/TIMETREE_PASSWORD.\n');
      return 2;
    }

    const logger = new Logger({
      level: 'error',
      write: (line) => process.stderr.write(`${line}\n`),
    });
    const provider = createTimeTreeProvider(config, logger);

    // Discover the single calendar and use it. Print id + name so the operator can confirm target.
    const calendars = await provider.listCalendars();
    if (calendars.length !== 1 && !config.calendarId) {
      err(`Expected exactly one calendar, found ${calendars.length}. Set TIMETREE_CALENDAR_ID.\n`);
      return 2;
    }
    const target = calendars.find((c) => c.id === config.calendarId) ?? calendars[0];
    if (!target) {
      err('No calendar available to write to.\n');
      return 2;
    }
    if (!target.writable) {
      err('The target calendar is not writable by this account.\n');
      return 2;
    }
    out(`Target calendar: id=${target.id} name="${target.name}" writable=${target.writable}\n`);

    // The SyncService refuses to write unless the calendar is explicitly configured.
    // Set the discovered target into config, then reload so all services see it.
    process.env.TIMETREE_CALENDAR_ID = target.id;
    const config2 = loadConfig();

    // Count work-log memos before, to prove we add exactly one.
    const before = await provider.listMemos(target.id);
    const beforeWorklog = before.filter((m) => /^Worklog-ID:\s*\S+\s*$/m.test(m.note)).length;
    out(`Work-log memos before: ${beforeWorklog}\n`);

    ledger = new Ledger(config2.dbPath);
    const worklogs = new WorklogService(config2, ledger, logger);
    const sync = new SyncService(config2, ledger, provider, worklogs, logger);

    // 1. Preview
    const preview = worklogs.preview(syntheticInput);
    out(
      `Preview OK. worklogId=${preview.worklogId} previewHash=${preview.previewHash.slice(0, 12)}…\n`,
    );

    // 2. Save locally
    const saved = worklogs.save(syntheticInput);
    out(`Saved locally (revision ${saved.document.revision}).\n`);

    // 3. Publish with explicit confirmation
    const published = await sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: saved.previewHash,
      confirmation: 'PUBLISH',
      calendarId: target.id,
    });
    out(
      `Publish result: state=${published.state} verified=${published.verified} alreadyPublished=${published.alreadyPublished} memoId=${published.memoId ?? 'none'}\n`,
    );
    if (
      published.state !== 'PUBLISHED' ||
      published.verified !== true ||
      published.alreadyPublished !== false
    ) {
      err('Publish did not reach a verified PUBLISHED state. Stopping.\n');
      return 1;
    }

    // 4. Read back via sync status
    const status = await sync.getStatus({ worklogId: saved.document.worklogId });
    const st = status.summary ? status.worklog?.sync : undefined;
    out(
      `Sync status: state=${st?.state} memoId=${st?.memoId ?? 'none'} verifiedAt=${st?.verifiedAt ?? 'none'}\n`,
    );

    // 5. Re-publish same hash -> alreadyPublished, still one memo
    const again = await sync.publish({
      worklogId: saved.document.worklogId,
      previewHash: saved.previewHash,
      confirmation: 'PUBLISH',
      calendarId: target.id,
    });
    out(`Re-publish: state=${again.state} alreadyPublished=${again.alreadyPublished}\n`);

    // 6. Dry-run retry -> already_published
    const retry = await sync.retryPending({ worklogId: saved.document.worklogId, dryRun: true });
    out(`Dry-run retry action: ${retry.results[0]?.action}\n`);

    // 7. Confirm exactly one new work-log memo
    const after = await provider.listMemos(target.id);
    const afterWorklog = after.filter((m) => /^Worklog-ID:\s*\S+\s*$/m.test(m.note)).length;
    out(`Work-log memos after: ${afterWorklog}\n`);
    if (afterWorklog !== beforeWorklog + 1) {
      err(
        `Expected exactly one new work-log memo; before=${beforeWorklog} after=${afterWorklog}.\n`,
      );
      return 1;
    }

    out('\nLIVE WRITE TEST PASSED. Exactly one memo created and verified by read-back.\n');
    out(
      `CLEANUP: delete the memo titled "${published.remoteTitle ?? preview.remote.title}" (id ${published.memoId}) manually in the TimeTree app.\n`,
    );
    out('No update or delete was performed by this script.\n');
    return 0;
  } catch (error) {
    err(`Live write test failed: ${describeError(error)}\n`);
    return 1;
  } finally {
    ledger?.close();
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    err(`Live write test failed unexpectedly: ${describeError(error)}\n`);
    process.exitCode = 1;
  });
