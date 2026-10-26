import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('configuration directories', () => {
  posixOnly('creates application-owned directories with private permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'timetree-worklog-config-'));
    const dataDir = join(root, 'data');
    try {
      loadConfig({
        WORKLOG_DATA_DIR: dataDir,
        WORKLOG_DB_PATH: join(dataDir, 'worklog.sqlite'),
        WORKLOG_ARCHIVE_DIR: join(dataDir, 'worklogs'),
        WORKLOG_REPORTS_DIR: join(dataDir, 'reports'),
        WORKLOG_TIMEZONE: 'Africa/Accra',
      });
      expect(mode(dataDir)).toBe(0o700);
      expect(mode(join(dataDir, 'worklogs'))).toBe(0o700);
      expect(mode(join(dataDir, 'reports'))).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixOnly('does not tighten a user-supplied shared database parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'timetree-worklog-config-'));
    const shared = join(root, 'shared');
    const dataDir = join(root, 'data');
    mkdirSync(shared, { recursive: true, mode: 0o755 });
    chmodSync(shared, 0o755);
    try {
      loadConfig({
        WORKLOG_DATA_DIR: dataDir,
        WORKLOG_DB_PATH: join(shared, 'worklog.sqlite'),
        WORKLOG_ARCHIVE_DIR: join(dataDir, 'worklogs'),
        WORKLOG_REPORTS_DIR: join(dataDir, 'reports'),
        WORKLOG_TIMEZONE: 'Africa/Accra',
      });
      expect(mode(shared)).toBe(0o755);
      expect(mode(dataDir)).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
