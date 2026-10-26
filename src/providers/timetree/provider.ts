export type ProviderErrorCode =
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'UPSTREAM_SCHEMA_CHANGED'
  | 'CALENDAR_NOT_FOUND'
  | 'MEMO_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CIRCUIT_OPEN'
  | 'UNCONFIGURED'
  | 'UNSUPPORTED';

export type ProviderOutcome = 'NOT_APPLIED' | 'UNKNOWN' | 'APPLIED';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly outcome: ProviderOutcome;
  readonly statusCode?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      outcome?: ProviderOutcome;
      statusCode?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.outcome = options.outcome ?? 'NOT_APPLIED';
    this.statusCode = options.statusCode;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface ProviderCalendar {
  id: string;
  name: string;
  writable: boolean;
}

export interface ProviderMemo {
  id: string;
  calendarId: string;
  title: string;
  note: string;
  date?: string;
  updatedAt?: string;
}

export interface CreateMemoInput {
  title: string;
  note: string;
  date: string;
}

export interface ProviderHealth {
  status: 'ok' | 'unconfigured' | 'incompatible' | 'blocked';
  message?: string;
}

export interface TimeTreeProvider {
  readonly name: string;
  listCalendars(): Promise<ProviderCalendar[]>;
  listMemos(calendarId: string): Promise<ProviderMemo[]>;
  getMemo(calendarId: string, memoId: string): Promise<ProviderMemo>;
  createMemo(calendarId: string, input: CreateMemoInput): Promise<ProviderMemo>;
  health(): Promise<ProviderHealth>;
}
