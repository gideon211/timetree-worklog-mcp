import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import type { AppConfig } from '../config.js';
import { hasTimeTreeCredentials } from '../config.js';
import { AppError, asAppError, type ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { ProviderError } from '../providers/timetree/provider.js';
import type { TimeTreeProvider } from '../providers/timetree/provider.js';
import type { Ledger } from '../store/ledger.js';
import { SyncService } from '../sync/service.js';
import type { WorklogDocument } from '../worklog/schema.js';
import { SyncStateSchema, TimeZoneSchema, IsoDateSchema } from '../worklog/schema.js';
import { WorklogInputSchema } from '../worklog/schema.js';
import { WorklogService } from '../worklog/service.js';

const ErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ResultSchema = z.strictObject({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: ErrorSchema.optional(),
});

const ListCalendarsInput = z.strictObject({});

const SaveInput = z.strictObject({
  ...WorklogInputSchema.shape,
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional client-supplied key to make repeated saves idempotent'),
});

const GetInput = z.strictObject({
  worklogId: z.string().min(1).optional(),
  date: IsoDateSchema.optional(),
  timezone: TimeZoneSchema.optional(),
  includeMarkdown: z.boolean().default(true),
});

const SearchInput = z.strictObject({
  query: z.string().max(500).optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  timezone: TimeZoneSchema.optional(),
  syncState: SyncStateSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

const ReportInput = z.strictObject({
  from: IsoDateSchema,
  to: IsoDateSchema,
  timezone: TimeZoneSchema.optional(),
});

const PublishInput = z.strictObject({
  worklogId: z.string().min(1),
  previewHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/,
      'Expected the 64-character preview hash returned by preview_daily_worklog',
    ),
  confirmation: z.literal('PUBLISH'),
  calendarId: z.string().min(1).optional(),
});

const SyncStatusInput = z.strictObject({
  worklogId: z.string().min(1).optional(),
  date: IsoDateSchema.optional(),
  timezone: TimeZoneSchema.optional(),
});

const RetryInput = z.strictObject({
  worklogId: z.string().min(1).optional(),
  dryRun: z
    .boolean()
    .default(true)
    .describe('Defaults to true. A live retry requires explicit confirmation.'),
  confirmation: z.literal('RETRY').optional(),
});

function jsonContent(value: unknown): CallToolResult['content'] {
  return [
    {
      type: 'text',
      text: JSON.stringify(value, null, 2),
    },
  ];
}

function ok(data: unknown): CallToolResult {
  const envelope = { ok: true, data };
  return {
    content: jsonContent(envelope),
    structuredContent: envelope,
  };
}

function fail(error: AppError): CallToolResult {
  const envelope = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  return {
    content: jsonContent(envelope),
    structuredContent: envelope,
    isError: true,
  };
}

function mapProviderError(error: ProviderError): AppError {
  const codeMap: Record<string, ErrorCode> = {
    AUTH_FAILED: 'TIMETREE_AUTH_FAILED',
    PERMISSION_DENIED: 'TIMETREE_PERMISSION_DENIED',
    RATE_LIMITED: 'TIMETREE_RATE_LIMITED',
    TIMEOUT: 'TIMETREE_UNAVAILABLE',
    NETWORK_ERROR: 'TIMETREE_UNAVAILABLE',
    SERVER_ERROR: 'TIMETREE_UNAVAILABLE',
    UPSTREAM_SCHEMA_CHANGED: 'TIMETREE_SCHEMA_CHANGED',
    CALENDAR_NOT_FOUND: 'TIMETREE_CALENDAR_NOT_FOUND',
    MEMO_NOT_FOUND: 'WORKLOG_NOT_FOUND',
    VALIDATION_ERROR: 'INVALID_INPUT',
    CIRCUIT_OPEN: 'CIRCUIT_OPEN',
    UNCONFIGURED: 'TIMETREE_NOT_CONFIGURED',
    UNSUPPORTED: 'INTERNAL_ERROR',
  };
  return new AppError(codeMap[error.code] ?? 'TIMETREE_UNAVAILABLE', error.message, {
    retryable: error.retryable,
    details: { providerCode: error.code, outcome: error.outcome },
    cause: error,
  });
}

function mapError(error: unknown): AppError {
  if (error instanceof ProviderError) return mapProviderError(error);
  return asAppError(error);
}

function documentView(
  document: WorklogDocument,
  includeMarkdown: boolean,
): Record<string, unknown> {
  return {
    worklogId: document.worklogId,
    date: document.date,
    timezone: document.timezone,
    title: document.title,
    revision: document.revision,
    contentHash: document.contentHash,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    markdownPath: document.markdownPath,
    sync: document.sync,
    executiveSummary: document.executiveSummary,
    completedTasks: document.completedTasks,
    workInProgress: document.workInProgress,
    blockers: document.blockers,
    decisions: document.decisions,
    nextActions: document.nextActions,
    evidence: document.evidence,
    ...(includeMarkdown ? { markdown: document.markdown } : {}),
  };
}

async function run(
  tool: string,
  logger: Logger,
  handler: () => Promise<unknown> | unknown,
): Promise<CallToolResult> {
  try {
    const data = await handler();
    logger.info('tool.completed', { tool, ok: true });
    return ok(data);
  } catch (error) {
    const appError = mapError(error);
    logger.error('tool.failed', {
      tool,
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
    });
    return fail(appError);
  }
}

export interface McpServerBundle {
  server: McpServer;
  ledger: Ledger;
  provider: TimeTreeProvider;
  worklogs: WorklogService;
  sync: SyncService;
}

export function createMcpServer(options: {
  config: AppConfig;
  ledger: Ledger;
  provider: TimeTreeProvider;
  logger: Logger;
}): McpServerBundle {
  const { config, ledger, provider, logger } = options;
  const worklogs = new WorklogService(config, ledger, logger);
  const sync = new SyncService(config, ledger, provider, worklogs, logger);

  const server = new McpServer(
    { name: 'timetree-worklog-mcp', version: '0.1.0' },
    {
      instructions: [
        'Local-first daily work-log server. Save and retrieve work logs locally without TimeTree.',
        'Remote writes are disabled by default. publish_worklog is an explicit remote write and requires TIMETREE_ENABLE_REMOTE_WRITES=true, a matching preview hash, and confirmation PUBLISH.',
        'An uncertain remote outcome is never retried blindly. Use retry_pending_sync with dryRun=true first; it reconciles the configured calendar before any write.',
        'Only one configured private TimeTree calendar is allowed. Do not infer dates, deadlines, completed work, decisions, or evidence. Distinguish user-reported facts from verified evidence.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'list_calendars',
    {
      title: 'List TimeTree calendars',
      description:
        'Read-only. Lists calendars available to the configured TimeTree account. Requires local credentials but never writes. Use this to find the one private calendar ID to configure; no destructive calendar operation is exposed.',
      inputSchema: ListCalendarsInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'List TimeTree calendars',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      run('list_calendars', logger, async () => {
        if (config.provider === 'community' && !hasTimeTreeCredentials(config)) {
          throw new AppError(
            'TIMETREE_NOT_CONFIGURED',
            'TimeTree credentials must be configured before listing calendars. Set TIMETREE_EMAIL and TIMETREE_PASSWORD.',
          );
        }
        const calendars = await provider.listCalendars();
        return {
          provider: provider.name,
          calendars,
          writesEnabled: config.remoteWritesEnabled,
        };
      }),
  );

  server.registerTool(
    'preview_daily_worklog',
    {
      title: 'Preview a daily work log',
      description:
        'Validate and render a daily work log without saving or contacting TimeTree. Returns the full local Markdown, the exact remote memo title/note that a later publish would send, warnings for suspected secrets, and the previewHash required by publish_worklog. Never invents completion, dates, deadlines, decisions, or evidence.',
      inputSchema: WorklogInputSchema,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Preview a daily work log',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      run('preview_daily_worklog', logger, () => {
        const preview = worklogs.preview(args);
        return {
          ...preview,
          writesEnabled: config.remoteWritesEnabled,
          provider: config.provider,
          remote: {
            ...preview.remote,
            note: preview.remote.note,
            truncated: preview.remote.truncated,
          },
        };
      }),
  );

  server.registerTool(
    'save_worklog',
    {
      title: 'Save a daily work log locally',
      description:
        'Save the work log to the local Markdown archive and SQLite ledger before any remote operation. This tool never contacts TimeTree. Saves are revisioned by date and timezone; identical content is idempotent. Use the returned previewHash with publish_worklog only after reviewing the preview.',
      inputSchema: SaveInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Save a daily work log locally',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      run('save_worklog', logger, () => {
        const { idempotencyKey, ...input } = args;
        const result = worklogs.save(input, idempotencyKey);
        return {
          created: result.created,
          unchanged: result.unchanged,
          warnings: result.warnings,
          secretWarnings: result.secretWarnings,
          previewHash: result.previewHash,
          document: documentView(result.document, true),
        };
      }),
  );

  server.registerTool(
    'get_daily_worklog',
    {
      title: 'Get a saved daily work log',
      description:
        'Read a saved work log from the local Markdown archive and SQLite ledger by worklogId or by date plus timezone. This is a local read and does not contact TimeTree.',
      inputSchema: GetInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Get a saved daily work log',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      run('get_daily_worklog', logger, () => {
        const document = worklogs.resolve({
          ...(args.worklogId ? { worklogId: args.worklogId } : {}),
          ...(args.date ? { date: args.date } : {}),
          ...(args.timezone ? { timezone: args.timezone } : {}),
        });
        return { document: documentView(document, args.includeMarkdown) };
      }),
  );

  server.registerTool(
    'search_worklogs',
    {
      title: 'Search saved work logs',
      description:
        'Search the local work-log archive by text, date range, timezone and sync state. Results include matching worklog IDs, dates, sync states and short snippets. This is a local read.',
      inputSchema: SearchInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Search saved work logs',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      run('search_worklogs', logger, () =>
        worklogs.search({
          ...(args.query ? { query: args.query } : {}),
          ...(args.from ? { from: args.from } : {}),
          ...(args.to ? { to: args.to } : {}),
          ...(args.timezone ? { timezone: args.timezone } : {}),
          ...(args.syncState ? { syncState: args.syncState } : {}),
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    'generate_progress_report',
    {
      title: 'Generate a progress report',
      description:
        'Build a Markdown progress report from saved local work logs for an explicit date range and timezone. The report attributes every item to its worklog ID and date, distinguishes verified evidence from user-reported statements, and writes a local report file. It is limited to 366 calendar days per request and does not invent missing work, decisions, blockers, deadlines or completion.',
      inputSchema: ReportInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Generate a progress report',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      run('generate_progress_report', logger, () =>
        worklogs.generateReport(args.from, args.to, args.timezone),
      ),
  );

  server.registerTool(
    'publish_worklog',
    {
      title: 'Publish a work log to TimeTree',
      description:
        'Explicit remote write. Publishes a saved work log as one all-day TimeTree memo in the single configured private calendar. Requires remote writes enabled, credentials, a previewHash that matches the current saved revision, no suspected secrets, and confirmation PUBLISH. It reconciles first to avoid duplicates, verifies the created memo by reading it back, and returns UNCERTAIN or CONFLICT instead of claiming success. No destructive or update operation is provided.',
      inputSchema: PublishInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Publish a work log to TimeTree',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      run('publish_worklog', logger, () =>
        sync.publish({
          worklogId: args.worklogId,
          previewHash: args.previewHash,
          confirmation: args.confirmation,
          ...(args.calendarId ? { calendarId: args.calendarId } : {}),
        }),
      ),
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Get work-log sync status',
      description:
        'Read local synchronization state, counts, attempt history and provider health. Without a worklogId or date it returns an aggregate summary. It never writes and does not call TimeTree.',
      inputSchema: SyncStatusInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Get work-log sync status',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      run('get_sync_status', logger, () =>
        sync.getStatus({
          ...(args.worklogId ? { worklogId: args.worklogId } : {}),
          ...(args.date ? { date: args.date } : {}),
          ...(args.timezone ? { timezone: args.timezone } : {}),
        }),
      ),
  );

  server.registerTool(
    'retry_pending_sync',
    {
      title: 'Retry pending work-log synchronization',
      description:
        'Reconcile pending, failed or uncertain work logs before any retry. Defaults to dryRun: true, which lists what would happen without writing. A live retry requires remote writes enabled and confirmation RETRY, is limited to 10 work logs per call, never retries CONFLICT or FAILED_PERMANENT records, and re-verifies every created memo. Never assume a timeout means no memo.',
      inputSchema: RetryInput,
      outputSchema: ResultSchema,
      annotations: {
        title: 'Retry pending work-log synchronization',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      run('retry_pending_sync', logger, () =>
        sync.retryPending({
          ...(args.worklogId ? { worklogId: args.worklogId } : {}),
          dryRun: args.dryRun,
          ...(args.confirmation ? { confirmation: args.confirmation } : {}),
        }),
      ),
  );

  return { server, ledger, provider, worklogs, sync };
}
