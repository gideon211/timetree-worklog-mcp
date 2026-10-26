export type ErrorCode =
  | 'INVALID_INPUT'
  | 'WORKLOG_NOT_FOUND'
  | 'WORKLOG_CONFLICT'
  | 'LOCAL_SAVE_FAILED'
  | 'LOCAL_READ_FAILED'
  | 'DATABASE_ERROR'
  | 'REMOTE_WRITES_DISABLED'
  | 'TIMETREE_NOT_CONFIGURED'
  | 'TIMETREE_AUTH_FAILED'
  | 'TIMETREE_PERMISSION_DENIED'
  | 'TIMETREE_RATE_LIMITED'
  | 'TIMETREE_SCHEMA_CHANGED'
  | 'TIMETREE_UNAVAILABLE'
  | 'TIMETREE_CALENDAR_NOT_FOUND'
  | 'TIMETREE_CALENDAR_MISMATCH'
  | 'SYNC_UNCERTAIN'
  | 'SYNC_CONFLICT'
  | 'SYNC_NOT_RETRYABLE'
  | 'CIRCUIT_OPEN'
  | 'PREVIEW_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'SECRETS_DETECTED'
  | 'INTERNAL_ERROR';

export interface ErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: ErrorDetails; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function asAppError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError(fallbackCode, error.message, { cause: error });
  }
  return new AppError(fallbackCode, String(error));
}
