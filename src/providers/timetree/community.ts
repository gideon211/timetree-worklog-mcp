import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { AppConfig } from '../../config.js';
import { assertCredentials } from '../../config.js';
import type { Logger } from '../../logger.js';
import { ProviderError } from './provider.js';
import type {
  CreateMemoInput,
  ProviderCalendar,
  ProviderHealth,
  ProviderMemo,
  TimeTreeProvider,
} from './provider.js';
import { backoffMs, CircuitBreaker, RateLimiter, sleep } from './rate-limit.js';

const CalendarsResponseSchema = z
  .object({
    calendars: z.array(
      z
        .object({
          id: z.union([z.number(), z.string()]),
          name: z.string(),
          deactivated_at: z.union([z.number(), z.string(), z.null()]).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const EventSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    uuid: z.string(),
    calendar_id: z.union([z.number(), z.string()]).optional(),
    title: z.string(),
    all_day: z.boolean().optional(),
    start_at: z.number(),
    start_timezone: z.string().optional(),
    end_at: z.number().optional(),
    end_timezone: z.string().optional(),
    category: z.number().optional(),
    note: z.string().nullish(),
    deactivated_at: z.union([z.number(), z.string(), z.null()]).optional(),
    updated_at: z.number().optional(),
  })
  .passthrough();

const EventsSyncResponseSchema = z
  .object({
    events: z.array(EventSchema),
    chunk: z.boolean(),
    since: z.number(),
  })
  .passthrough();

const EventResponseSchema = z.object({ event: EventSchema }).passthrough();

const MEMO_CATEGORY = 2;
const MAX_EVENT_PAGES = 100;

// Unofficial TimeTree web endpoints. The official Connect API was discontinued in
// December 2023. Endpoint behavior was reviewed against ehs208/TimeTree-MCP at
// commit 3f77995f4d074364c6ffe14bb95a9d0c43a7c1d8. This adapter is intentionally
// narrower than that project and does not use its installer.

interface FetchResult {
  status: number;
  body: string;
  headers: Headers;
}

export interface CommunityProviderOptions {
  config: AppConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

function isDeactivated(value: unknown): boolean {
  return value !== undefined && value !== null && value !== 0 && value !== '';
}

function normalizeSessionCookie(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('TIMETREE_SESSION_COOKIE is empty');
  }
  // Accept either a bare session value or a full "name=value" cookie string.
  return trimmed.includes('=') ? trimmed : `_session_id=${trimmed}`;
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderError(
          'UPSTREAM_SCHEMA_CHANGED',
          'The TimeTree response exceeded the configured size limit',
          { outcome: 'NOT_APPLIED' },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function memoDate(event: z.infer<typeof EventSchema>): string {
  return new Date(event.start_at).toISOString().slice(0, 10);
}

function toMemo(event: z.infer<typeof EventSchema>, calendarId: string): ProviderMemo {
  return {
    id: event.uuid,
    calendarId,
    title: event.title,
    note: event.note ?? '',
    date: memoDate(event),
    ...(event.updated_at ? { updatedAt: new Date(event.updated_at).toISOString() } : {}),
  };
}

export class CommunityTimeTreeProvider implements TimeTreeProvider {
  readonly name = 'community';
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly breaker: CircuitBreaker;
  private sessionCookie: string | undefined;
  private csrfToken: string | undefined;
  private csrfFetched = false;
  private readonly baseUrl: string;
  private readonly apiBase: string;

  constructor(options: CommunityProviderOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.limiter = new RateLimiter(this.config.maxRequestsPerSecond);
    this.breaker = new CircuitBreaker();
    this.baseUrl = this.config.timetreeBaseUrl.replace(/\/+$/, '');
    this.apiBase = `${this.baseUrl}/api/v1`;
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const data = await this.readJson(`${this.apiBase}/calendars?since=0`, CalendarsResponseSchema);
    return data.calendars
      .filter((calendar) => !isDeactivated(calendar.deactivated_at))
      .map((calendar) => ({
        id: String(calendar.id),
        name: calendar.name,
        writable: true,
      }));
  }

  async listMemos(calendarId: string): Promise<ProviderMemo[]> {
    this.assertPathSegment(calendarId);
    const byUuid = new Map<string, z.infer<typeof EventSchema>>();
    const visited = new Set<number>([0]);
    let cursor = 0;

    for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
      const data = await this.readJson(
        `${this.apiBase}/calendar/${calendarId}/events/sync?since=${cursor}`,
        EventsSyncResponseSchema,
      );
      for (const event of data.events) {
        const known = byUuid.get(event.uuid);
        if (!known || (event.updated_at ?? 0) >= (known.updated_at ?? 0)) {
          byUuid.set(event.uuid, event);
        }
      }
      if (!data.chunk) {
        return [...byUuid.values()]
          .filter(
            (event) => event.category === MEMO_CATEGORY && !isDeactivated(event.deactivated_at),
          )
          .map((event) => toMemo(event, calendarId));
      }
      if (visited.has(data.since)) {
        throw new ProviderError(
          'UPSTREAM_SCHEMA_CHANGED',
          'TimeTree event paging repeated a cursor before the final chunk',
          { outcome: 'NOT_APPLIED' },
        );
      }
      visited.add(data.since);
      cursor = data.since;
    }

    throw new ProviderError(
      'UPSTREAM_SCHEMA_CHANGED',
      `TimeTree event feed did not finish within ${MAX_EVENT_PAGES} pages`,
      { outcome: 'NOT_APPLIED' },
    );
  }

  async getMemo(calendarId: string, memoId: string): Promise<ProviderMemo> {
    this.assertPathSegment(calendarId);
    this.assertPathSegment(memoId);
    const data = await this.readJson(
      `${this.apiBase}/calendar/${calendarId}/event/${memoId}`,
      EventResponseSchema,
    );
    if (data.event.category !== MEMO_CATEGORY || isDeactivated(data.event.deactivated_at)) {
      throw new ProviderError('MEMO_NOT_FOUND', 'The requested event is not an active memo', {
        outcome: 'NOT_APPLIED',
      });
    }
    return toMemo(data.event, calendarId);
  }

  async createMemo(calendarId: string, input: CreateMemoInput): Promise<ProviderMemo> {
    this.assertPathSegment(calendarId);
    if (!input.title.trim() || !input.note.trim()) {
      throw new ProviderError('VALIDATION_ERROR', 'A memo requires a title and note', {
        outcome: 'NOT_APPLIED',
      });
    }
    if (input.title.length > 200) {
      throw new ProviderError('VALIDATION_ERROR', 'The memo title is too long', {
        outcome: 'NOT_APPLIED',
      });
    }

    const startAt = Date.parse(`${input.date}T00:00:00.000Z`);
    if (!Number.isFinite(startAt)) {
      throw new ProviderError('VALIDATION_ERROR', 'The memo date is invalid', {
        outcome: 'NOT_APPLIED',
      });
    }

    const data = await this.writeJson(
      `${this.apiBase}/calendar/${calendarId}/event`,
      {
        title: input.title,
        all_day: true,
        start_at: startAt,
        start_timezone: 'UTC',
        end_at: startAt,
        end_timezone: 'UTC',
        category: MEMO_CATEGORY,
        note: input.note,
        attendees: [],
        recurrences: [],
        alerts: [],
        file_uuids: [],
      },
      EventResponseSchema,
    );
    if (data.event.category !== MEMO_CATEGORY) {
      throw new ProviderError(
        'UPSTREAM_SCHEMA_CHANGED',
        'TimeTree created an event that is not a memo',
        { outcome: 'UNKNOWN' },
      );
    }
    return toMemo(data.event, calendarId);
  }

  async health(): Promise<ProviderHealth> {
    if (!this.config.timetreeEmail || !this.config.timetreePassword) {
      return { status: 'unconfigured', message: 'TimeTree credentials are not configured' };
    }
    if (this.breaker.isOpen) {
      return {
        status: 'blocked',
        message: 'The circuit breaker is open after repeated TimeTree failures',
      };
    }
    return { status: 'ok' };
  }

  private async readJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    let lastError: ProviderError | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        const result = await this.request(url, { method: 'GET' }, false);
        return this.parse(result, schema, 'NOT_APPLIED');
      } catch (error) {
        const providerError = this.asProviderError(error, 'NOT_APPLIED');
        lastError = providerError;
        if (!providerError.retryable || attempt >= this.config.maxRetries) throw providerError;
        await sleep(backoffMs(attempt + 1));
      }
    }
    throw lastError ?? new ProviderError('NETWORK_ERROR', 'TimeTree read failed');
  }

  private async writeJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const result = await this.request(url, { method: 'POST', body: JSON.stringify(body) }, true);
    return this.parse(result, schema, 'UNKNOWN');
  }

  private async request(
    url: string,
    init: { method: string; body?: string },
    requiresCsrf: boolean,
  ): Promise<FetchResult> {
    let reauthenticated = false;
    while (true) {
      await this.ensureAuthenticated();
      if (requiresCsrf && !this.csrfToken) {
        await this.fetchCsrfToken();
      }
      if (requiresCsrf && !this.csrfToken) {
        throw new ProviderError(
          'AUTH_FAILED',
          'TimeTree did not provide a CSRF token, so the write was not attempted',
          { outcome: 'NOT_APPLIED', retryable: true },
        );
      }

      await this.limiter.acquire();
      this.breaker.assertClosed();

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: init.method,
          ...(init.body !== undefined ? { body: init.body } : {}),
          headers: this.headers(requiresCsrf),
          redirect: 'follow',
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (error) {
        this.breaker.recordFailure();
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new ProviderError(
          timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
          timedOut
            ? 'TimeTree did not respond before the configured timeout'
            : 'Could not reach TimeTree',
          { retryable: true, outcome: init.method === 'GET' ? 'NOT_APPLIED' : 'UNKNOWN' },
        );
      }

      let body: string;
      try {
        body = await readBodyLimited(response, this.config.maxResponseBytes);
      } catch (error) {
        if (error instanceof ProviderError) {
          throw new ProviderError(error.code, error.message, {
            retryable: false,
            statusCode: response.status,
            outcome: init.method === 'GET' ? 'NOT_APPLIED' : 'UNKNOWN',
          });
        }
        throw error;
      }
      this.captureSession(response.headers);

      if (
        (response.status === 401 || response.status === 403) &&
        !reauthenticated &&
        !this.config.timetreeSessionCookie
      ) {
        reauthenticated = true;
        this.logger.warn('TimeTree rejected the session; re-authenticating once', {
          status: response.status,
        });
        await this.signIn();
        continue;
      }

      if (response.status === 0 || response.status >= 500) {
        this.breaker.recordFailure();
        throw new ProviderError('SERVER_ERROR', `TimeTree returned HTTP ${response.status}`, {
          retryable: true,
          statusCode: response.status,
          outcome: init.method === 'GET' ? 'NOT_APPLIED' : 'UNKNOWN',
        });
      }

      if (response.status === 429) {
        throw new ProviderError('RATE_LIMITED', 'TimeTree rate limit reached', {
          retryable: true,
          statusCode: 429,
          outcome: 'NOT_APPLIED',
        });
      }

      if (response.status === 401) {
        throw new ProviderError('AUTH_FAILED', 'TimeTree authentication failed', {
          retryable: false,
          statusCode: 401,
          outcome: 'NOT_APPLIED',
        });
      }

      if (response.status === 403) {
        throw new ProviderError(
          'PERMISSION_DENIED',
          'TimeTree denied access to this calendar or operation',
          { retryable: false, statusCode: 403, outcome: 'NOT_APPLIED' },
        );
      }

      if (response.status === 404) {
        throw new ProviderError('MEMO_NOT_FOUND', 'TimeTree resource not found', {
          retryable: false,
          statusCode: 404,
          outcome: 'NOT_APPLIED',
        });
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ProviderError(
          'VALIDATION_ERROR',
          `TimeTree rejected the request with HTTP ${response.status}`,
          {
            retryable: false,
            statusCode: response.status,
            outcome: init.method === 'GET' ? 'NOT_APPLIED' : 'NOT_APPLIED',
          },
        );
      }

      this.breaker.recordSuccess();
      return { status: response.status, body, headers: response.headers };
    }
  }

  private parse<T>(
    result: FetchResult,
    schema: z.ZodType<T>,
    failureOutcome: 'NOT_APPLIED' | 'UNKNOWN',
  ): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body);
    } catch (error) {
      throw new ProviderError('UPSTREAM_SCHEMA_CHANGED', 'TimeTree returned a non-JSON response', {
        outcome: failureOutcome,
        cause: error,
      });
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new ProviderError(
        'UPSTREAM_SCHEMA_CHANGED',
        'TimeTree returned an unexpected response shape',
        { outcome: failureOutcome },
      );
    }
    return validated.data;
  }

  private headers(requiresCsrf: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Timetreea': 'web/2.1.0/en',
      'User-Agent': 'timetree-worklog-mcp/0.1.0 (unofficial)',
    };
    if (this.sessionCookie) headers.Cookie = this.sessionCookie;
    if (requiresCsrf && this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
    return headers;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.config.timetreeSessionCookie) {
      // Session-cookie mode: reuse an operator-supplied session (for example one
      // obtained by signing in with Google in a browser). No password is used.
      if (!this.sessionCookie) {
        try {
          this.sessionCookie = normalizeSessionCookie(this.config.timetreeSessionCookie);
        } catch (error) {
          throw new ProviderError('UNCONFIGURED', 'TIMETREE_SESSION_COOKIE is empty or invalid.', {
            retryable: false,
            outcome: 'NOT_APPLIED',
            cause: error,
          });
        }
      }
      if (this.csrfFetched) return;
      await this.fetchCsrfToken();
      this.csrfFetched = true;
      return;
    }
    if (this.sessionCookie) return;
    await this.signIn();
  }

  private async signIn(): Promise<void> {
    let credentials: { email: string; password: string };
    try {
      credentials = assertCredentials(this.config);
    } catch (error) {
      throw new ProviderError(
        'UNCONFIGURED',
        'TimeTree credentials are not configured. Set TIMETREE_EMAIL and TIMETREE_PASSWORD in the MCP client environment.',
        { retryable: false, outcome: 'NOT_APPLIED', cause: error },
      );
    }
    this.sessionCookie = undefined;
    this.csrfToken = undefined;
    this.breaker.assertClosed();
    await this.limiter.acquire();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/auth/email/signin`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Timetreea': 'web/2.1.0/en',
          'User-Agent': 'timetree-worklog-mcp/0.1.0 (unofficial)',
        },
        body: JSON.stringify({
          uid: credentials.email,
          password: credentials.password,
          uuid: randomUUID().replace(/-/g, ''),
        }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      this.breaker.recordFailure();
      throw new ProviderError('NETWORK_ERROR', 'Could not reach TimeTree sign-in', {
        retryable: true,
        outcome: 'NOT_APPLIED',
        cause: error,
      });
    }

    if (response.status === 401) {
      throw new ProviderError('AUTH_FAILED', 'Invalid TimeTree email or password', {
        retryable: false,
        statusCode: 401,
        outcome: 'NOT_APPLIED',
      });
    }
    if (response.status === 403) {
      throw new ProviderError('PERMISSION_DENIED', 'TimeTree blocked this sign-in', {
        retryable: false,
        statusCode: 403,
        outcome: 'NOT_APPLIED',
      });
    }
    if (response.status === 429) {
      throw new ProviderError('RATE_LIMITED', 'TimeTree sign-in rate limit reached', {
        retryable: true,
        statusCode: 429,
        outcome: 'NOT_APPLIED',
      });
    }
    if (response.status === 0 || response.status >= 500) {
      this.breaker.recordFailure();
      throw new ProviderError('SERVER_ERROR', `TimeTree sign-in returned HTTP ${response.status}`, {
        retryable: true,
        statusCode: response.status,
        outcome: 'NOT_APPLIED',
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError('AUTH_FAILED', `TimeTree sign-in returned HTTP ${response.status}`, {
        retryable: false,
        statusCode: response.status,
        outcome: 'NOT_APPLIED',
      });
    }

    this.captureSession(response.headers);
    if (!this.sessionCookie) {
      throw new ProviderError('AUTH_FAILED', 'TimeTree did not return a session cookie', {
        retryable: false,
        outcome: 'NOT_APPLIED',
      });
    }
    this.breaker.recordSuccess();
    await this.fetchCsrfToken();
  }

  private async fetchCsrfToken(): Promise<void> {
    await this.limiter.acquire();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/`, {
        method: 'GET',
        headers: {
          Accept: 'text/html',
          'User-Agent': 'timetree-worklog-mcp/0.1.0 (unofficial)',
          ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      const html = await readBodyLimited(response, this.config.maxResponseBytes);
      const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
      if (match?.[1]) this.csrfToken = match[1];
    } catch {
      // Reads can proceed without a CSRF token. writeJson checks before writing.
      this.csrfToken = undefined;
    }
  }

  private captureSession(headers: Headers): void {
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const values = getSetCookie ? getSetCookie.call(headers) : [headers.get('set-cookie') ?? ''];
    for (const value of values) {
      const match = value.match(/(?:^|;\s*)_session_id=([^;]+)/);
      if (match?.[1]) {
        this.sessionCookie = `_session_id=${match[1]}`;
        return;
      }
    }
  }

  private assertPathSegment(value: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new ProviderError('VALIDATION_ERROR', 'Invalid TimeTree identifier', {
        outcome: 'NOT_APPLIED',
      });
    }
  }

  private asProviderError(
    error: unknown,
    fallbackOutcome: 'NOT_APPLIED' | 'UNKNOWN',
  ): ProviderError {
    if (error instanceof ProviderError) return error;
    return new ProviderError('NETWORK_ERROR', 'TimeTree request failed', {
      retryable: true,
      outcome: fallbackOutcome,
      cause: error,
    });
  }
}
