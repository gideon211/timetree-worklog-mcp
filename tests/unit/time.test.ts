import { describe, expect, it } from 'vitest';
import {
  addDays,
  eachDate,
  isValidIsoDate,
  isValidTimeZone,
  localDate,
  longDate,
  timezoneSlug,
} from '../../src/time.js';

describe('time helpers', () => {
  it('validates real ISO calendar dates', () => {
    expect(isValidIsoDate('2026-10-26')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('26-10-2026')).toBe(false);
  });

  it('derives the local date in the configured zone', () => {
    const instant = new Date('2026-10-26T23:45:00.000Z');
    expect(localDate('Africa/Accra', instant)).toBe('2026-10-26');
    expect(localDate('Pacific/Kiritimati', instant)).toBe('2026-10-27');
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone('Africa/Accra')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('not-a-zone')).toBe(false);
  });

  it('does date arithmetic without timezone drift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(eachDate('2026-10-25', '2026-10-27')).toEqual([
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
  });

  it('formats long dates and timezone slugs', () => {
    expect(longDate('2026-10-26')).toContain('Monday');
    expect(longDate('2026-10-26')).toContain('26 October 2026');
    expect(timezoneSlug('Africa/Accra')).toBe('africa-accra');
    expect(timezoneSlug('America/Argentina/Buenos_Aires')).toBe('america-argentina-buenos-aires');
    expect(timezoneSlug('Etc/GMT+5')).not.toBe(timezoneSlug('Etc/GMT-5'));
  });
});
