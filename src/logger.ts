export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /(password|passwd|secret|token|csrf|cookie|session|authorization|api[_-]?key|email|uid|content|body|note|title|description|reference|markdown|prompt|worklog)/i;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_RE = /(_session_id=)[^;\s]+/gi;
const CSRF_RE = /(x-csrf-token\s*[:=]\s*)[^\s,;}]+/gi;
const PASSWORD_RE = /\b(password|passwd|pwd)\s*[:=]\s*[^\s,;]+/gi;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]+/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export interface RedactionResult {
  value: string;
  matches: string[];
}

export function redactText(input: string): RedactionResult {
  const matches: string[] = [];
  const remember = (label: string) => {
    if (!matches.includes(label)) matches.push(label);
  };

  let value = input;
  const replacements: Array<[RegExp, string, string]> = [
    [EMAIL_RE, '[redacted-email]', 'email'],
    [BEARER_RE, 'Bearer [redacted]', 'bearer token'],
    [COOKIE_RE, '$1[redacted]', 'session cookie'],
    [CSRF_RE, '$1[redacted]', 'csrf token'],
    [PASSWORD_RE, '$1=[redacted]', 'password'],
    [GITHUB_PAT_RE, '[redacted-github-token]', 'github token'],
    [OPENAI_KEY_RE, '[redacted-api-key]', 'api key'],
    [AWS_KEY_RE, '[redacted-aws-key]', 'aws key'],
    [PRIVATE_KEY_RE, '[redacted-private-key]', 'private key'],
  ];

  for (const [pattern, replacement, label] of replacements) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      remember(label);
      pattern.lastIndex = 0;
      value = value.replace(pattern, replacement);
    }
  }

  return { value, matches };
}

export function redactForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value).value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      message: redactText(value.message).value,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, seen));

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactForLog(nested, seen);
  }
  seen.delete(value);
  return result;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly write: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.write =
      options.write ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      });
  }

  private enabled(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.enabled(level)) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: redactText(message).value,
    };
    if (meta !== undefined) entry.meta = redactForLog(meta);
    this.write(JSON.stringify(entry));
  }

  debug(message: string, meta?: unknown): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.log('error', message, meta);
  }
}

export const logger = new Logger({
  level: (process.env.WORKLOG_LOG_LEVEL as LogLevel | undefined) ?? 'info',
});
