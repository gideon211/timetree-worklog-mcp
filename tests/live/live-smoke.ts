/**
 * Read-only live TimeTree smoke check.
 *
 * This script is intentionally excluded from `npm test`. It only runs when
 * TIMETREE_LIVE_SMOKE=1 is set and credentials are supplied explicitly.
 * It never creates, updates, or deletes a memo.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTimeTreeCredentials, loadConfig } from '../../src/config.js';
import { Logger } from '../../src/logger.js';
import { createTimeTreeProvider } from '../../src/providers/timetree/index.js';
import { ProviderError } from '../../src/providers/timetree/provider.js';

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

async function main(): Promise<number> {
  if (process.env.TIMETREE_LIVE_SMOKE !== '1') {
    out(
      'Live TimeTree smoke skipped.\n' +
        'Set TIMETREE_LIVE_SMOKE=1, TIMETREE_EMAIL and TIMETREE_PASSWORD to opt in.\n' +
        'This check is read-only and is not part of the automated test suite.\n',
    );
    return 0;
  }

  const dir = mkdtempSync(join(tmpdir(), 'timetree-worklog-live-smoke-'));
  const envKeys = [
    'WORKLOG_DATA_DIR',
    'WORKLOG_DB_PATH',
    'WORKLOG_ARCHIVE_DIR',
    'WORKLOG_REPORTS_DIR',
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of envKeys) previous.set(key, process.env[key]);
  process.env.WORKLOG_DATA_DIR = dir;
  process.env.WORKLOG_DB_PATH = join(dir, 'smoke.sqlite');
  process.env.WORKLOG_ARCHIVE_DIR = join(dir, 'worklogs');
  process.env.WORKLOG_REPORTS_DIR = join(dir, 'reports');

  try {
    const config = loadConfig();
    if (config.provider !== 'community') {
      err('Live smoke requires TIMETREE_PROVIDER=community.\n');
      return 2;
    }
    if (!hasTimeTreeCredentials(config)) {
      err('Live smoke requires TIMETREE_EMAIL and TIMETREE_PASSWORD.\n');
      return 2;
    }

    const provider = createTimeTreeProvider(
      config,
      new Logger({ level: 'error', write: (line) => process.stderr.write(`${line}\n`) }),
    );
    const calendars = await provider.listCalendars();
    out(`Read-only sign-in passed. Calendars visible: ${calendars.length}.\n`);

    const includeMemos = process.argv.includes('--include-memos');
    if (includeMemos) {
      const calendarId =
        config.calendarId ?? (calendars.length === 1 ? calendars[0]?.id : undefined);
      if (!calendarId) {
        err(
          'Set TIMETREE_CALENDAR_ID or configure exactly one calendar before using --include-memos.\n',
        );
        return 2;
      }
      if (!calendars.some((calendar) => calendar.id === calendarId)) {
        err('The configured TIMETREE_CALENDAR_ID is not visible to this account.\n');
        return 2;
      }
      const memos = await provider.listMemos(calendarId);
      const worklogMemos = memos.filter((memo) => /^Worklog-ID:\s*\S+\s*$/m.test(memo.note));
      out(
        `Memo listing passed for the configured calendar. Total active memos: ${memos.length}; ` +
          `work-log memos: ${worklogMemos.length}.\n`,
      );
    }

    out('Read-only live smoke passed. No memo was created, updated, or deleted.\n');
    return 0;
  } catch (error) {
    err(`Live smoke failed: ${describeError(error)}\n`);
    return 1;
  } finally {
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
    err(`Live smoke failed unexpectedly: ${describeError(error)}\n`);
    process.exitCode = 1;
  });
