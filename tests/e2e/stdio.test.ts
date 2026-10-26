import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { baseInput } from '../helpers.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcEntry = join(projectRoot, 'src', 'index.ts');

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

describe('stdio E2E', () => {
  it('starts over stdio and completes a local preview/save/get/report flow without remote writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timetree-worklog-e2e-'));
    const env = {
      ...cleanEnv(),
      WORKLOG_DATA_DIR: dir,
      WORKLOG_DB_PATH: join(dir, 'worklog.sqlite'),
      WORKLOG_ARCHIVE_DIR: join(dir, 'worklogs'),
      WORKLOG_REPORTS_DIR: join(dir, 'reports'),
      WORKLOG_TIMEZONE: 'Africa/Accra',
      WORKLOG_LOG_LEVEL: 'error',
      TIMETREE_PROVIDER: 'mock',
      TIMETREE_CALENDAR_ID: 'cal_worklog',
      TIMETREE_ENABLE_REMOTE_WRITES: 'false',
      TIMETREE_MAX_RPS: '1000',
      TIMETREE_MAX_RETRIES: '0',
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', srcEntry],
      cwd: projectRoot,
      env,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-e2e', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(9);

      const preview = await client.callTool({
        name: 'preview_daily_worklog',
        arguments: baseInput(),
      });
      expect(preview.isError).toBeFalsy();
      const previewData = preview.structuredContent as {
        ok: boolean;
        data: { worklogId: string; previewHash: string; markdown: string };
      };
      expect(previewData.ok).toBe(true);
      expect(previewData.data.worklogId).toBe('wl_2026-10-26_africa-accra');
      expect(previewData.data.previewHash).toMatch(/^[a-f0-9]{64}$/);
      expect(previewData.data.markdown).toContain('## Evidence and source references');

      const saved = await client.callTool({
        name: 'save_worklog',
        arguments: { ...baseInput(), idempotencyKey: 'stdio-e2e-1' },
      });
      expect(saved.isError).toBeFalsy();
      const savedData = saved.structuredContent as {
        ok: boolean;
        data: { document: { worklogId: string; markdownPath: string; revision: number } };
      };
      expect(savedData.data.document.revision).toBe(1);
      expect(savedData.data.document.worklogId).toBe('wl_2026-10-26_africa-accra');

      const retrieved = await client.callTool({
        name: 'get_daily_worklog',
        arguments: { worklogId: 'wl_2026-10-26_africa-accra' },
      });
      expect(retrieved.isError).toBeFalsy();

      const search = await client.callTool({
        name: 'search_worklogs',
        arguments: { query: 'SQLite', limit: 10, offset: 0 },
      });
      expect(search.isError).toBeFalsy();
      const searchData = search.structuredContent as { ok: boolean; data: { total: number } };
      expect(searchData.data.total).toBe(1);

      const report = await client.callTool({
        name: 'generate_progress_report',
        arguments: { from: '2026-10-26', to: '2026-10-26', timezone: 'Africa/Accra' },
      });
      expect(report.isError).toBeFalsy();

      const calendars = await client.callTool({ name: 'list_calendars', arguments: {} });
      expect(calendars.isError).toBeFalsy();

      const status = await client.callTool({
        name: 'get_sync_status',
        arguments: { worklogId: 'wl_2026-10-26_africa-accra' },
      });
      expect(status.isError).toBeFalsy();
      const statusData = status.structuredContent as {
        ok: boolean;
        data: { worklog: { sync: { state: string } } };
      };
      expect(statusData.data.worklog.sync.state).toBe('NOT_PUBLISHED');

      const publish = await client.callTool({
        name: 'publish_worklog',
        arguments: {
          worklogId: 'wl_2026-10-26_africa-accra',
          previewHash: previewData.data.previewHash,
          confirmation: 'PUBLISH',
        },
      });
      expect(publish.isError).toBe(true);
      const publishData = publish.structuredContent as {
        ok: boolean;
        error: { code: string };
      };
      expect(publishData.error.code).toBe('REMOTE_WRITES_DISABLED');

      const retry = await client.callTool({
        name: 'retry_pending_sync',
        arguments: { worklogId: 'wl_2026-10-26_africa-accra' },
      });
      expect(retry.isError).toBeFalsy();
      const retryData = retry.structuredContent as {
        ok: boolean;
        data: { dryRun: boolean; results: Array<{ action: string }> };
      };
      expect(retryData.data.dryRun).toBe(true);
      expect(retryData.data.results[0]?.action).toBe('not_retryable');
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
