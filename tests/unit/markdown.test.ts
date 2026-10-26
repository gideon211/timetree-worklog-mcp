import { describe, expect, it } from 'vitest';
import {
  extractFrontMatter,
  remoteMemoTitle,
  renderRemoteNote,
  renderWorklogMarkdown,
} from '../../src/worklog/markdown.js';
import { normalizeWorklog } from '../../src/worklog/validate.js';
import { baseInput } from '../helpers.js';

describe('Markdown rendering', () => {
  const { worklog } = normalizeWorklog(baseInput(), 'Africa/Accra');
  const metadata = {
    revision: 1,
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
    sync: { state: 'NOT_PUBLISHED' as const, updatedAt: '2026-10-26T12:00:00.000Z' },
  };

  it('renders all required sections and parseable front matter', () => {
    const markdown = renderWorklogMarkdown(worklog, metadata);
    expect(markdown).toContain('## Executive summary');
    expect(markdown).toContain('## Completed tasks');
    expect(markdown).toContain('## Work in progress');
    expect(markdown).toContain('## Blockers and risks');
    expect(markdown).toContain('## Decisions made');
    expect(markdown).toContain('## Next actions');
    expect(markdown).toContain('## Evidence and source references');
    expect(markdown).toContain('wl_2026-10-26_africa-accra');
    expect(markdown).toContain('_(evidence-linked; evidence: ev-commit)_');
    expect(markdown).toContain('_(user-reported)_');

    const parsed = extractFrontMatter(markdown);
    expect(parsed.frontMatter.worklog_id).toBe(worklog.worklogId);
    expect(parsed.frontMatter.date).toBe('2026-10-26');
    expect(parsed.frontMatter.revision).toBe(1);
    expect(parsed.frontMatter.content_hash).toBe(worklog.contentHash);
    expect(parsed.body).toContain('Daily Work Log');
  });

  it('builds a remote memo title containing the stable worklog ID', () => {
    expect(remoteMemoTitle(worklog)).toBe('Work Log 2026-10-26 [wl_2026-10-26_africa-accra]');
  });

  it('includes worklog metadata at the start of the remote note', () => {
    const remote = renderRemoteNote(worklog, 3, 20_000);
    expect(remote.note).toContain(`Worklog-ID: ${worklog.worklogId}`);
    expect(remote.note).toContain(`Worklog-Hash: ${worklog.contentHash}`);
    expect(remote.note).toContain('Worklog-Revision: 3');
    expect(remote.truncated).toBe(false);
    expect(remote.noteHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('truncates the remote body while retaining the metadata header', () => {
    const remote = renderRemoteNote(worklog, 1, 500);
    expect(remote.truncated).toBe(true);
    expect(remote.note.length).toBeLessThanOrEqual(500);
    expect(remote.note).toContain(`Worklog-ID: ${worklog.worklogId}`);
    expect(remote.note).toContain(`Worklog-Hash: ${worklog.contentHash}`);
    expect(remote.note).toContain('Remote note truncated');
  });

  it('keeps the note within the limit even with a maximum-length title', () => {
    const { worklog: longTitleWorklog } = normalizeWorklog(
      baseInput({ title: 'T'.repeat(200) }),
      'Africa/Accra',
    );
    const remote = renderRemoteNote(longTitleWorklog, 1, 500);
    expect(remote.truncated).toBe(true);
    expect(remote.note.length).toBeLessThanOrEqual(500);
    expect(remote.note).toContain(`Worklog-ID: ${longTitleWorklog.worklogId}`);
    expect(remote.note).toContain(`Worklog-Hash: ${longTitleWorklog.contentHash}`);
  });

  it('renders evidence status as verified or reported', () => {
    const markdown = renderWorklogMarkdown(worklog, metadata);
    expect(markdown).toContain('[reported]');
    expect(markdown).not.toContain('[verified] **ev-commit**');
  });
});
