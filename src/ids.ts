import { createHash, randomUUID } from 'node:crypto';
import { timezoneSlug } from './time.js';

export function makeWorklogId(date: string, timeZone: string): string {
  return `wl_${date}_${timezoneSlug(timeZone)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stableStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        const nested = record[key];
        if (nested !== undefined) result[key] = normalize(nested);
      }
      return result;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function attemptId(): string {
  return `att_${randomUUID()}`;
}

export function requestFingerprint(value: unknown): string {
  return sha256(stableStringify(value));
}
