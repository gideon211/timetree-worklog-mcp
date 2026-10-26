# Architecture and invariants

## Components

```text
MCP client
   |
   | stdio (JSON-RPC)
   v
src/index.ts
   |-- config.ts                 environment validation and safe defaults
   |-- logger.ts                 stderr-only redacting logger
   |-- mcp/tools.ts              nine tool schemas, envelopes, annotations
   |-- worklog/service.ts        preview, save, get, search, reports
   |   |-- worklog/validate.ts   normalization, evidence checks, secret scan
   |   |-- worklog/markdown.ts   canonical Markdown and remote memo payload
   |   `-- store/ledger.ts       atomic Markdown + transactional SQLite ledger
   |-- sync/service.ts           publish gates, reconciliation, retries
   `-- providers/timetree/
       |-- provider.ts           narrow provider interface and error types
       |-- community.ts          pinned unofficial TimeTree web adapter
       |-- mock.ts               deterministic test provider
       `-- rate-limit.ts         rate limiter, backoff, circuit breaker
```

The provider interface is limited to:

```text
listCalendars()
listMemos(calendarId)
getMemo(calendarId, memoId)
createMemo(calendarId, { title, note, date })
health()
```

No update, delete, or calendar-management method exists.

## Local write path

`save_worklog` follows this order:

1. Parse and validate input with strict Zod schemas.
2. Validate evidence references and scan for suspected secrets.
3. Normalize the IANA timezone and derive the stable ID
   `wl_<date>_<timezone-slug>`.
4. Compute a canonical content hash.
5. Check the idempotency key, if supplied.
6. Write a temporary Markdown file, then atomically rename it into the archive.
7. In one SQLite transaction, update the current worklog, insert the revision snapshot, upsert
   synchronization state, update the FTS index, record the idempotency key, and append a local
   event.
8. If the transaction fails, restore the previous archive file on a best-effort basis and return an
   error.

The Markdown file is intentionally written before the database commit. The canonical local record
is recoverable from the archive and revision snapshots, and a remote call is never made in this
path.

## Stable identity and revisions

- One worklog per `(local_date, timezone)`, enforced by a database unique constraint.
- Stable ID does not change across revisions.
- Identical content is an idempotent save: revision stays the same and no database row is rewritten.
- Changed content increments the revision and stores the prior Markdown and JSON snapshot.
- A missing Markdown archive file is restored from the current revision on an identical save.
- The remote memo title always includes the stable ID.
- The remote note includes `Worklog-ID`, `Worklog-Date`, `Worklog-Timezone`, `Worklog-Revision`, and
  `Worklog-Hash`.

## Publication path

`publish_worklog` requires all gates before a remote call:

1. Remote writes enabled with `TIMETREE_ENABLE_REMOTE_WRITES=true`.
2. A configured calendar ID and, in community mode, credentials.
3. Confirmation literal `PUBLISH`.
4. A preview hash matching the current saved revision.
5. No suspected secret patterns in the work log.
6. The configured calendar exists and is writable.
7. Pre-write reconciliation succeeds.

A `FAILED_PERMANENT` record is not retried by `retry_pending_sync`, but an explicit
`publish_worklog` with a matching preview may recover it after the operator fixes the cause. The
pre-write reconciliation still runs first.

The create attempt is recorded as `IN_FLIGHT` and the state becomes `PUBLISHING` before the network
call. A provider error with outcome `UNKNOWN` or `APPLIED` becomes `UNCERTAIN`, never success.
After a create, the memo is read back and both the stable ID and content hash must match before the
state becomes `PUBLISHED`.

## Reconciliation

Reconciliation lists active memos in the configured calendar and looks for the stable worklog ID in
the note metadata or title.

| Finding                                                          | State                                    |
| ---------------------------------------------------------------- | ---------------------------------------- |
| Matching ID and matching hash                                    | `PUBLISHED`                              |
| Matching ID and different hash                                   | `CONFLICT`                               |
| No matching ID, prior `PUBLISHED`/`STALE` or a recorded memo ID  | `CONFLICT` (do not republish blindly)    |
| No matching ID, prior `CONFLICT`                                 | `NOT_PUBLISHED`                          |
| No matching ID, prior failed/uncertain/publishing without a memo | Previous failed state or `NOT_PUBLISHED` |
| Listing failure                                                  | Leave safe state and do not write        |

`retry_pending_sync` always reconciles before a live retry. Retries are limited to 10 work logs per
call. `CONFLICT` and `FAILED_PERMANENT` are skipped.

If `publish_worklog` reconciles a prior `CONFLICT` to `NOT_PUBLISHED`, it returns that state without
creating a memo. This requires a second explicit publish after the operator inspects the calendar,
which prevents a single call from turning a conflict into a new remote write.

## Sync-state transitions

```text
save new                         -> NOT_PUBLISHED
publish starts                   -> PUBLISHING
verified create                  -> PUBLISHED
known retryable failure          -> FAILED_RETRYABLE
known permanent failure          -> FAILED_PERMANENT
unknown write outcome            -> UNCERTAIN
edit after PUBLISHED/CONFLICT/PUBLISHING/UNCERTAIN -> STALE
edit after retryable/permanent failure              -> NOT_PUBLISHED (reconciled before publish)
matching ID, different hash                         -> CONFLICT
published memo disappears                           -> CONFLICT
```

An identical save does not change synchronization state. A changed save after `CONFLICT` becomes
`STALE` while retaining the memo reference so reconciliation can still detect the conflict. A changed
save after a retryable or permanent failure returns to `NOT_PUBLISHED`; publication still performs
pre-write reconciliation before creating anything.

## Storage boundaries

- **Markdown archive:** human-readable canonical record, one file per date/timezone.
- **SQLite:** current JSON, revision snapshots, sync state, attempts, idempotency, remote memo
  references, local events, and FTS index. This database is a transactional index of the canonical
  Markdown; there is no automatic reindex from Markdown after database loss. The `remote_memos`
  table is written only after verified publication. An `UNCERTAIN` sync state may retain the created
  memo ID as an unverified reconciliation candidate; it is not a publication claim.
- **Reports:** generated Markdown, not authoritative for the worklog history.
- **Memory:** credentials from process environment, session cookie, CSRF token, provider state.
- **Remote:** one memo per published revision attempt in one configured private calendar.

The SQLite database is not encrypted by this project. Protect the data directory with OS
permissions and full-disk encryption; do not place it in an untrusted sync folder.

## Provider safety

The community adapter:

- signs in with email/password and keeps `_session_id` in memory only;
- scrapes the CSRF meta tag from the TimeTree web page;
- uses `/api/v1` web endpoints reviewed at commit
  `3f77995f4d074364c6ffe14bb95a9d0c43a7c1d8` of `ehs208/TimeTree-MCP`;
- sends `X-Timetreea` and a project user agent;
- limits requests per second;
- retries reads with bounded exponential backoff, but never retries a write itself;
- opens a circuit breaker after repeated failures;
- caps upstream response bytes;
- verifies created memos by reading them back;
- treats a request timeout on a write as an unknown outcome;
- never logs credentials, cookies, or note bodies.

The official TimeTree Connect API is discontinued and is not implemented.

## MCP protocol behavior

- Transport is stdio only.
- Tool inputs use strict objects; unknown fields are rejected by the schema boundary.
- Tool outputs use `{ ok, data? , error? }` structured content plus a JSON text block.
- Failures set `isError: true`.
- `generate_progress_report` writes a local file, so its read-only annotation is intentionally
  false.
- The server exposes exactly the nine approved tools; there is no destructive calendar or memo
  operation.

## Failure model

Failures are classified by whether the remote operation might have been applied:

- `NOT_APPLIED`: safe to classify as retryable or permanent, but still reconcile before a live
  retry.
- `UNKNOWN`: state `UNCERTAIN`; no automatic create.
- `APPLIED`: treat as potentially written; reconcile and verify before any further write.

Read failures leave the local archive unchanged. Remote write failures leave the local archive and
ledger intact. Local archive write failures prevent the remote call because publishing requires a
saved local work log.
