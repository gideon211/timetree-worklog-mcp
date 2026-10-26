import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod/v4';
import { isValidTimeZone } from './time.js';

export type ProviderKind = 'community' | 'mock';

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  archiveDir: string;
  reportsDir: string;
  timezone: string;
  provider: ProviderKind;
  timetreeBaseUrl: string;
  timetreeEmail?: string;
  timetreePassword?: string;
  calendarId?: string;
  remoteWritesEnabled: boolean;
  maxRequestsPerSecond: number;
  requestTimeoutMs: number;
  maxRetries: number;
  remoteMaxChars: number;
  maxResponseBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const EnvSchema = z
  .object({
    WORKLOG_DATA_DIR: z.string().optional(),
    WORKLOG_DB_PATH: z.string().optional(),
    WORKLOG_ARCHIVE_DIR: z.string().optional(),
    WORKLOG_REPORTS_DIR: z.string().optional(),
    WORKLOG_TIMEZONE: z.string().default('Africa/Accra'),
    WORKLOG_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TIMETREE_PROVIDER: z.enum(['community', 'mock']).default('community'),
    TIMETREE_BASE_URL: z.string().url().default('https://timetreeapp.com'),
    TIMETREE_EMAIL: z.string().optional(),
    TIMETREE_PASSWORD: z.string().optional(),
    TIMETREE_CALENDAR_ID: z.string().optional(),
    TIMETREE_ENABLE_REMOTE_WRITES: z.string().optional(),
    TIMETREE_MAX_RPS: z.coerce.number().positive().default(1),
    TIMETREE_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    TIMETREE_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
    TIMETREE_REMOTE_MAX_CHARS: z.coerce.number().int().min(500).default(20_000),
    TIMETREE_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).default(2_000_000),
  })
  .passthrough();

function platformDataDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'timetree-worklog-mcp');
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'timetree-worklog-mcp',
    );
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'timetree-worklog-mcp',
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean value "${value}"`);
}

function ensureDir(path: string, mode = 0o700, tightenExisting = true): void {
  if (path === ':memory:') return;
  mkdirSync(path, { recursive: true, mode });
  if (!tightenExisting) return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on platforms that do not expose POSIX modes.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  if (!isValidTimeZone(parsed.WORKLOG_TIMEZONE)) {
    throw new Error(`Invalid WORKLOG_TIMEZONE: ${parsed.WORKLOG_TIMEZONE}`);
  }

  const dataDir = parsed.WORKLOG_DATA_DIR ?? platformDataDir();
  const dbPath = parsed.WORKLOG_DB_PATH ?? join(dataDir, 'worklog.sqlite');
  const archiveDir = parsed.WORKLOG_ARCHIVE_DIR ?? join(dataDir, 'worklogs');
  const reportsDir = parsed.WORKLOG_REPORTS_DIR ?? join(dataDir, 'reports');

  ensureDir(dataDir);
  // A user-supplied database path may live in a shared parent directory. Create the
  // parent if needed, but never chmod a directory this application does not own.
  if (dbPath !== ':memory:') ensureDir(dirname(dbPath), 0o700, false);
  ensureDir(archiveDir);
  ensureDir(reportsDir);

  return {
    dataDir,
    dbPath,
    archiveDir,
    reportsDir,
    timezone: parsed.WORKLOG_TIMEZONE,
    provider: parsed.TIMETREE_PROVIDER,
    timetreeBaseUrl: parsed.TIMETREE_BASE_URL.replace(/\/+$/, ''),
    ...(parsed.TIMETREE_EMAIL ? { timetreeEmail: parsed.TIMETREE_EMAIL } : {}),
    ...(parsed.TIMETREE_PASSWORD ? { timetreePassword: parsed.TIMETREE_PASSWORD } : {}),
    ...(parsed.TIMETREE_CALENDAR_ID ? { calendarId: parsed.TIMETREE_CALENDAR_ID } : {}),
    remoteWritesEnabled: parseBoolean(parsed.TIMETREE_ENABLE_REMOTE_WRITES, false),
    maxRequestsPerSecond: parsed.TIMETREE_MAX_RPS,
    requestTimeoutMs: parsed.TIMETREE_TIMEOUT_MS,
    maxRetries: parsed.TIMETREE_MAX_RETRIES,
    remoteMaxChars: parsed.TIMETREE_REMOTE_MAX_CHARS,
    maxResponseBytes: parsed.TIMETREE_MAX_RESPONSE_BYTES,
    logLevel: parsed.WORKLOG_LOG_LEVEL,
  };
}

export function assertCredentials(config: AppConfig): { email: string; password: string } {
  if (!config.timetreeEmail || !config.timetreePassword) {
    throw new Error(
      'TimeTree credentials are not configured. Set TIMETREE_EMAIL and TIMETREE_PASSWORD in the MCP client environment.',
    );
  }
  return { email: config.timetreeEmail, password: config.timetreePassword };
}

export function hasTimeTreeCredentials(config: AppConfig): boolean {
  return Boolean(config.timetreeEmail && config.timetreePassword);
}

export function isRemoteConfigured(config: AppConfig): boolean {
  return hasTimeTreeCredentials(config) && Boolean(config.calendarId);
}

export function configSummary(config: AppConfig): Record<string, unknown> {
  return {
    dataDir: config.dataDir,
    timezone: config.timezone,
    provider: config.provider,
    remoteWritesEnabled: config.remoteWritesEnabled,
    calendarConfigured: Boolean(config.calendarId),
    credentialsConfigured: Boolean(config.timetreeEmail && config.timetreePassword),
    maxRequestsPerSecond: config.maxRequestsPerSecond,
    requestTimeoutMs: config.requestTimeoutMs,
    remoteMaxChars: config.remoteMaxChars,
    maxResponseBytes: config.maxResponseBytes,
  };
}

export function createRuntimeDirs(config: AppConfig): void {
  if (config.dataDir !== ':memory:') ensureDir(config.dataDir);
  if (config.dbPath !== ':memory:') ensureDir(dirname(config.dbPath), 0o700, false);
  ensureDir(config.archiveDir);
  ensureDir(config.reportsDir);
}

export function databaseExists(config: AppConfig): boolean {
  return config.dbPath !== ':memory:' && existsSync(config.dbPath);
}
