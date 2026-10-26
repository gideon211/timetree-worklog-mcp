const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function assertIsoDate(value: string): string {
  if (!isValidIsoDate(value)) {
    throw new Error(`Invalid date "${value}"; expected a real calendar date in YYYY-MM-DD form`);
  }
  return value;
}

export function localDate(timeZone: string, now = new Date()): string {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) throw new Error(`Could not determine local date for ${timeZone}`);
  return `${year}-${month}-${day}`;
}

export function addDays(date: string, days: number): string {
  assertIsoDate(date);
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day! + days));
  return value.toISOString().slice(0, 10);
}

export function compareDates(a: string, b: string): number {
  return a.localeCompare(b);
}

export function eachDate(from: string, to: string): string[] {
  assertIsoDate(from);
  assertIsoDate(to);
  if (compareDates(from, to) > 0) throw new Error('The start date must not be after the end date');
  const result: string[] = [];
  for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) {
    result.push(date);
  }
  return result;
}

export function longDate(date: string): string {
  assertIsoDate(date);
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

export function timezoneSlug(timeZone: string): string {
  return assertTimeZone(timeZone)
    .toLowerCase()
    .replace(/\+/g, '-plus-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function nowIso(): string {
  return new Date().toISOString();
}
