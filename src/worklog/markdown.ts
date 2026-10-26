import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { sha256 } from '../ids.js';
import { longDate } from '../time.js';
import type {
  Blocker,
  Decision,
  Evidence,
  NextAction,
  NormalizedWorklog,
  Task,
  WorklogDocument,
  WorklogSyncState,
} from './schema.js';

export interface MarkdownMetadata {
  revision: number;
  createdAt: string;
  updatedAt: string;
  sync: WorklogSyncState;
}

function listOrEmpty(lines: string[]): string {
  return lines.length ? lines.join('\n') : '_None recorded._';
}

function attributionSuffix(source: 'user' | 'evidence', evidenceIds: string[]): string {
  const parts = [source === 'evidence' ? 'evidence-linked' : 'user-reported'];
  if (evidenceIds.length) parts.push(`evidence: ${evidenceIds.join(', ')}`);
  return ` _(${parts.join('; ')})_`;
}

function taskLine(task: Task): string {
  const details = task.details ? `\n  - ${task.details.replace(/\n/g, '\n    ')}` : '';
  return `- ${task.description}${details}${attributionSuffix(task.source, task.evidenceIds)}`;
}

function blockerLine(blocker: Blocker): string {
  const parts = [blocker.description];
  if (blocker.impact) parts.push(`Impact: ${blocker.impact}`);
  if (blocker.mitigation) parts.push(`Mitigation: ${blocker.mitigation}`);
  return `- ${parts.join(' — ')}${attributionSuffix(blocker.source, blocker.evidenceIds)}`;
}

function decisionLine(decision: Decision): string {
  return `- ${decision.decision}${decision.rationale ? ` — ${decision.rationale}` : ''}${attributionSuffix(decision.source, decision.evidenceIds)}`;
}

function nextActionLine(action: NextAction): string {
  const meta = [
    action.owner ? `Owner: ${action.owner}` : '',
    action.dueDate ? `Due: ${action.dueDate}` : '',
  ].filter(Boolean);
  return `- ${action.action}${meta.length ? ` (${meta.join('; ')})` : ''}${attributionSuffix(action.source, action.evidenceIds)}`;
}

function evidenceLine(evidence: Evidence): string {
  const status = evidence.verified ? 'verified' : 'reported';
  const description = evidence.description ? ` — ${evidence.description}` : '';
  return `- [${status}] **${evidence.id}** (${evidence.kind}): ${evidence.reference}${description}`;
}

export function renderWorklogMarkdown(
  worklog: NormalizedWorklog,
  metadata: MarkdownMetadata,
): string {
  const frontMatter = {
    worklog_id: worklog.worklogId,
    date: worklog.date,
    timezone: worklog.timezone,
    title: worklog.title,
    revision: metadata.revision,
    content_hash: worklog.contentHash,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
    sync: {
      state: metadata.sync.state,
      calendar_id: metadata.sync.calendarId ?? null,
      memo_id: metadata.sync.memoId ?? null,
      remote_title: metadata.sync.remoteTitle ?? null,
      remote_hash: metadata.sync.remoteHash ?? null,
      published_at: metadata.sync.publishedAt ?? null,
      verified_at: metadata.sync.verifiedAt ?? null,
      last_error_code: metadata.sync.lastErrorCode ?? null,
      last_error_message: metadata.sync.lastErrorMessage ?? null,
      updated_at: metadata.sync.updatedAt,
    },
  };

  const body = [
    `# Daily Work Log — ${longDate(worklog.date)}`,
    '',
    `**Work log ID:** \`${worklog.worklogId}\``,
    `**Date:** ${worklog.date}`,
    `**Timezone:** ${worklog.timezone}`,
    `**Revision:** ${metadata.revision}`,
    `**Content hash:** \`${worklog.contentHash}\``,
    '',
    '## Executive summary',
    '',
    worklog.executiveSummary.trim(),
    '',
    '## Completed tasks',
    '',
    listOrEmpty(worklog.completedTasks.map(taskLine)),
    '',
    '## Work in progress',
    '',
    listOrEmpty(worklog.workInProgress.map(taskLine)),
    '',
    '## Blockers and risks',
    '',
    listOrEmpty(worklog.blockers.map(blockerLine)),
    '',
    '## Decisions made',
    '',
    listOrEmpty(worklog.decisions.map(decisionLine)),
    '',
    '## Next actions',
    '',
    listOrEmpty(worklog.nextActions.map(nextActionLine)),
    '',
    '## Evidence and source references',
    '',
    listOrEmpty(worklog.evidence.map(evidenceLine)),
    '',
  ].join('\n');

  return `---\n${stringifyYaml(frontMatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}`;
}

export function remoteMemoTitle(worklog: NormalizedWorklog): string {
  return `Work Log ${worklog.date} [${worklog.worklogId}]`;
}

export interface RemotePayload {
  title: string;
  note: string;
  truncated: boolean;
  contentHash: string;
  noteHash: string;
}

export function renderRemoteNote(
  worklog: NormalizedWorklog,
  revision: number,
  maxChars: number,
): RemotePayload {
  const header = [
    `Worklog-ID: ${worklog.worklogId}`,
    `Worklog-Date: ${worklog.date}`,
    `Worklog-Timezone: ${worklog.timezone}`,
    `Worklog-Revision: ${revision}`,
    `Worklog-Hash: ${worklog.contentHash}`,
    '',
    '',
  ].join('\n');

  const body = [
    `# ${worklog.title}`,
    '',
    '## Executive summary',
    '',
    worklog.executiveSummary.trim(),
    '',
    '## Completed tasks',
    '',
    listOrEmpty(worklog.completedTasks.map(taskLine)),
    '',
    '## Work in progress',
    '',
    listOrEmpty(worklog.workInProgress.map(taskLine)),
    '',
    '## Blockers and risks',
    '',
    listOrEmpty(worklog.blockers.map(blockerLine)),
    '',
    '## Decisions made',
    '',
    listOrEmpty(worklog.decisions.map(decisionLine)),
    '',
    '## Next actions',
    '',
    listOrEmpty(worklog.nextActions.map(nextActionLine)),
    '',
    '## Evidence and source references',
    '',
    listOrEmpty(worklog.evidence.map(evidenceLine)),
    '',
  ].join('\n');

  const full = `${header}${body}`;
  let note = full;
  let truncated = false;
  if (full.length > maxChars) {
    const suffix =
      '\n\n_[Remote note truncated to the configured limit. The local Markdown archive remains complete.]_';
    // The metadata header contains the stable worklog ID and content hash used for
    // reconciliation. It must never be cut in half; truncate only the body.
    const bodyBudget = Math.max(0, maxChars - header.length - suffix.length);
    note = `${header}${body.slice(0, bodyBudget).trimEnd()}${suffix}`;
    truncated = true;
  }

  return {
    title: remoteMemoTitle(worklog),
    note,
    truncated,
    contentHash: worklog.contentHash,
    noteHash: sha256(note),
  };
}

export interface ParsedMarkdown {
  frontMatter: Record<string, unknown>;
  body: string;
  markdown: string;
}

export function extractFrontMatter(markdown: string): ParsedMarkdown {
  if (!markdown.startsWith('---\n')) {
    return { frontMatter: {}, body: markdown, markdown };
  }
  const end = markdown.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontMatter: {}, body: markdown, markdown };
  }
  const raw = markdown.slice(4, end);
  const body = markdown.slice(end + 5);
  const parsed = parseYaml(raw);
  return {
    frontMatter: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
    body,
    markdown,
  };
}

export function worklogToDocument(
  worklog: NormalizedWorklog,
  metadata: MarkdownMetadata,
  markdownPath: string,
): WorklogDocument {
  return {
    ...worklog,
    revision: metadata.revision,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    markdown: renderWorklogMarkdown(worklog, metadata),
    markdownPath,
    sync: metadata.sync,
  };
}
