import { ProviderError } from './provider.js';

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(requestsPerSecond: number, burst = 2) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillPerMs = Math.max(requestsPerSecond, 0.1) / 1000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      while (true) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const needed = 1 - this.tokens;
        const waitMs = Math.ceil(needed / this.refillPerMs);
        await sleep(Math.max(waitMs, 10));
      }
    } finally {
      release();
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(options: { threshold?: number; cooldownMs?: number } = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  get isOpen(): boolean {
    if (this.openedAt === undefined) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = undefined;
      this.failures = 0;
      return false;
    }
    return true;
  }

  assertClosed(): void {
    if (this.isOpen) {
      throw new ProviderError(
        'CIRCUIT_OPEN',
        'The TimeTree circuit breaker is open after repeated upstream failures',
        { retryable: true, outcome: 'NOT_APPLIED' },
      );
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffMs(attempt: number, base = 300, max = 4_000): number {
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.min(max, Math.round(exponential * (0.7 + Math.random() * 0.6)));
}
