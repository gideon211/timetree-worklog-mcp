import { AppError } from '../errors.js';
import { contentHash } from '../ids.js';
import { assertTimeZone, localDate } from '../time.js';
import { WorklogInputSchema, type NormalizedWorklog, type WorklogInput } from './schema.js';
import { makeWorklogId } from '../ids.js';

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/ },
  { label: 'password assignment', pattern: /\bpassword\s*[:=]\s*\S{6,}/i },
  { label: 'session cookie', pattern: /_session_id=[^;\s]+/i },
];

export interface SecretWarning {
  label: string;
  location: string;
}

export interface ValidationResult {
  worklog: NormalizedWorklog;
  warnings: string[];
  secretWarnings: SecretWarning[];
}

function collectStrings(
  value: unknown,
  path: string,
  results: Array<{ path: string; text: string }>,
): void {
  if (typeof value === 'string') {
    results.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, results));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collectStrings(nested, path ? `${path}.${key}` : key, results);
    }
  }
}

export function findSecretWarnings(input: WorklogInput): SecretWarning[] {
  const strings: Array<{ path: string; text: string }> = [];
  collectStrings(input, '', strings);
  const warnings: SecretWarning[] = [];
  for (const item of strings) {
    for (const detector of SECRET_PATTERNS) {
      if (detector.pattern.test(item.text)) {
        warnings.push({ label: detector.label, location: item.path || 'worklog' });
      }
    }
  }
  return warnings;
}

function assertEvidenceReferences(input: WorklogInput): void {
  const evidenceIds = new Set<string>();
  for (const evidence of input.evidence) {
    if (evidenceIds.has(evidence.id)) {
      throw new AppError('INVALID_INPUT', `Duplicate evidence id "${evidence.id}"`);
    }
    evidenceIds.add(evidence.id);
  }

  const groups: Array<{ label: string; items: Array<{ source: string; evidenceIds: string[] }> }> =
    [
      { label: 'completed task', items: input.completedTasks },
      { label: 'work in progress', items: input.workInProgress },
      { label: 'blocker', items: input.blockers },
      { label: 'decision', items: input.decisions },
      { label: 'next action', items: input.nextActions },
    ];

  for (const group of groups) {
    for (const item of group.items) {
      for (const id of item.evidenceIds) {
        if (!evidenceIds.has(id)) {
          throw new AppError(
            'INVALID_INPUT',
            `A ${group.label} references unknown evidence id "${id}"`,
          );
        }
      }
      if (item.source === 'evidence' && item.evidenceIds.length === 0) {
        throw new AppError(
          'INVALID_INPUT',
          `A ${group.label} is marked as evidence-linked but has no evidence ids`,
        );
      }
    }
  }
}

export function normalizeWorklog(input: WorklogInput, defaultTimezone: string): ValidationResult {
  const parsed = WorklogInputSchema.parse(input);
  const timezone = assertTimeZone(parsed.timezone ?? defaultTimezone);
  assertEvidenceReferences(parsed);

  const worklogId = makeWorklogId(parsed.date, timezone);
  const title = parsed.title ?? `Daily Work Log — ${parsed.date}`;
  const content = {
    date: parsed.date,
    timezone,
    title,
    executiveSummary: parsed.executiveSummary,
    completedTasks: parsed.completedTasks,
    workInProgress: parsed.workInProgress,
    blockers: parsed.blockers,
    decisions: parsed.decisions,
    nextActions: parsed.nextActions,
    evidence: parsed.evidence,
  };

  const warnings: string[] = [];
  if (parsed.completedTasks.length === 0 && parsed.workInProgress.length === 0) {
    warnings.push('No completed tasks or work in progress were provided.');
  }
  if (parsed.nextActions.some((action) => action.dueDate && action.dueDate < parsed.date)) {
    warnings.push('A next action has a due date before the work-log date.');
  }
  if (parsed.evidence.some((evidence) => evidence.verified)) {
    warnings.push(
      'At least one evidence item is marked verified. Ensure that verification was actually performed.',
    );
  }

  return {
    worklog: {
      worklogId,
      ...content,
      contentHash: contentHash(content),
    },
    warnings,
    secretWarnings: findSecretWarnings(parsed),
  };
}

export function todayInZone(timeZone: string): string {
  return localDate(timeZone);
}
