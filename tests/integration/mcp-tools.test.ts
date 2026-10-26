import { describe, expect, it, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/tools.js';
import { baseInput, makeHarness, saveAndPreview, type Harness } from '../helpers.js';

const harnesses: Harness[] = [];

function setup(options: Parameters<typeof makeHarness>[0] = {}) {
  const harness = makeHarness({ logLines: [], ...options });
  harnesses.push(harness);
  const bundle = createMcpServer({
    config: harness.config,
    ledger: harness.ledger,
    provider: harness.provider,
    logger: harness.logger,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  return { harness, bundle, client, clientTransport, serverTransport };
}

function envelope(result: Awaited<ReturnType<Client['callTool']>>): {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; retryable: boolean };
} {
  return result.structuredContent as never;
}

afterEach(async () => {
  while (harnesses.length) {
    harnesses.pop()?.close();
  }
});

describe('MCP tool surface', () => {
  it('exposes exactly the approved tools and no destructive calendar or memo operation', async () => {
    const { bundle, client, clientTransport, serverTransport } = setup();
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'generate_progress_report',
      'get_daily_worklog',
      'get_sync_status',
      'list_calendars',
      'preview_daily_worklog',
      'publish_worklog',
      'retry_pending_sync',
      'save_worklog',
      'search_worklogs',
    ]);
    expect(tools.tools.some((tool) => /delete|update|remove/i.test(tool.name))).toBe(false);
    await client.close();
    await bundle.server.close();
  });

  it('lists calendars before a calendar ID is configured', async () => {
    const { bundle, client, clientTransport, serverTransport } = setup({
      config: {
        TIMETREE_PROVIDER: 'community',
        TIMETREE_EMAIL: 'operator@example.com',
        TIMETREE_PASSWORD: 'not-a-real-password',
        TIMETREE_CALENDAR_ID: '',
      },
    });
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'list_calendars', arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = envelope(result);
    expect(body.ok).toBe(true);
    expect(body.data.calendars[0].id).toBe('cal_worklog');
    await client.close();
    await bundle.server.close();
  });

  it('returns structured previews, local saves, retrieval and search results', async () => {
    const { bundle, client, clientTransport, serverTransport } = setup();
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const preview = envelope(
      await client.callTool({
        name: 'preview_daily_worklog',
        arguments: baseInput(),
      }),
    );
    expect(preview.ok).toBe(true);
    expect(preview.data.worklogId).toBe('wl_2026-10-26_africa-accra');
    expect(preview.data.markdown).toContain('## Executive summary');
    expect(preview.data.previewHash).toMatch(/^[a-f0-9]{64}$/);

    const saved = envelope(
      await client.callTool({
        name: 'save_worklog',
        arguments: { ...baseInput(), idempotencyKey: 'e2e-save-1' },
      }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.data.document.revision).toBe(1);
    expect(saved.data.document.markdownPath).toContain('2026-10-26--africa-accra.md');

    const retrieved = envelope(
      await client.callTool({
        name: 'get_daily_worklog',
        arguments: { date: '2026-10-26', timezone: 'Africa/Accra' },
      }),
    );
    expect(retrieved.ok).toBe(true);
    expect(retrieved.data.document.worklogId).toBe('wl_2026-10-26_africa-accra');
    expect(retrieved.data.document.markdown).toContain('## Completed tasks');

    const search = envelope(
      await client.callTool({
        name: 'search_worklogs',
        arguments: { query: 'SQLite', limit: 10, offset: 0 },
      }),
    );
    expect(search.ok).toBe(true);
    expect(search.data.total).toBe(1);

    const report = envelope(
      await client.callTool({
        name: 'generate_progress_report',
        arguments: { from: '2026-10-26', to: '2026-10-26', timezone: 'Africa/Accra' },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.data.report).toContain('wl_2026-10-26_africa-accra');

    const status = envelope(
      await client.callTool({
        name: 'get_sync_status',
        arguments: { worklogId: 'wl_2026-10-26_africa-accra' },
      }),
    );
    expect(status.ok).toBe(true);
    expect(status.data.worklog.sync.state).toBe('NOT_PUBLISHED');

    const calendars = envelope(await client.callTool({ name: 'list_calendars', arguments: {} }));
    expect(calendars.ok).toBe(true);
    expect(calendars.data.calendars[0].id).toBe('cal_worklog');

    await client.close();
    await bundle.server.close();
  });

  it('publishes explicitly and reports verification, then supports dry-run reconciliation', async () => {
    const { harness, bundle, client, clientTransport, serverTransport } = setup();
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const { saved } = saveAndPreview(harness);
    const compact = harness.worklogs.resolve({ worklogId: saved.document.worklogId });
    const previewHash = harness.worklogs.previewHashFor(compact);

    const published = envelope(
      await client.callTool({
        name: 'publish_worklog',
        arguments: {
          worklogId: saved.document.worklogId,
          previewHash,
          confirmation: 'PUBLISH',
        },
      }),
    );
    expect(published.ok).toBe(true);
    expect(published.data.state).toBe('PUBLISHED');
    expect(published.data.verified).toBe(true);

    const dry = envelope(
      await client.callTool({
        name: 'retry_pending_sync',
        arguments: { worklogId: saved.document.worklogId },
      }),
    );
    expect(dry.ok).toBe(true);
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.results[0].action).toBe('already_published');

    await client.close();
    await bundle.server.close();
  });

  it('returns structured tool errors for invalid domain input', async () => {
    const { bundle, client, clientTransport, serverTransport } = setup();
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'get_daily_worklog',
      arguments: { timezone: 'Africa/Accra' },
    });
    expect(result.isError).toBe(true);
    const body = envelope(result);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_INPUT');
    expect(body.error?.retryable).toBe(false);

    const publish = await client.callTool({
      name: 'publish_worklog',
      arguments: {
        worklogId: 'wl_missing',
        previewHash: '0'.repeat(64),
        confirmation: 'PUBLISH',
      },
    });
    expect(publish.isError).toBe(true);
    expect(envelope(publish).error?.code).toBe('WORKLOG_NOT_FOUND');

    await client.close();
    await bundle.server.close();
  });

  it('rejects an unknown argument at the MCP schema boundary', async () => {
    const { bundle, client, clientTransport, serverTransport } = setup();
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'preview_daily_worklog',
      arguments: { ...baseInput(), unexpected: true } as never,
    });
    expect(result.isError).toBe(true);
    await client.close();
    await bundle.server.close();
  });
});
