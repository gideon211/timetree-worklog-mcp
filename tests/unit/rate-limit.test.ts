import { describe, expect, it } from 'vitest';
import { backoffMs, CircuitBreaker } from '../../src/providers/timetree/rate-limit.js';

describe('provider protection primitives', () => {
  it('opens after the configured failure threshold and resets on success', () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);
    expect(() => breaker.assertClosed()).toThrowError(/circuit breaker/i);
    breaker.recordSuccess();
    expect(breaker.isOpen).toBe(false);
    expect(() => breaker.assertClosed()).not.toThrow();
  });

  it('keeps exponential backoff bounded', () => {
    const first = backoffMs(1);
    expect(first).toBeGreaterThanOrEqual(210);
    expect(first).toBeLessThanOrEqual(390);
    expect(backoffMs(100)).toBeLessThanOrEqual(4_000);
  });
});
