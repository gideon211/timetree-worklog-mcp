import { describe, expect, it } from 'vitest';
import { normalizeWorklog, findSecretWarnings } from '../../src/worklog/validate.js';
import { baseInput } from '../helpers.js';

describe('worklog validation', () => {
  it('normalizes a valid work log and produces a stable identifier', () => {
    const result = normalizeWorklog(baseInput(), 'Africa/Accra');
    expect(result.worklog.worklogId).toBe('wl_2026-10-26_africa-accra');
    expect(result.worklog.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.warnings).toEqual([]);
    expect(result.secretWarnings).toEqual([]);
  });

  it('rejects an impossible calendar date', () => {
    expect(() => normalizeWorklog(baseInput({ date: '2026-02-30' }), 'Africa/Accra')).toThrow(
      /real calendar date/,
    );
  });

  it('rejects an invalid time zone', () => {
    expect(() => normalizeWorklog(baseInput({ timezone: 'Not/AZone' }), 'Africa/Accra')).toThrow();
  });

  it('rejects unknown fields instead of silently dropping them', () => {
    expect(() =>
      normalizeWorklog({ ...baseInput(), unexpected: 'value' } as never, 'Africa/Accra'),
    ).toThrow();
  });

  it('rejects duplicate evidence ids', () => {
    expect(() =>
      normalizeWorklog(
        baseInput({
          evidence: [
            { id: 'e1', kind: 'file', reference: 'a', verified: false },
            { id: 'e1', kind: 'file', reference: 'b', verified: false },
          ],
          completedTasks: [],
        }),
        'Africa/Accra',
      ),
    ).toThrow(/Duplicate evidence id/);
  });

  it('rejects references to evidence that does not exist', () => {
    expect(() =>
      normalizeWorklog(
        baseInput({
          completedTasks: [{ description: 'A task', source: 'evidence', evidenceIds: ['missing'] }],
        }),
        'Africa/Accra',
      ),
    ).toThrow(/unknown evidence id/);
  });

  it('rejects evidence-linked items with no evidence ids', () => {
    expect(() =>
      normalizeWorklog(
        baseInput({
          completedTasks: [{ description: 'A task', source: 'evidence', evidenceIds: [] }],
        }),
        'Africa/Accra',
      ),
    ).toThrow(/no evidence ids/);
  });

  it('warns about empty task sections and next-action dates before the work-log date', () => {
    const result = normalizeWorklog(
      baseInput({
        completedTasks: [],
        workInProgress: [],
        nextActions: [
          { action: 'Something', dueDate: '2026-10-20', source: 'user', evidenceIds: [] },
        ],
      }),
      'Africa/Accra',
    );
    expect(result.warnings.join(' ')).toMatch(/No completed tasks/);
    expect(result.warnings.join(' ')).toMatch(/before the work-log date/);
  });

  it('detects common secret material without returning the secret value', () => {
    const token = `github_pat_${'a'.repeat(30)}`;
    const input = baseInput({ executiveSummary: `Token found: ${token}` });
    const warnings = findSecretWarnings(input);
    expect(warnings.map((warning) => warning.label)).toContain('GitHub token');
    expect(JSON.stringify(warnings)).not.toContain(token);
  });
});
