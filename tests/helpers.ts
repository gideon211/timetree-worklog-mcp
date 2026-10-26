import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { MockTimeTreeProvider, type MockFailure } from '../src/providers/timetree/mock.js';
import { Ledger } from '../src/store/ledger.js';
import { SyncService } from '../src/sync/service.js';
import { WorklogService } from '../src/worklog/service.js';
import type { WorklogInput } from '../src/worklog/schema.js';

export interface HarnessOptions {
  writesEnabled?: boolean;
  failures?: MockFailure[];
  config?: Partial<Record<string, string>>;
  logLines?: string[];
}

export interface Harness {
  config: AppConfig;
  ledger: Ledger;
  provider: MockTimeTreeProvider;
  worklogs: WorklogService;
  sync: SyncService;
  logger: Logger;
  dir: string;
  close: () => void;
  reopen: () => Harness;
}

export function baseInput(overrides: Partial<WorklogInput> = {}): WorklogInput {
  return {
    date: '2026-10-26',
    timezone: 'Africa/Accra',
    title: 'Daily Work Log — 2026-10-26',
    executiveSummary:
      'Completed the local work-log storage path and documented the remaining sync risks.',
    completedTasks: [
      {
        description: 'Implemented local Markdown and SQLite persistence',
        source: 'evidence',
        evidenceIds: ['ev-commit'],
      },
    ],
    workInProgress: [
      {
        description: 'Verifying the optional TimeTree provider against the mock adapter',
        source: 'user',
        evidenceIds: [],
      },
    ],
    blockers: [
      {
        description: 'No authorized live TimeTree account is available in this environment',
        impact: 'Live integration remains unverified',
        source: 'user',
        evidenceIds: [],
      },
    ],
    decisions: [
      {
        decision: 'Keep remote writes disabled by default',
        rationale: 'The TimeTree client is unofficial and remote writes need explicit approval',
        source: 'user',
        evidenceIds: [],
      },
    ],
    nextActions: [
      {
        action: 'Run the gated live smoke test after operator approval',
        owner: 'operator',
        source: 'user',
        evidenceIds: [],
      },
    ],
    evidence: [
      {
        id: 'ev-commit',
        kind: 'commit',
        reference: 'local commit under review',
        description: 'Local implementation evidence, not a remote publication claim',
        verified: false,
      },
    ],
    ...overrides,
  };
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'timetree-worklog-test-'));
  const lines = options.logLines;
  const config = loadConfig({
    WORKLOG_DATA_DIR: dir,
    WORKLOG_DB_PATH: join(dir, 'worklog.sqlite'),
    WORKLOG_ARCHIVE_DIR: join(dir, 'worklogs'),
    WORKLOG_REPORTS_DIR: join(dir, 'reports'),
    WORKLOG_TIMEZONE: 'Africa/Accra',
    WORKLOG_LOG_LEVEL: 'error',
    TIMETREE_PROVIDER: 'mock',
    TIMETREE_CALENDAR_ID: 'cal_worklog',
    TIMETREE_ENABLE_REMOTE_WRITES: options.writesEnabled === false ? 'false' : 'true',
    TIMETREE_MAX_RPS: '1000',
    TIMETREE_MAX_RETRIES: '0',
    ...options.config,
  });
  const logger = new Logger({
    level: 'error',
    ...(lines
      ? {
          write: (line: string) => {
            lines.push(line);
          },
        }
      : {}),
  });
  const ledger = new Ledger(config.dbPath);
  const provider = new MockTimeTreeProvider({ failures: options.failures });
  const worklogs = new WorklogService(config, ledger, logger);
  const sync = new SyncService(config, ledger, provider, worklogs, logger);

  const harness: Harness = {
    config,
    ledger,
    provider,
    worklogs,
    sync,
    logger,
    dir,
    close: () => {
      try {
        ledger.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
    },
    reopen: () => {
      ledger.close();
      const nextLedger = new Ledger(config.dbPath);
      const nextWorklogs = new WorklogService(config, nextLedger, logger);
      const nextSync = new SyncService(config, nextLedger, provider, nextWorklogs, logger);
      return {
        ...harness,
        ledger: nextLedger,
        worklogs: nextWorklogs,
        sync: nextSync,
      };
    },
  };
  return harness;
}

export function saveAndPreview(harness: Harness, input: WorklogInput = baseInput()) {
  const preview = harness.worklogs.preview(input);
  const saved = harness.worklogs.save(input);
  return { preview, saved, worklogId: saved.document.worklogId };
}
