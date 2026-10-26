import type {
  CreateMemoInput,
  ProviderCalendar,
  ProviderErrorCode,
  ProviderHealth,
  ProviderMemo,
  ProviderOutcome,
  TimeTreeProvider,
} from './provider.js';
import { ProviderError } from './provider.js';

export type MockOperation = 'listCalendars' | 'listMemos' | 'getMemo' | 'createMemo';

export interface MockFailure {
  operation: MockOperation;
  code: ProviderErrorCode;
  message?: string;
  retryable?: boolean;
  outcome?: ProviderOutcome;
  /** For createMemo failures with outcome UNKNOWN, apply the write before throwing. */
  applyBeforeThrow?: boolean;
  /** Number of times this failure should fire. Defaults to one. */
  times?: number;
}

export interface MockProviderOptions {
  calendars?: ProviderCalendar[];
  memos?: ProviderMemo[];
  failures?: MockFailure[];
}

interface FailureState extends MockFailure {
  remaining: number;
}

export class MockTimeTreeProvider implements TimeTreeProvider {
  readonly name = 'mock';
  private calendars: ProviderCalendar[];
  private memos: ProviderMemo[];
  private failures: FailureState[];
  private counter = 0;
  readonly calls: Record<MockOperation, number> = {
    listCalendars: 0,
    listMemos: 0,
    getMemo: 0,
    createMemo: 0,
  };

  constructor(options: MockProviderOptions = {}) {
    this.calendars = structuredClone(
      options.calendars ?? [{ id: 'cal_worklog', name: 'Work Log', writable: true }],
    );
    this.memos = structuredClone(options.memos ?? []);
    this.failures = (options.failures ?? []).map((failure) => ({
      ...failure,
      remaining: failure.times ?? 1,
    }));
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const failure = this.consumeFailure('listCalendars');
    if (failure) throw this.failureToError(failure);
    return structuredClone(this.calendars);
  }

  async listMemos(calendarId: string): Promise<ProviderMemo[]> {
    const failure = this.consumeFailure('listMemos');
    if (failure) throw this.failureToError(failure);
    if (!this.calendars.some((calendar) => calendar.id === calendarId)) {
      throw new ProviderError('CALENDAR_NOT_FOUND', `No calendar ${calendarId}`);
    }
    return structuredClone(this.memos.filter((memo) => memo.calendarId === calendarId));
  }

  async getMemo(calendarId: string, memoId: string): Promise<ProviderMemo> {
    const failure = this.consumeFailure('getMemo');
    if (failure) throw this.failureToError(failure);
    const memo = this.memos.find(
      (candidate) => candidate.calendarId === calendarId && candidate.id === memoId,
    );
    if (!memo) {
      throw new ProviderError('MEMO_NOT_FOUND', `No memo ${memoId} in calendar ${calendarId}`);
    }
    return structuredClone(memo);
  }

  async createMemo(calendarId: string, input: CreateMemoInput): Promise<ProviderMemo> {
    const failure = this.consumeFailure('createMemo');
    if (failure?.outcome === 'UNKNOWN' && failure.applyBeforeThrow) {
      this.writeMemo(calendarId, input);
    }
    if (failure) {
      throw this.failureToError(failure);
    }
    return structuredClone(this.writeMemo(calendarId, input));
  }

  async health(): Promise<ProviderHealth> {
    return { status: 'ok' };
  }

  addFailure(failure: MockFailure): void {
    this.failures.push({ ...failure, remaining: failure.times ?? 1 });
  }

  seedMemo(memo: ProviderMemo): void {
    this.memos.push(structuredClone(memo));
  }

  memosFor(calendarId: string): ProviderMemo[] {
    return structuredClone(this.memos.filter((memo) => memo.calendarId === calendarId));
  }

  reset(): void {
    this.memos = [];
    this.failures = [];
    this.counter = 0;
    this.calls.listCalendars = 0;
    this.calls.listMemos = 0;
    this.calls.getMemo = 0;
    this.calls.createMemo = 0;
  }

  private writeMemo(calendarId: string, input: CreateMemoInput): ProviderMemo {
    if (!this.calendars.some((calendar) => calendar.id === calendarId)) {
      throw new ProviderError('CALENDAR_NOT_FOUND', `No calendar ${calendarId}`);
    }
    if (!input.title.trim() || !input.note.trim()) {
      throw new ProviderError('VALIDATION_ERROR', 'A memo requires a title and note');
    }
    this.counter += 1;
    const memo: ProviderMemo = {
      id: `memo_${String(this.counter).padStart(4, '0')}`,
      calendarId,
      title: input.title,
      note: input.note,
      date: input.date,
      updatedAt: new Date().toISOString(),
    };
    this.memos.push(memo);
    return memo;
  }

  private consumeFailure(operation: MockOperation): FailureState | undefined {
    this.calls[operation] += 1;
    const index = this.failures.findIndex(
      (failure) => failure.operation === operation && failure.remaining > 0,
    );
    if (index === -1) return undefined;
    const failure = this.failures[index]!;
    failure.remaining -= 1;
    return failure;
  }

  private failureToError(failure: MockFailure): ProviderError {
    return new ProviderError(failure.code, failure.message ?? `Mock ${failure.code} failure`, {
      retryable: failure.retryable ?? false,
      outcome: failure.outcome ?? 'NOT_APPLIED',
    });
  }
}
