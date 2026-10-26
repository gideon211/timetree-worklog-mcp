import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { AppError } from '../../src/errors.js';
import { extractFrontMatter } from '../../src/worklog/markdown.js';
import { baseInput, makeHarness, type Harness } from '../helpers.js';

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});

afterEach(() => {
  harness.close();
});

describe('local worklog service', () => {
  it('previews without writing to the archive or database', () => {
    const preview = harness.worklogs.preview(baseInput());
    expect(preview.worklogId).toBe('wl_2026-10-26_africa-accra');
    expect(preview.markdown).toContain('## Executive summary');
    expect(preview.remote.note).toContain('Worklog-ID: wl_2026-10-26_africa-accra');
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.ledger.getByDate('2026-10-26', 'Africa/Accra')).toBeUndefined();
    expect(
      existsSync(join(harness.config.archiveDir, '2026', '10', '2026-10-26--africa-accra.md')),
    ).toBe(false);
  });

  it('saves the Markdown archive before any remote operation', () => {
    const saved = harness.worklogs.save(baseInput());
    expect(saved.created).toBe(true);
    expect(saved.unchanged).toBe(false);
    expect(saved.document.revision).toBe(1);
    expect(saved.document.sync.state).toBe('NOT_PUBLISHED');
    expect(existsSync(saved.document.markdownPath)).toBe(true);
    const markdown = readFileSync(saved.document.markdownPath, 'utf8');
    expect(markdown).toContain('wl_2026-10-26_africa-accra');
    expect(markdown).toContain('## Completed tasks');
    const parsed = extractFrontMatter(markdown);
    expect(parsed.frontMatter.revision).toBe(1);
    expect(parsed.frontMatter.content_hash).toBe(saved.document.contentHash);
    expect(harness.ledger.getById(saved.document.worklogId)?.markdown).toContain('Daily Work Log');
  });

  it('treats identical content as an idempotent save', () => {
    const first = harness.worklogs.save(baseInput());
    const second = harness.worklogs.save(baseInput());
    expect(second.created).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(second.document.revision).toBe(1);
    expect(second.document.worklogId).toBe(first.document.worklogId);
  });

  it('restores a missing Markdown archive on an identical save', () => {
    const first = harness.worklogs.save(baseInput());
    rmSync(first.document.markdownPath, { force: true });
    expect(existsSync(first.document.markdownPath)).toBe(false);

    const restored = harness.worklogs.save(baseInput());
    expect(restored.unchanged).toBe(true);
    expect(restored.document.revision).toBe(1);
    expect(existsSync(first.document.markdownPath)).toBe(true);
    expect(readFileSync(first.document.markdownPath, 'utf8')).toContain(first.document.worklogId);
  });

  it('increments the revision for changed content while keeping the worklog ID', () => {
    const first = harness.worklogs.save(baseInput());
    const second = harness.worklogs.save(
      baseInput({ executiveSummary: 'A corrected summary with an additional fact.' }),
    );
    expect(second.created).toBe(false);
    expect(second.unchanged).toBe(false);
    expect(second.document.worklogId).toBe(first.document.worklogId);
    expect(second.document.revision).toBe(2);
    expect(second.document.sync.state).toBe('NOT_PUBLISHED');
    const parsed = extractFrontMatter(readFileSync(second.document.markdownPath, 'utf8'));
    expect(parsed.frontMatter.revision).toBe(2);
  });

  it('rejects a reused idempotency key applied to different content', () => {
    harness.worklogs.save(baseInput(), 'save-1');
    expect(() =>
      harness.worklogs.save(
        baseInput({ executiveSummary: 'Different content for the same idempotency key.' }),
        'save-1',
      ),
    ).toThrowError(AppError);
  });

  it('saves locally when remote writes are disabled or TimeTree is unavailable', () => {
    harness.config.remoteWritesEnabled = false;
    const saved = harness.worklogs.save(baseInput());
    expect(saved.document.sync.state).toBe('NOT_PUBLISHED');
    expect(existsSync(saved.document.markdownPath)).toBe(true);
  });

  it('retrieves by worklog ID and by date plus timezone', () => {
    const saved = harness.worklogs.save(baseInput());
    expect(harness.worklogs.resolve({ worklogId: saved.document.worklogId }).date).toBe(
      '2026-10-26',
    );
    expect(
      harness.worklogs.resolve({ date: '2026-10-26', timezone: 'Africa/Accra' }).revision,
    ).toBe(1);
    expect(() =>
      harness.worklogs.resolve({ date: '2026-10-27', timezone: 'Africa/Accra' }),
    ).toThrowError(/No work log found/);
  });

  it('searches text, date ranges and sync states locally', () => {
    harness.worklogs.save(
      baseInput({
        date: '2026-10-25',
        executiveSummary: 'Prepared the acceptance checklist and reviewed the migration plan.',
        completedTasks: [
          { description: 'Prepared the acceptance checklist', source: 'user', evidenceIds: [] },
        ],
      }),
    );
    harness.worklogs.save(
      baseInput({
        date: '2026-10-26',
        executiveSummary: 'Implemented the local archive with Markdown and SQLite ledger.',
      }),
    );

    const text = harness.worklogs.search({ query: 'SQLite' });
    expect(text.total).toBe(1);
    expect(text.results[0]?.date).toBe('2026-10-26');
    expect(text.results[0]?.snippet).toContain('SQLite');

    const range = harness.worklogs.search({ from: '2026-10-26', to: '2026-10-26' });
    expect(range.total).toBe(1);

    const none = harness.worklogs.search({ syncState: 'PUBLISHED' });
    expect(none.total).toBe(0);

    const all = harness.worklogs.search({});
    expect(all.total).toBe(2);
  });

  it('rejects an inverted search date range', () => {
    expect(() => harness.worklogs.search({ from: '2026-10-27', to: '2026-10-26' })).toThrowError(
      /must not be after/,
    );
  });

  it('limits progress reports to a bounded date range', () => {
    expect(() => harness.worklogs.generateReport('2025-01-01', '2026-12-31')).toThrowError(
      /limited to 366 calendar days/,
    );
  });

  it('generates a report that preserves attribution and does not invent an empty period', () => {
    const saved = harness.worklogs.save(baseInput());
    const report = harness.worklogs.generateReport('2026-10-26', '2026-10-26');
    expect(report.report).toContain(saved.document.worklogId);
    expect(report.report).toContain('Daily Work Log — 2026-10-26');
    expect(report.report).toContain('user-reported');
    expect(report.report).toMatch(/No authorized live TimeTree account.*user-reported/);
    expect(report.report).toMatch(/Keep remote writes disabled by default.*user-reported/);
    expect(report.report).toMatch(/Run the gated live smoke test.*user-reported/);
    expect(report.report).toContain('[reported]');
    expect(existsSync(report.reportPath)).toBe(true);
    expect(report.reportPath.endsWith('progress-2026-10-26--2026-10-26--africa-accra.md')).toBe(
      true,
    );

    const empty = harness.worklogs.generateReport('2026-10-27', '2026-10-27');
    expect(empty.worklogCount).toBe(0);
    expect(empty.report).toContain('No work logs were recorded');
    expect(empty.report).toContain(
      'No progress, completion, decision, blocker or next action is asserted',
    );
    expect(empty.warnings).toContain('No work logs were recorded in this period.');
  });

  it('marks verified evidence separately from user-reported evidence in the report', () => {
    harness.worklogs.save(
      baseInput({
        evidence: [
          {
            id: 'ev-commit',
            kind: 'commit',
            reference: 'abc123',
            description: 'A locally reviewed commit',
            verified: true,
          },
        ],
      }),
    );
    const report = harness.worklogs.generateReport('2026-10-26', '2026-10-26');
    expect(report.report).toContain('[verified] **ev-commit**');
    expect(report.report).toContain('evidence-linked');
  });
});
