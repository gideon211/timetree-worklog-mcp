# timetree-worklog-mcp

A local-first MCP server for daily work logs, completed work, progress reports, and optional
TimeTree memo publication.

The local Markdown archive is the canonical durable record. A transactional SQLite ledger indexes it
for retrieval, search, revisions, and sync state. Every work log is saved
locally before any remote operation. TimeTree synchronization is optional, disabled by default, and
never treated as successful until the created memo has been read back and verified.

> **Project status:** local storage, validation, reports, MCP transport, mock-provider
> synchronization, reconciliation, and failure recovery are covered by automated tests. **Live
> TimeTree integration has not been verified against an authorized account in this repository.**
> Do not claim that live publication works until the gated procedure in
> [docs/LIVE_TIMETREE_VERIFICATION.md](docs/LIVE_TIMETREE_VERIFICATION.md) has been completed.

## Important TimeTree notice

TimeTree's official **Connect API was discontinued in December 2023**. This project does **not**
implement a discontinued API and does not claim official TimeTree support.

The optional community provider uses the same unofficial web endpoints used by the reviewed
[`ehs208/TimeTree-MCP`](https://github.com/ehs208/TimeTree-MCP) project at commit
`3f77995f4d074364c6ffe14bb95a9d0c43a7c1d8`. The adapter here is intentionally narrow: list
calendars, list memos, read one memo, and create one memo. It is not a copy of that project's broad
tool surface, and its installer is not used.

These endpoints are undocumented, may change without notice, and may be subject to TimeTree's
terms of service. Use a private calendar you control, keep remote writes disabled until you have
reviewed the behavior, and never use the project to bypass authentication, CAPTCHA, access
controls, or rate limits.

## What this server does

- Validates and normalizes a daily work log with strict Zod schemas.
- Previews the exact local Markdown and remote memo payload before anything is saved or sent.
- Saves a canonical Markdown file and a transactional SQLite revision ledger locally.
- Retrieves and searches saved work logs without contacting TimeTree.
- Generates an attributed Markdown progress report and writes it to the local reports directory.
- Optionally publishes one saved work log as one all-day TimeTree memo in **one configured private
  calendar**.
- Reconciles before a retry, verifies every remote write by reading it back, and refuses to report
  remote success when the outcome is uncertain.

There is no delete, update, calendar-management, invite, or memo-deletion tool. The project exposes
exactly nine tools.

## Requirements

- Node.js **22.12 or newer** (Node 24 is also supported).
- npm.
- Native build tooling for `better-sqlite3` if a prebuilt binary is unavailable for your platform.
- macOS, Linux, or Windows.

The exact dependency versions are locked. `package.json` also pins install-script approvals for
`better-sqlite3`, `esbuild`, and `fsevents`; review those pins when upgrading dependencies.

The server uses stdio transport only. It does not open an HTTP port.

## Quick start with the mock provider

The mock provider is safe for local evaluation and does not contact TimeTree.

```bash
npm ci
npm run build
npm test
```

Use [examples/mock-mcp-config.json](examples/mock-mcp-config.json) as an MCP client configuration.
The example points at an absolute `dist/index.js` path that you must replace with the real path on
your machine. Then restart your MCP client and call `preview_daily_worklog` followed by
`save_worklog`.

For development without a build:

```bash
npm run dev
```

The server speaks MCP over stdin/stdout. Diagnostic logs go to stderr and are redacted.

## Optional TimeTree setup

1. Keep remote writes disabled:

   ```text
   TIMETREE_ENABLE_REMOTE_WRITES=false
   ```

2. Put `TIMETREE_EMAIL` and `TIMETREE_PASSWORD` in the MCP client's environment, preferably
   sourced from an OS credential store or a secret-injection facility. **Do not commit
   credentials.** You do not need a calendar ID for the first step.

3. Restart the MCP client and call `list_calendars`. This is a read-only call. It returns the
   calendars visible to the account. Pick the **private** calendar that should receive work-log
   memos. Do not configure a shared or public calendar.

4. Set `TIMETREE_CALENDAR_ID` to that single calendar ID. Restart the client and call
   `get_sync_status`. Check that `summary.health.status` is `ok` and that the calendar is
   configured.

5. Remain in read-only mode until you are satisfied with the local preview and mock-provider
   behavior. Remote publication requires an additional, explicit operator decision:

   ```text
   TIMETREE_ENABLE_REMOTE_WRITES=true
   ```

6. Call `preview_daily_worklog`, inspect the Markdown and `remote` note, save the work log, then
   call `publish_worklog` with the matching `previewHash` and `confirmation: "PUBLISH"`.

The publish gate requires all of the following: remote writes enabled, a configured private
calendar, a preview hash matching the current saved revision, no suspected secrets, and the literal
confirmation `PUBLISH`. If the MCP client supports its own approval prompt, that remains an
additional client-side control; the server does not rely on it.

## MCP client configuration

See:

- [examples/mock-mcp-config.json](examples/mock-mcp-config.json) — safe local evaluation.
- [examples/community-mcp-config.json](examples/community-mcp-config.json) — optional community
  TimeTree provider, writes disabled.
- [.env.example](.env.example) — environment variable reference. The server does **not** load
  `.env` files automatically; use your MCP client's environment block or export the variables in
  your shell.

MCP client configurations commonly store secrets as plaintext. If your client supports environment
injection, OS keychain integration, or a secret manager, use it instead of putting a password
directly in a checked-in JSON file.

## Configuration

| Variable                        | Default                             | Purpose                                                                |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `WORKLOG_TIMEZONE`              | `Africa/Accra`                      | Default IANA time zone for dates without an explicit timezone.         |
| `WORKLOG_DATA_DIR`              | Platform application-data directory | Base directory for the database, archive, and reports.                 |
| `WORKLOG_DB_PATH`               | `<WORKLOG_DATA_DIR>/worklog.sqlite` | SQLite ledger path. Use `:memory:` only for tests.                     |
| `WORKLOG_ARCHIVE_DIR`           | `<WORKLOG_DATA_DIR>/worklogs`       | Canonical Markdown archive.                                            |
| `WORKLOG_REPORTS_DIR`           | `<WORKLOG_DATA_DIR>/reports`        | Generated progress reports.                                            |
| `WORKLOG_LOG_LEVEL`             | `info`                              | `debug`, `info`, `warn`, or `error`. Logs go to stderr.                |
| `TIMETREE_PROVIDER`             | `community`                         | `community` or `mock`.                                                 |
| `TIMETREE_BASE_URL`             | `https://timetreeapp.com`           | Unofficial TimeTree web base URL.                                      |
| `TIMETREE_EMAIL`                | unset                               | TimeTree account email. Keep out of source control.                    |
| `TIMETREE_PASSWORD`             | unset                               | TimeTree account password. Keep out of source control.                 |
| `TIMETREE_CALENDAR_ID`          | unset                               | The single private calendar permitted for memos.                       |
| `TIMETREE_ENABLE_REMOTE_WRITES` | `false`                             | Additional explicit gate for any remote write.                         |
| `TIMETREE_MAX_RPS`              | `1`                                 | Maximum TimeTree requests per second.                                  |
| `TIMETREE_TIMEOUT_MS`           | `20000`                             | Per-request timeout.                                                   |
| `TIMETREE_MAX_RETRIES`          | `3`                                 | Retries for read-only requests only; writes are never retried blindly. |
| `TIMETREE_REMOTE_MAX_CHARS`     | `20000`                             | Maximum remote note length. The local archive is never truncated.      |
| `TIMETREE_MAX_RESPONSE_BYTES`   | `2000000`                           | Maximum accepted upstream response body.                               |

Default data directories:

- macOS: `~/Library/Application Support/timetree-worklog-mcp`
- Linux: `$XDG_DATA_HOME/timetree-worklog-mcp` or `~/.local/share/timetree-worklog-mcp`
- Windows: `%APPDATA%\timetree-worklog-mcp`

The application creates directories with best-effort `0700` permissions and files with `0600`
where the platform supports POSIX permissions.

## Tools

The MCP surface is deliberately limited to these nine tools.

| Tool                       | Local/remote      | Purpose                                                                                           |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `list_calendars`           | Remote read       | List calendars for setup. Requires credentials in community mode; does not require a calendar ID. |
| `preview_daily_worklog`    | Local read        | Validate and render the Markdown and remote payload without writing.                              |
| `save_worklog`             | Local write       | Save Markdown first, then commit the SQLite ledger transaction.                                   |
| `get_daily_worklog`        | Local read        | Retrieve by stable worklog ID or by date plus timezone.                                           |
| `search_worklogs`          | Local read        | Search text, date range, timezone, and sync state.                                                |
| `generate_progress_report` | Local write       | Build and write an attributed Markdown progress report.                                           |
| `publish_worklog`          | Remote write      | Create and verify one memo after all gates pass.                                                  |
| `get_sync_status`          | Local read        | Show counts, per-worklog state, attempts, and provider health.                                    |
| `retry_pending_sync`       | Remote read/write | Reconcile prior attempts; never performs a first publication.                                     |

Every successful tool response uses an `{ "ok": true, "data": ... }` envelope. Failures use
`{ "ok": false, "error": { "code", "message", "retryable", "details?" } }` and the MCP `isError`
flag. Unknown arguments are rejected at the schema boundary.

### Recommended workflow

1. Call `preview_daily_worklog` with the facts the user actually supplied. Do not invent dates,
   deadlines, completed work, decisions, or evidence.
2. Inspect the rendered Markdown, the remote note, and any secret warnings.
3. Call `save_worklog`. Review the returned `previewHash` if you want to publish later.
4. Call `publish_worklog` only after the operator has authorized the remote write. The
   `previewHash` must match the currently saved revision.
5. Use `get_sync_status` to inspect attempts and verification state.
6. If the work log is edited after publication, the state becomes `STALE`. Republishing is blocked
   as a `CONFLICT` because this server intentionally has no destructive update operation. Resolve the
   remote memo manually if necessary. A `publish_worklog` call then reconciles without creating a
   memo and clears the conflict if the recorded memo is gone. Inspect the calendar and call
   `publish_worklog` again only if a new memo is intended.

## Local data model

### Stable identifier

A work log has one stable identifier per date and timezone:

```text
wl_<YYYY-MM-DD>_<timezone-slug>
```

Example: `wl_2026-10-26_africa-accra`.

Revisions increment when content changes. The identifier stays stable, and prior revisions remain
in SQLite.

### Markdown

The canonical archive is Markdown with YAML front matter:

```text
<WORKLOG_ARCHIVE_DIR>/<YYYY>/<MM>/<YYYY-MM-DD>--<timezone-slug>.md
```

The front matter contains the worklog ID, date, timezone, title, revision, content hash, timestamps,
and synchronization metadata. The body contains executive summary, completed tasks, work in
progress, blockers/risks, decisions, next actions, and evidence/source references.

### SQLite

The ledger stores current worklogs, revision snapshots, synchronization state, sync attempts,
idempotency keys, remote memo references, and local events. Writes use WAL mode, foreign keys,
`busy_timeout`, and `synchronous=FULL`. The Markdown file is written atomically before the database
transaction commits; a failed transaction restores the previous archive file on a best-effort
basis.

### Remote note

A remote memo title includes the stable ID:

```text
Work Log 2026-10-26 [wl_2026-10-26_africa-accra]
```

The note begins with machine-readable metadata:

```text
Worklog-ID: wl_2026-10-26_africa-accra
Worklog-Date: 2026-10-26
Worklog-Timezone: Africa/Accra
Worklog-Revision: 1
Worklog-Hash: <sha256>
```

If the note exceeds `TIMETREE_REMOTE_MAX_CHARS`, only the body is truncated. The metadata header is
retained so reconciliation can still verify identity and content.

## Synchronization states

| State              | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `NOT_PUBLISHED`    | Saved locally and eligible for publication.                                                            |
| `PUBLISHING`       | A create attempt was durably recorded before the remote call.                                          |
| `PUBLISHED`        | A memo was read back and its ID and content hash matched.                                              |
| `FAILED_RETRYABLE` | The write failed with a retryable error and a known not-applied outcome.                               |
| `FAILED_PERMANENT` | The write failed permanently or the upstream rejected it.                                              |
| `UNCERTAIN`        | The write outcome is unknown. Never assume success or failure.                                         |
| `STALE`            | Local content changed after a remote memo was recorded or a publication was attempted.                 |
| `CONFLICT`         | A memo with this worklog ID has different content, duplicates exist, or the expected memo disappeared. |
| `BLOCKED`          | Reserved for an operator-blocked condition.                                                            |

### Uncertain writes

A timeout does **not** mean the memo was not created.

1. Do not call `publish_worklog` again.
2. Call `retry_pending_sync` with its default dry-run mode. It lists memos in the configured
   calendar and compares the stable worklog ID and content hash.
3. If a matching memo exists, the verified result is recorded as `PUBLISHED` and no duplicate is
   created.
4. If a memo with the same ID but a different hash exists, the verified result is recorded as
   `CONFLICT` and no duplicate is created.
5. If the listing finds no memo, the dry run reports what a live retry would do but does not persist
   the absence or a disappeared-memo conflict. Only a live retry persists the absence and may create
   a memo from an uncertain or publishing attempt.
6. If the listing itself fails, the state remains uncertain and no write is attempted.
7. A live retry requires `dryRun: false`, `confirmation: "RETRY"`, writes enabled, and at most 10
   work logs per call. `CONFLICT`, `FAILED_PERMANENT`, blocked states, and work logs that have never
   been published (`NOT_PUBLISHED`) are never retried by `retry_pending_sync`; a first publication
   must go through `publish_worklog` after preview. After fixing the cause of a `FAILED_PERMANENT`
   record, an explicit `publish_worklog` with a matching preview may recover it; reconciliation still
   runs first.

Reconciliation uses the upstream memo listing. If the upstream service is eventually consistent,
wait and reconcile again rather than creating a second memo.

## Testing

```bash
npm run typecheck
npm run lint
npm run format
npm test
npm run build
npm run test:coverage
npm audit
```

The automated suite uses the mock provider and temporary directories. It covers:

- invalid inputs, dates, timezones, evidence references, and secret detection;
- local save, retrieval, search, report generation, revisions, and idempotency;
- missing credentials, auth/session behavior, rate limiting, schema changes, and timeouts in the
  community adapter using a fake `fetch`;
- publish gates, duplicate prevention, uncertain pre-write and post-write timeouts, conflicts,
  restart recovery, and retry policy;
- MCP schema boundaries and a real stdio client/server round trip.

### Gated live smoke test

The live smoke test is **read-only**, requires explicit opt-in, and is not part of `npm test`:

```bash
TIMETREE_LIVE_SMOKE=1 \
TIMETREE_EMAIL="..." \
TIMETREE_PASSWORD="..." \
npm run test:live
```

It signs in, lists calendars, and prints only a summary. It does not print the password, session
cookie, CSRF token, or note contents. Add `-- --include-memos` and set
`TIMETREE_CALENDAR_ID` to also count memos in that one calendar. The full authorization, write-test,
and cleanup procedure is in
[docs/LIVE_TIMETREE_VERIFICATION.md](docs/LIVE_TIMETREE_VERIFICATION.md).

## Security and privacy

- Remote writes are disabled by default; credentials are required only for the optional community
  provider and are read only from the process environment. No credentials are written to the
  archive, database, or logs.
- Session cookies and CSRF tokens are held in memory for the provider instance only.
- Diagnostic logs go to stderr and pass through a redacting logger. Secret-like values and
  credential fields are redacted.
- Work-log content is scanned for common credential patterns. Publication is blocked if a
  suspected secret is detected, but this is a safety net, not a guarantee.
- Only the configured calendar ID is accepted. A different calendar ID is rejected before a write.
- Remote note size and upstream response size are bounded.
- Read requests use bounded retries and exponential backoff. Writes are not retried after transport,
  timeout, server, or schema failures. A write may be replayed once after a 401/403
  authentication/session rejection, which is treated as not applied; other retries are explicit and
  reconciled.
- A circuit breaker opens after repeated upstream failures.
- The project does not bypass authentication, CAPTCHA, access controls, or rate limits.
- No HTTP listener is opened. MCP is stdio only.
- Back up the data directory, protect it with OS permissions, and avoid syncing it to an
  untrusted location.

## Known limitations

- Live TimeTree publication is unverified in this repository.
- The TimeTree community endpoints are unofficial and can change or stop working.
- No memo update or delete operation is exposed. Editing a published work log results in `STALE`
  and then `CONFLICT` rather than a remote update.
- One configured calendar per server instance.
- Email/password sign-in only; no OAuth or multi-account session management.
- No attachments, checklists, attendees, reminders, or recurring memos.
- No background scheduler; all actions are MCP calls.
- Run one server process per data directory. Publication and retry calls are serialized within a
  process, but cross-process coordination is outside this project.
- Publication re-checks the local content hash after reconciliation and again after read-back. A
  local save that lands during the remote request leaves the memo representing the previous
  revision, and the state is marked `STALE` immediately.
- Progress reports are limited to 366 calendar days per request.
- Search uses SQLite FTS5 when available and falls back to `LIKE` otherwise.
- There is no automatic reindex of the SQLite ledger from the Markdown archive after database loss.
  Back up both, and treat the Markdown files as the durable record.

## Documentation

- [Architecture and invariants](docs/ARCHITECTURE.md)
- [Live TimeTree verification procedure](docs/LIVE_TIMETREE_VERIFICATION.md)
- [Implementation report](IMPLEMENTATION_REPORT.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

MIT. See [LICENSE](LICENSE). TimeTree is a trademark of its respective owner. This project is not
affiliated with or endorsed by TimeTree.
