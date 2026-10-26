import { z } from 'zod/v4';
import { assertIsoDate, assertTimeZone, isValidIsoDate } from '../time.js';

export const IsoDateSchema = z
  .string()
  .describe('Calendar date in YYYY-MM-DD form. Never infer a date the user did not provide.')
  .refine(isValidIsoDate, 'Expected a real calendar date in YYYY-MM-DD form');

export const TimeZoneSchema = z
  .string()
  .min(1)
  .describe('IANA time zone, for example Africa/Accra or Europe/London')
  .refine((value) => {
    try {
      assertTimeZone(value);
      return true;
    } catch {
      return false;
    }
  }, 'Expected a valid IANA time zone');

export const EvidenceKindSchema = z.enum([
  'commit',
  'file',
  'url',
  'message',
  'document',
  'test',
  'other',
]);

export const EvidenceSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(80)
    .describe('Stable reference key used by tasks, decisions or actions'),
  kind: EvidenceKindSchema,
  reference: z
    .string()
    .min(1)
    .max(2000)
    .describe('The actual source reference, such as a commit SHA, file path, URL or message ID'),
  description: z.string().max(2000).optional(),
  verified: z
    .boolean()
    .default(false)
    .describe(
      'True only when the reference itself has been checked. A user report alone is not verification.',
    ),
});

export const TaskSchema = z.strictObject({
  description: z.string().min(1).max(2000),
  details: z.string().max(4000).optional(),
  source: z.enum(['user', 'evidence']).default('user'),
  evidenceIds: z.array(z.string().min(1)).max(20).default([]),
});

export const BlockerSchema = z.strictObject({
  description: z.string().min(1).max(2000),
  impact: z.string().max(2000).optional(),
  mitigation: z.string().max(2000).optional(),
  source: z.enum(['user', 'evidence']).default('user'),
  evidenceIds: z.array(z.string().min(1)).max(20).default([]),
});

export const DecisionSchema = z.strictObject({
  decision: z.string().min(1).max(2000),
  rationale: z.string().max(2000).optional(),
  source: z.enum(['user', 'evidence']).default('user'),
  evidenceIds: z.array(z.string().min(1)).max(20).default([]),
});

export const NextActionSchema = z.strictObject({
  action: z.string().min(1).max(2000),
  owner: z.string().max(200).optional(),
  dueDate: IsoDateSchema.optional().describe(
    'Only include a deadline the user explicitly supplied',
  ),
  source: z.enum(['user', 'evidence']).default('user'),
  evidenceIds: z.array(z.string().min(1)).max(20).default([]),
});

export const WorklogInputSchema = z.strictObject({
  date: IsoDateSchema,
  timezone: TimeZoneSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  executiveSummary: z.string().min(1).max(5000),
  completedTasks: z.array(TaskSchema).max(200).default([]),
  workInProgress: z.array(TaskSchema).max(100).default([]),
  blockers: z.array(BlockerSchema).max(100).default([]),
  decisions: z.array(DecisionSchema).max(100).default([]),
  nextActions: z.array(NextActionSchema).max(100).default([]),
  evidence: z.array(EvidenceSchema).max(100).default([]),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Blocker = z.infer<typeof BlockerSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type WorklogInput = z.infer<typeof WorklogInputSchema>;

export interface NormalizedWorklog {
  worklogId: string;
  date: string;
  timezone: string;
  title: string;
  executiveSummary: string;
  completedTasks: Task[];
  workInProgress: Task[];
  blockers: Blocker[];
  decisions: Decision[];
  nextActions: NextAction[];
  evidence: Evidence[];
  contentHash: string;
}

export interface WorklogSyncState {
  state: SyncState;
  calendarId?: string;
  memoId?: string;
  remoteTitle?: string;
  remoteHash?: string;
  publishedAt?: string;
  verifiedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  updatedAt: string;
}

export const SyncStateSchema = z.enum([
  'NOT_PUBLISHED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED_RETRYABLE',
  'FAILED_PERMANENT',
  'UNCERTAIN',
  'STALE',
  'CONFLICT',
  'BLOCKED',
]);

export type SyncState = z.infer<typeof SyncStateSchema>;

export interface WorklogDocument extends NormalizedWorklog {
  revision: number;
  createdAt: string;
  updatedAt: string;
  markdown: string;
  markdownPath: string;
  sync: WorklogSyncState;
}

export function assertDate(value: string): void {
  assertIsoDate(value);
}
