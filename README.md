# timetree-worklog-mcp

A local-first MCP server for daily work logs, completed work, progress reports, and optional
TimeTree memo publication.

- **Nine tools.** No delete, update, calendar-management, invite, or memo-deletion operations.
- **Local-first.** The canonical record is Markdown on your machine. SQLite only indexes it.
- **Safe by default.** Remote writes are disabled until you explicitly enable them.
- **Verified writes.** Every remote create is read back and hash-checked before success is reported.

The local Markdown archive is the canonical durable record. A transactional SQLite ledger indexes it
for retrieval, search, revisions, and sync state. Every work log is saved locally before any remote
operation. TimeTree synchronization is optional, disabled by default, and never treated as
successful until the created memo has been read back and verified.

> **Project status:** local storage, validation, reports, MCP transport, mock-provider
> synchronization, reconciliation, and failure recovery are covered by automated tests. **Live
> TimeTree integration — including publication — has been verified end-to-end** against an
> authorized account using the gated write-test in
> [docs/LIVE_TIMETREE_VERIFICATION.md](docs/LIVE_TIMETREE_VERIFICATION.md). The community endpoints
> are unofficial and can change; re-verify after upstream changes.

---

## Table of contents

- [Important TimeTree notice](#important-timetree-notice)
- [Google sign-in accounts](#google-sign-in-accounts)
- [What this server does](#what-this-server-does)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start with the mock provider](#quick-start-with-the-mock-provider)
- [Connecting your TimeTree account](#connecting-your-timetree-account)
- [MCP client configuration](#mcp-client-configuration)
- [Configuration reference](#configuration-reference)
- [Tool reference](#tool-reference)
- [Daily workflows](#daily-workflows)
- [Local data model](#local-data-model)
- [Synchronization states](#synchronization-states)
- [Security and privacy](#security-and-privacy)
- [Operations and deployment](#operations-and-deployment)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)
- [License](#license)

---

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

## Google sign-in accounts

This adapter authenticates in one of two ways:

- **Email/password** — `PUT <TIMETREE_BASE_URL>/api/v1/auth/email/signin` with `uid` and `password`.
- **Session cookie** — reuse the `_session_id` cookie from a browser session. This is the path for
  accounts that sign in with **Google** and have no TimeTree password.

There is **no native Google OAuth flow**. If your account was created with "Continue with Google"
and you have never set a TimeTree password, use **session-cookie mode**:

1. Sign in to `timetreeapp.com` in your own browser with Google.
2. Open DevTools (`F12` or `Cmd+Option+I`) → **Application → Cookies →
   `https://timetreeapp.com`** and copy the **Value** of the cookie named `_session_id`. (Or, in the
   **Network** tab, open any authenticated request and copy the `_session_id=...` part of the
   `cookie:` request header.)
3. Put that value in `TIMETREE_SESSION_COOKIE`. The CSRF token is fetched automatically.

A session cookie is a **bearer credential** — anyone holding it is signed in as you. It expires, so
you will need to copy a fresh one when it stops working. Keep it out of source control and logs,
exactly like a password. When both are set, the session cookie takes precedence over
email/password.

Alternatively, if TimeTree lets you set a password on a Google-linked account (check **Account /
Settings**), you can use email/password mode instead.

The local-only tools (`preview_daily_worklog`, `save_worklog`, `get_daily_worklog`,
`search_worklogs`, `generate_progress_report`, `get_sync_status`) work with no TimeTree account at
all — only the remote read/write tools need auth.

Always keep `TIMETREE_ENABLE_REMOTE_WRITES=false` until you have read the
[security and privacy](#security-and-privacy) section and the
[gated live verification procedure](docs/LIVE_TIMETREE_VERIFICATION.md).

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

## Requirements

- Node.js **22.12 or newer** (Node 24 is also supported).
- npm.
- Native build tooling for `better-sqlite3` if a prebuilt binary is unavailable for your platform.
- macOS, Linux, or Windows.

The exact dependency versions are locked. `package.json` also pins install-script approvals for
`better-sqlite3`, `esbuild`, and `fsevents`; review those pins when upgrading dependencies.

The server uses stdio transport only. It does not open an HTTP port.

## Installation

```bash
git clone https://github.com/gideon211/timetree-worklog-mcp.git
cd timetree-worklog-mcp
npm ci
npm run build
```

Sanity checks:

```bash
npm test          # 93 tests
npm run verify    # typecheck + lint + format + test + build
npm audit         # dependency vulnerabilities
```

For development without a build:

```bash
npm run dev       # tsx src/index.ts
```

The server speaks MCP over stdin/stdout. Diagnostic logs go to stderr and are redacted.

## Quick start with the mock provider

The mock provider is safe for local evaluation and does not contact TimeTree. Start here even if
you intend to use TimeTree later.

1. Open [examples/mock-mcp-config.json](examples/mock-mcp-config.json) and replace the placeholder
   path with the absolute path to `dist/index.js` on your machine.
2. Paste the `mcpServers` block into your MCP client's configuration (see
   [MCP client configuration](#mcp-client-configuration)).
3. Restart your MCP client. It should now expose 9 tools.
4. Call `preview_daily_worklog`, then `save_worklog`, then `generate_progress_report`.

Everything in this flow is local. No credentials are required and nothing is sent anywhere.

## Connecting your TimeTree account

> Read [Google sign-in accounts](#google-sign-in-accounts) first. Use `TIMETREE_SESSION_COOKIE` for
> a Google-only account, or email/password if TimeTree has given your account a password.

### Step 1 — Start read-only

In your MCP client config, switch to the community provider. Keep writes disabled. If you signed up
with Google, use `TIMETREE_SESSION_COOKIE` instead of email/password (see
[Google sign-in accounts](#google-sign-in-accounts)):

```json
"TIMETREE_PROVIDER": "community",
"TIMETREE_EMAIL": "your-account@example.com",
"TIMETREE_PASSWORD": "<from OS keychain or secret injection, never a committed file>",
"TIMETREE_ENABLE_REMOTE_WRITES": "false"
```

Or, for a Google account:

```json
"TIMETREE_PROVIDER": "community",
"TIMETREE_SESSION_COOKIE": "<_session_id value from your browser>",
"TIMETREE_ENABLE_REMOTE_WRITES": "false"
```

Restart the client and call **`list_calendars`**. This is read-only. It returns the calendars
visible to your account.

If sign-in fails with an authentication error, your email/password pair is wrong or the account
cannot use email/password sign-in. Do not keep retrying in a loop; the provider backs off and opens
a circuit breaker after repeated failures.

### Step 2 — Choose a private calendar

From `list_calendars`, pick a **private calendar you control**. Do not use a shared, family, team,
or public calendar. Set that single ID in the config:

```json
"TIMETREE_CALENDAR_ID": "<chosen-private-calendar-id>"
```

Restart the client and call **`get_sync_status`**. Confirm `summary.health.status` is `ok` and the
calendar is configured.

### Step 3 — Preview and save locally

Call `preview_daily_worklog`, inspect the rendered Markdown **and** the `remote` note payload, then
call `save_worklog`. Keep the returned `previewHash`.

### Step 4 — Enable writes and publish

Only now flip the gate:

```json
"TIMETREE_ENABLE_REMOTE_WRITES": "true"
```

Call `publish_worklog` with the `previewHash` from the current saved revision and
`confirmation: "PUBLISH"`.

All of these must be true or the call refuses:

- Remote writes are enabled.
- A single private calendar is configured and exists for this account.
- The preview hash matches the current saved revision.
- No suspected secret patterns are detected in the content.
- The confirmation literal is exactly `PUBLISH`.

After creating the memo, the server reads it back, compares the stable work-log ID and the content
hash, and only then reports `PUBLISHED`. If it cannot verify, it reports `UNCERTAIN` and never
claims success.

### Live verification before trusting it

Because the endpoints are unofficial and unverified in this repo, run the gated procedure in
[docs/LIVE_TIMETREE_VERIFICATION.md](docs/LIVE_TIMETREE_VERIFICATION.md) with a dedicated private
test calendar and synthetic content before relying on live publication.

## MCP client configuration

The server does **not** auto-load `.env` files. Configuration comes only from the environment block
in the client config, or from exported shell variables. Use [.env.example](.env.example) as a
variable reference.

Client config locations (create or merge the `mcpServers` block):

- **Claude Desktop:** `claude_desktop_config.json`
- **Cursor / Windsurf / VS Code-style clients:** their `mcp.json` or equivalent
- **Generic:** any client that launches an MCP server as a child process over stdio

Examples:

- [examples/mock-mcp-config.json](examples/mock-mcp-config.json) — safe local evaluation.
- [examples/community-mcp-config.json](examples/community-mcp-config.json) — community provider with
  email/password, writes disabled.
- [examples/community-session-mcp-config.json](examples/community-session-mcp-config.json) —
  community provider using a browser session cookie (Google sign-in), writes disabled.

MCP client configurations commonly store secrets as plaintext. If your client supports environment
injection, OS keychain integration, or a secret manager, use that instead of putting a password
directly in a checked-in JSON file.

## Configuration reference

| Variable                        | Default                             | Purpose                                                                        |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `WORKLOG_TIMEZONE`              | `Africa/Accra`                      | Default IANA time zone for dates without an explicit timezone.                 |
| `WORKLOG_DATA_DIR`              | Platform application-data directory | Base directory for the database, archive, and reports.                         |
| `WORKLOG_DB_PATH`               | `<WORKLOG_DATA_DIR>/worklog.sqlite` | SQLite ledger path. Use `:memory:` only for tests.                             |
| `WORKLOG_ARCHIVE_DIR`           | `<WORKLOG_DATA_DIR>/worklogs`       | Canonical Markdown archive.                                                    |
| `WORKLOG_REPORTS_DIR`           | `<WORKLOG_DATA_DIR>/reports`        | Generated progress reports.                                                    |
| `WORKLOG_LOG_LEVEL`             | `info`                              | `debug`, `info`, `warn`, or `error`. Logs go to stderr.                        |
| `TIMETREE_PROVIDER`             | `community`                         | `community` or `mock`.                                                         |
| `TIMETREE_BASE_URL`             | `https://timetreeapp.com`           | Unofficial TimeTree web base URL.                                              |
| `TIMETREE_EMAIL`                | unset                               | TimeTree account email. Keep out of source control.                            |
| `TIMETREE_PASSWORD`             | unset                               | TimeTree account password. Keep out of source control.                         |
| `TIMETREE_SESSION_COOKIE`       | unset                               | Alt. auth: a browser `_session_id` cookie (Google sign-in). Bearer credential. |
| `TIMETREE_CALENDAR_ID`          | unset                               | The single private calendar permitted for memos.                               |
| `TIMETREE_ENABLE_REMOTE_WRITES` | `false`                             | Additional explicit gate for any remote write.                                 |
| `TIMETREE_MAX_RPS`              | `1`                                 | Maximum TimeTree requests per second.                                          |
| `TIMETREE_TIMEOUT_MS`           | `20000`                             | Per-request timeout.                                                           |
| `TIMETREE_MAX_RETRIES`          | `3`                                 | Retries for read-only requests only; writes are never retried blindly.         |
| `TIMETREE_REMOTE_MAX_CHARS`     | `20000`                             | Maximum remote note length. The local archive is never truncated.              |
| `TIMETREE_MAX_RESPONSE_BYTES`   | `2000000`                           | Maximum accepted upstream response body.                                       |

Default data directories:

- macOS: `~/Library/Application Support/timetree-worklog-mcp`
- Linux: `$XDG_DATA_HOME/timetree-worklog-mcp` or `~/.local/share/timetree-worklog-mcp`
- Windows: `%APPDATA%\timetree-worklog-mcp`

The application creates directories with best-effort `0700` permissions and files with `0600`
where the platform supports POSIX permissions.

## Tool reference

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

## Daily workflows

### Record a day's work

1. `preview_daily_worklog` — supply the facts the user actually provided. Do not invent dates,
   deadlines, completed work, decisions, or evidence.
2. Inspect the rendered Markdown, the remote note, and any secret warnings.
3. `save_worklog` — writes the local record. Keep the `previewHash` if you may publish later.
4. `get_daily_worklog` — verify the saved revision when needed.
5. `generate_progress_report` — build an attributed report over a date range (max 366 days).

### Publish to TimeTree

1. `preview_daily_worklog` — inspect the `remote` payload.
2. `save_worklog` — ensure the revision matches the preview.
3. `publish_worklog` — pass the matching `previewHash` and `confirmation: "PUBLISH"`.

### Check and repair synchronization

1. `get_sync_status` — inspect counts, per-log state, attempts, and provider health.
2. `retry_pending_sync` — defaults to a dry run that only lists what would happen.
3. For a live retry, set `dryRun: false` and `confirmation: "RETRY"` (max 10 logs per call).

### After editing a published log

If the work log is edited after publication, the state becomes `STALE`. Republishing is blocked as a
`CONFLICT` because this server intentionally has no destructive update operation. Resolve the remote
memo manually if necessary. A `publish_worklog` call then reconciles without creating a memo and
clears the conflict if the recorded memo is gone. Inspect the calendar and call `publish_worklog`
again only if a new memo is intended.

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
   calendar and compares the stable work-log ID and content hash.
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

## Operations and deployment

### Running as a service

The server is a stdio child process, not a daemon. It runs under whatever MCP client launches it.
To run it yourself for debugging:

```bash
npm start              # node dist/index.js
```

It will block on stdin waiting for MCP messages. Logs go to stderr.

### Backups

Back up the **entire data directory**, which contains the Markdown archive, the SQLite database, and
generated reports. The Markdown files are the durable record; the database is an index and ledger.
There is no automatic reindex from Markdown after database loss, so losing the database without a
backup means losing search, revision history, and sync state even though the Markdown files survive.

### Upgrades

```bash
git pull
npm ci
npm run verify
npm run build
```

Review the dependency lockfile diff and the `allowScripts` pins before accepting upgrades.

### One process per data directory

Publication and retry calls are serialized within one process. Multiple server processes sharing a
database are not coordinated. Run one instance per data directory.

## Troubleshooting

**Sign-in fails with an authentication error.**
Your email/password pair is wrong, or the account cannot use email/password sign-in (for example, a
Google-only account). See [Google sign-in accounts](#google-sign-in-accounts). The adapter backs off
and opens a circuit breaker after repeated failures, so do not retry in a loop.

**Sign-in fails with a permission or 403 error.**
TimeTree blocked the sign-in. Do not attempt to bypass it. This project will not circumvent access
controls, CAPTCHA, or rate limits.

**`list_calendars` fails but local tools work.**
Expected when credentials are missing or wrong. All local tools work with no TimeTree account. Only
the remote read/write tools need credentials.

**`publish_worklog` returns `PREVIEW_REQUIRED`.**
The saved revision changed after you previewed it, or it changed while publication was being
prepared. Run `preview_daily_worklog` again, review, save, and use the new hash.

**A publish returned `UNCERTAIN`.**
Do not publish again. Follow [Uncertain writes](#uncertain-writes). The server reconciles before any
retry so it never creates a duplicate.

**`get_sync_status` shows `CONFLICT`.**
A remote memo exists with different content, duplicates exist, or the expected memo disappeared.
Resolve it manually in the calendar, then use an explicit `publish_worklog` to reconcile and clear.

**The remote note is truncated.**
Only the body is truncated, and only when it exceeds `TIMETREE_REMOTE_MAX_CHARS`. The metadata header
is always retained. The local archive is never truncated.

**Server does not appear in the MCP client.**
Confirm the `command` is `node` and `args[0]` is the absolute path to `dist/index.js`, then restart
the client. Check that `npm run build` has been run so `dist/index.js` exists.

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

The live smoke test is **read-only**, requires explicit opt-in, and is not part of `npm test`. Use
either email/password or a session cookie (for Google-only accounts):

```bash
TIMETREE_LIVE_SMOKE=1 \
TIMETREE_EMAIL="..." \
TIMETREE_PASSWORD="..." \
npm run test:live
```

```bash
TIMETREE_LIVE_SMOKE=1 \
TIMETREE_SESSION_COOKIE="<session-value>" \
npm run test:live
```

It authenticates, lists calendars, and prints only a summary. It does not print the password, session
cookie, CSRF token, or note contents. Add `-- --include-memos` and set
`TIMETREE_CALENDAR_ID` to also count memos in that one calendar. The full authorization, write-test,
and cleanup procedure is in
[docs/LIVE_TIMETREE_VERIFICATION.md](docs/LIVE_TIMETREE_VERIFICATION.md).

### Gated live write test

Live **publication** is verified by a separate, explicitly gated script. It creates exactly one
clearly-labeled synthetic memo, verifies it by reading it back, confirms re-publication is
idempotent (no duplicate), and prints only summaries. It is not part of `npm test` and never runs
without opt-in:

```bash
TIMETREE_LIVE_WRITE=1 \
TIMETREE_SESSION_COOKIE="<session-value>" \
npx tsx tests/live/write-test.ts
```

There is no delete tool, so the single test memo must be removed manually in the TimeTree app
afterward. Do not point this at a shared, family, team, or production calendar.

## Known limitations

- Live TimeTree publication is unverified in this repository.
- The TimeTree community endpoints are unofficial and can change or stop working.
- **No native Google OAuth.** Google-only accounts must use session-cookie mode
  (`TIMETREE_SESSION_COOKIE`), which relies on a browser-captured bearer cookie that expires. No
  multi-account session management.
- No memo update or delete operation is exposed. Editing a published work log results in `STALE`
  and then `CONFLICT` rather than a remote update.
- One configured calendar per server instance.
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
