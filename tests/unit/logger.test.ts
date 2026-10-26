import { describe, expect, it } from 'vitest';
import { Logger, redactForLog, redactText } from '../../src/logger.js';

describe('redaction', () => {
  it('redacts common credentials and personal identifiers from text', () => {
    const text =
      'email a@example.com cookie _session_id=abc123 bearer Bearer abcdefghijklmnopqrstuvwxyz password: hunter2';
    const result = redactText(text);
    expect(result.value).not.toContain('a@example.com');
    expect(result.value).not.toContain('abc123');
    expect(result.value).not.toContain('hunter2');
    expect(result.matches).toContain('email');
    expect(result.matches).toContain('session cookie');
  });

  it('redacts sensitive object keys and nested messages', () => {
    const redacted = redactForLog({
      password: 'secret',
      nested: { email: 'person@example.com', note: 'worklog content' },
      error: new Error('failed with github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('worklog content');
    expect(serialized).not.toContain('github_pat_');
  });

  it('writes structured, redacted lines to the configured sink', () => {
    const lines: string[] = [];
    const logger = new Logger({ level: 'debug', write: (line) => lines.push(line) });
    logger.info('Signing in', { email: 'person@example.com', token: 'abc' });
    logger.error('Failure', { error: new Error('Bearer abcdefghijklmnopqrstuvwxyz') });
    const joined = lines.join('\n');
    expect(lines).toHaveLength(2);
    expect(joined).not.toContain('person@example.com');
    expect(joined).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz');
    expect(joined).not.toContain('"abc"');
  });
});
