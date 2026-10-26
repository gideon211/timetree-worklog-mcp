import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { Logger } from '../../src/logger.js';
import { CommunityTimeTreeProvider } from '../../src/providers/timetree/community.js';
import { ProviderError } from '../../src/providers/timetree/provider.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeProvider(
  fetchImpl: typeof fetch,
  options: { maxRetries?: number; maxResponseBytes?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'timetree-community-test-'));
  dirs.push(dir);
  const config = loadConfig({
    WORKLOG_DATA_DIR: dir,
    WORKLOG_DB_PATH: join(dir, 'worklog.sqlite'),
    WORKLOG_ARCHIVE_DIR: join(dir, 'worklogs'),
    WORKLOG_REPORTS_DIR: join(dir, 'reports'),
    TIMETREE_PROVIDER: 'community',
    TIMETREE_EMAIL: 'operator@example.com',
    TIMETREE_PASSWORD: 'not-a-real-password',
    TIMETREE_CALENDAR_ID: '1',
    TIMETREE_ENABLE_REMOTE_WRITES: 'true',
    TIMETREE_MAX_RPS: '1000',
    TIMETREE_MAX_RETRIES: String(options.maxRetries ?? 0),
    TIMETREE_TIMEOUT_MS: '5000',
    ...(options.maxResponseBytes
      ? { TIMETREE_MAX_RESPONSE_BYTES: String(options.maxResponseBytes) }
      : {}),
  });
  const logger = new Logger({ level: 'error', write: () => {} });
  return new CommunityTimeTreeProvider({ config, logger, fetchImpl });
}

const memoEvent = {
  id: 'event1',
  uuid: 'memo1',
  calendar_id: 1,
  title: 'Work Log 2026-10-26 [wl_2026-10-26_africa-accra]',
  all_day: true,
  start_at: Date.parse('2026-10-26T00:00:00.000Z'),
  category: 2,
  note: 'Worklog-ID: wl_2026-10-26_africa-accra\nWorklog-Hash: abc',
  updated_at: 123,
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('community TimeTree provider', () => {
  it('maps missing credentials to an unconfigured provider error without sending a request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timetree-community-test-'));
    dirs.push(dir);
    const config = loadConfig({
      WORKLOG_DATA_DIR: dir,
      WORKLOG_DB_PATH: join(dir, 'worklog.sqlite'),
      WORKLOG_ARCHIVE_DIR: join(dir, 'worklogs'),
      WORKLOG_REPORTS_DIR: join(dir, 'reports'),
      TIMETREE_PROVIDER: 'community',
      TIMETREE_MAX_RPS: '1000',
      TIMETREE_MAX_RETRIES: '0',
    });
    let requests = 0;
    const provider = new CommunityTimeTreeProvider({
      config,
      logger: new Logger({ level: 'error', write: () => {} }),
      fetchImpl: async () => {
        requests += 1;
        return new Response('unexpected', { status: 500 });
      },
    });
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'UNCONFIGURED',
      retryable: false,
      outcome: 'NOT_APPLIED',
    });
    expect(requests).toBe(0);
  });

  it('signs in with a session cookie, obtains CSRF, lists calendars and memos, and writes a memo', async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method,
        headers,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (url.endsWith('/api/v1/auth/email/signin')) {
        return jsonResponse(
          {},
          { headers: { 'set-cookie': '_session_id=session123; Path=/; HttpOnly' } },
        );
      }
      if (url.endsWith('/') || (method === 'GET' && url.endsWith('timetreeapp.com/'))) {
        return new Response('<meta name="csrf-token" content="csrf123">', { status: 200 });
      }
      if (url.endsWith('/api/v1/calendars?since=0')) {
        return jsonResponse({ calendars: [{ id: 1, name: 'Work Log' }] });
      }
      if (url.includes('/events/sync?since=0')) {
        return jsonResponse({ events: [memoEvent], chunk: false, since: 0 });
      }
      if (url.endsWith('/api/v1/calendar/1/event') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          event: {
            ...memoEvent,
            uuid: 'memo-created',
            title: body.title,
            note: body.note,
            start_at: body.start_at,
          },
        });
      }
      if (url.endsWith('/api/v1/calendar/1/event/memo1')) {
        return jsonResponse({ event: memoEvent });
      }
      return new Response('not found', { status: 404 });
    };

    const provider = makeProvider(fakeFetch);
    const calendars = await provider.listCalendars();
    expect(calendars).toEqual([{ id: '1', name: 'Work Log', writable: true }]);

    const memos = await provider.listMemos('1');
    expect(memos).toHaveLength(1);
    expect(memos[0]?.note).toContain('Worklog-ID');
    expect(await provider.getMemo('1', 'memo1')).toMatchObject({ id: 'memo1' });

    const created = await provider.createMemo('1', {
      title: 'Work Log 2026-10-26 [wl_2026-10-26_africa-accra]',
      note: 'Worklog-ID: wl_2026-10-26_africa-accra\nWorklog-Hash: abc',
      date: '2026-10-26',
    });
    expect(created.id).toBe('memo-created');

    const signIn = calls.find((call) => call.url.endsWith('/auth/email/signin'));
    expect(signIn?.method).toBe('PUT');
    expect(signIn?.body).toContain('operator@example.com');
    const create = calls.find((call) => call.method === 'POST');
    expect(create?.headers.Cookie).toContain('_session_id=session123');
    expect(create?.headers['x-csrf-token']).toBe('csrf123');
    expect(create?.body).toContain('"all_day":true');
    expect(create?.body).toContain('"category":2');
  });

  it('re-authenticates once after a rejected session', async () => {
    let calendarCalls = 0;
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session456; Path=/' } });
      }
      if (url.endsWith('/')) {
        return new Response('<meta name="csrf-token" content="csrf456">', { status: 200 });
      }
      if (url.includes('/calendars?since=0')) {
        calendarCalls += 1;
        if (calendarCalls === 1) return new Response('unauthorized', { status: 401 });
        return jsonResponse({ calendars: [{ id: 1, name: 'Work Log' }] });
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    expect(await provider.listCalendars()).toHaveLength(1);
    expect(calendarCalls).toBe(2);
  });

  it('maps HTTP 429 to a retryable rate-limit error', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) {
        return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
      }
      if (url.includes('/calendars?since=0')) return new Response('slow down', { status: 429 });
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      statusCode: 429,
      outcome: 'NOT_APPLIED',
    });
  });

  it('maps a sign-in server failure to a retryable error', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return new Response('temporarily unavailable', { status: 503 });
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      retryable: true,
      statusCode: 503,
      outcome: 'NOT_APPLIED',
    });
  });

  it('maps a changed JSON shape to a typed schema error', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) return new Response('no meta token', { status: 200 });
      if (url.includes('/calendars?since=0')) {
        return jsonResponse({ calendars: [{ id: 1, name: 42 }] });
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'UPSTREAM_SCHEMA_CHANGED',
      retryable: false,
      outcome: 'NOT_APPLIED',
    });
  });

  it('rejects an upstream response that exceeds the configured byte cap', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) return new Response('no meta token', { status: 200 });
      if (url.includes('/calendars?since=0')) {
        return new Response('x'.repeat(5_000), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch, { maxResponseBytes: 1_024 });
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'UPSTREAM_SCHEMA_CHANGED',
      retryable: false,
    });
  });

  it('maps a denied write to a non-retryable permission error', async () => {
    let postCalls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) {
        return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
      }
      if (init?.method === 'POST') {
        postCalls += 1;
        return new Response('forbidden', { status: 403 });
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(
      provider.createMemo('1', { title: 'title', note: 'note', date: '2026-10-26' }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      retryable: false,
      outcome: 'NOT_APPLIED',
    });
    expect(postCalls).toBe(2);
  });

  it('opens the circuit breaker after repeated upstream failures', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) {
        return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
      }
      if (url.includes('/calendars?since=0')) return new Response('server error', { status: 500 });
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(provider.listCalendars()).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    }
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
      retryable: true,
    });
  });

  it('maps a non-JSON or changed upstream schema to a typed error', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) return new Response('no meta token', { status: 200 });
      if (url.includes('/calendars?since=0')) return new Response('not json', { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(provider.listCalendars()).rejects.toMatchObject({
      code: 'UPSTREAM_SCHEMA_CHANGED',
      outcome: 'NOT_APPLIED',
    });
  });

  it('refuses to write when no CSRF token is available', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) return new Response('<html>no token</html>', { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(
      provider.createMemo('1', { title: 'title', note: 'note', date: '2026-10-26' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', outcome: 'NOT_APPLIED' });
  });

  it('classifies a network timeout on a write as an unknown outcome', async () => {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) {
        return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
      }
      if (init?.method === 'POST') {
        throw new DOMException('The operation timed out', 'TimeoutError');
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(
      provider.createMemo('1', { title: 'title', note: 'note', date: '2026-10-26' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', outcome: 'UNKNOWN', retryable: true });
  });

  it('does not retry a write after a server error', async () => {
    let postCalls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({}, { headers: { 'set-cookie': '_session_id=session; Path=/' } });
      }
      if (url.endsWith('/')) {
        return new Response('<meta name="csrf-token" content="csrf">', { status: 200 });
      }
      if (init?.method === 'POST') {
        postCalls += 1;
        return new Response('server error', { status: 502 });
      }
      return new Response('not found', { status: 404 });
    };
    const provider = makeProvider(fakeFetch);
    await expect(
      provider.createMemo('1', { title: 'title', note: 'note', date: '2026-10-26' }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(postCalls).toBe(1);
  });
});
