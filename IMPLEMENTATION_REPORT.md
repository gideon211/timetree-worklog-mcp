# Implementation report

## Project

- Name: `timetree-worklog-mcp`
- Repository: https://github.com/gideon211/timetree-worklog-mcp.git
- Version: `0.1.0`
- Date: 2026-10-26
- Runtime: Node.js 22.12+ (Node 24 supported)
- Transport: MCP stdio only
- License: MIT

## Status

The local-first MCP server, mock provider, sync state machine, tests, documentation, example
configuration, CI workflow, and gated live-smoke script are implemented.

**Live TimeTree publication has not been verified against an authorized account.** No credentials
were available in the implementation environment, and the repository makes no claim of official or
verified live TimeTree support. The procedure required to make that claim safely is documented in
[docs/LIVE_TIMETREE_VERIFICATION.md](docs/LIVE_TIMETREE_VERIFICATION.md).

## Delivered

- Strict TypeScript/ESM MCP server using the official MCP TypeScript SDK.
- Exactly nine MCP tools:
  `list_calendars`, `preview_daily_worklog`, `save_worklog`, `get_daily_worklog`,
  `search_worklogs`, `generate_progress_report`, `publish_worklog`, `get_sync_status`, and
  `retry_pending_sync`.
- Canonical Markdown archive with YAML front matter and stable worklog IDs.
- SQLite ledger with current documents, revision snapshots, sync state, attempts, idempotency keys,
  remote memo references, local events, and optional FTS5 search.
- Strict Zod validation, evidence-reference validation, and secret-pattern warnings.
- Local preview, save, retrieval, search, and attributed report generation.
- Optional community TimeTree provider using the reviewed unofficial web endpoints.
- Mock provider with deterministic failure injection.
- Publish gates, pre-write reconciliation, read-back verification, conflict detection, uncertain
  outcome handling, duplicate prevention, dry-run and explicit live retry.
- Tests, README, environment example, MCP client examples, architecture and live-verification
  documentation, third-party notices, license, CI, and this report.
- Package lockfile and pinned versions.

## Requirement coverage

| Requirement                                                                                                                       | Implementation evidence                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript/Node, official MCP SDK, stdio                                                                                          | `src/index.ts`, `@modelcontextprotocol/sdk` 1.32.2, `StdioServerTransport`                                                      |
| Strict Zod validation                                                                                                             | `src/worklog/schema.ts`, `src/mcp/tools.ts`; unknown fields rejected                                                            |
| Markdown canonical archive                                                                                                        | `src/worklog/markdown.ts`, `src/store/ledger.ts` atomic writes                                                                  |
| SQLite metadata and idempotency                                                                                                   | `src/store/db.ts`, `src/store/ledger.ts`                                                                                        |
| Isolated provider interface                                                                                                       | `src/providers/timetree/provider.ts`; narrow adapter boundary                                                                   |
| Exactly nine tools                                                                                                                | `src/mcp/tools.ts`; exact-name test in `tests/integration/mcp-tools.test.ts`                                                    |
| No destructive operation                                                                                                          | No update/delete tool or provider method                                                                                        |
| Required report sections                                                                                                          | `src/worklog/markdown.ts`, `src/worklog/service.ts`                                                                             |
| Date/timezone defaults                                                                                                            | `Africa/Accra` default in `src/config.ts`; explicit timezone support                                                            |
| No fabricated facts                                                                                                               | Input schema requires explicit values; reports label user vs evidence-linked items; no inference logic                          |
| Evidence verification distinction                                                                                                 | `verified` evidence flag, report `[verified]`/`[reported]`, evidence-linked task labels                                         |
| Local save before remote                                                                                                          | `save_worklog` never contacts TimeTree; publish resolves a saved document                                                       |
| Transactional ledger and unique IDs                                                                                               | SQLite transaction, unique `(local_date, timezone)`, stable `wl_...` IDs                                                        |
| Record remote IDs after verification                                                                                              | `PUBLISHED` only after read-back; verified IDs go to `remote_memos`, while an `UNCERTAIN` candidate ID is explicitly unverified |
| Uncertain-write safety                                                                                                            | `UNCERTAIN`, reconciliation, no automatic create, mock timeout tests                                                            |
| Remote writes disabled by default                                                                                                 | `TIMETREE_ENABLE_REMOTE_WRITES=false`; publish/retry gates                                                                      |
| Preview hash and confirmation                                                                                                     | `previewHash` check plus `confirmation: "PUBLISH"`                                                                              |
| MCP-client approval                                                                                                               | Client-level approval/elicitation remains client-dependent; server requires the extra explicit confirmation                     |
| Credentials outside source control                                                                                                | Environment-only configuration; `.gitignore`; documentation recommends OS secret storage                                        |
| In-memory session cookies                                                                                                         | `CommunityTimeTreeProvider.sessionCookie`, never persisted                                                                      |
| Redacted logs                                                                                                                     | `src/logger.ts`; logger tests                                                                                                   |
| Conservative limits                                                                                                               | RPS, timeout, retries, response bytes, remote note size, 10-worklog live retry limit, 366-day report range                      |
| Bounded backoff / circuit breaking                                                                                                | `src/providers/timetree/rate-limit.ts`; capped backoff and threshold circuit                                                    |
| Single configured private calendar                                                                                                | `calendarId()` rejects mismatches; `assertCalendarAccessible()`                                                                 |
| Minimal remote data                                                                                                               | One memo, configured calendar, bounded note, no attachments/attendees                                                           |
| Official Connect API not used                                                                                                     | Endpoint is `/api/v1` unofficial web; documented discontinuation                                                                |
| Pinned upstream review                                                                                                            | Commit `3f77995...` documented in code, README, notices                                                                         |
| No installer execution                                                                                                            | No upstream installer referenced or executed                                                                                    |
| Invalid input / missing credentials / expired session / permission / rate limit / schema / duplicates / partial failure / restart | Dedicated tests listed below                                                                                                    |
| Local save when TimeTree unavailable                                                                                              | `tests/integration/local-service.test.ts`                                                                                       |
| Retries do not duplicate                                                                                                          | Pre-write reconcile and retry tests                                                                                             |
| Archive survives sync failure                                                                                                     | Sync failure tests assert Markdown exists                                                                                       |
| Secrets not in logs/output                                                                                                        | Logger redaction tests; secret warning test; publish block test                                                                 |
| MCP schema/error compliance                                                                                                       | Structured envelopes, `isError`, unknown-argument test, stdio E2E                                                               |
| Preview inspectable before publication                                                                                            | Preview returns Markdown, remote note, warnings, hash                                                                           |
| README/examples/lockfile/report                                                                                                   | Root files and `examples/`                                                                                                      |

## Design decisions

- **Local archive is authoritative.** Remote publication is an optional projection and never a
  prerequisite for saving or reporting.
- **One stable ID per date/timezone.** Revisions preserve identity and prior revisions remain in
  SQLite.
- **Write-before-record.** The create attempt and `PUBLISHING` state are persisted before the network
  call so a crash leaves a recoverable record.
- **Read-back verification.** A created memo is not `PUBLISHED` until `getMemo` confirms both the
  stable worklog ID and content hash.
- **Reconcile before retry.** A timeout is never interpreted as absence. Reconciliation lists active
  memos and compares identity and hash.
- **No destructive convenience features.** The absence of update/delete is intentional. Changed
  content after publication leads to `STALE` and then `CONFLICT`, not an in-place remote edit.
- **Provider isolation.** The MCP and service layers depend on a small interface, not on TimeTree
  HTTP details. This allowed deterministic mock tests and clean error classification.
- **No `.env` auto-loading.** Configuration comes from the MCP client environment or shell. This
  avoids silently reading a credential file from the working directory.

## Verification evidence

Commands run from the project root:

```text
npm run typecheck        passed
npm run lint             passed
npm run format           passed (Prettier check)
npm test                 passed: 11 test files, 85 tests
npm run test:coverage    passed: 85 tests
npm run build            passed
npm audit --audit-level=high   passed: 0 vulnerabilities
npm run test:live        skipped by design (no explicit opt-in)
```

A separate smoke test against the built `dist/index.js` started the real stdio server, listed
exactly 9 tools, and completed a local preview through an MCP client. It passed. The build also sets
the executable bit on POSIX, and the entrypoint was invoked through a symlink to confirm that the
bin resolves correctly under a normal npm-style link.

Coverage from the final run:

```text
All files: 87.41% statements, 71.44% branches, 90.58% functions, 88.47% lines
```

The Vitest configuration enforces thresholds of 70% statements, 70% functions, 70% lines, and 60%
branches.

### Test areas

- Validation: invalid dates, invalid timezones, unknown fields, duplicate/unknown evidence IDs,
  evidence-linked items without evidence, secret detection.
- Markdown: required sections, front matter, stable title, metadata header, truncation preserving
  metadata even with a maximum-length title, attribution labels, evidence status.
- Local service: preview without writes, save order, idempotent saves, missing archive restoration,
  revisions, idempotency-key conflicts, local-only operation, retrieval, search, reports, bounded
  report range, attribution in reports, empty-period honesty.
- Community provider: missing credentials, sign-in and session cookie, CSRF, calendar/memo listing,
  create payload, session expiry reauthentication, non-JSON response, changed JSON shape, HTTP 429,
  HTTP 403, sign-in 5xx classification, response byte cap, timeout outcome, no write retry after
  server error, circuit breaker.
- Sync: disabled writes, confirmation, preview hash, calendar mismatch, secret block, verified
  publication, duplicate prevention, pre-write and post-write timeouts, read-back failure,
  conflict, conflict clearing without an automatic second create, disappeared recorded memos,
  retryable vs permanent failures, explicit recovery from a permanent failure after repair,
  operator-blocked worklogs, reconciliation failure, per-worklog retry failure without aborting the
  batch, restart recovery, stale edits, dry-run default, retry confirmation, status.
- MCP: exact tool set, no destructive names, list calendars before calendar-ID setup, structured
  success/error envelopes, schema rejection, in-memory transport, real stdio round trip.
- Protection primitives: circuit threshold/reset, capped backoff, and private application
  directories without changing permissions on a user-supplied shared database parent.

### Live status

The only live command executed was the opt-in smoke script with no opt-in, which exited
successfully with the documented skip message. No live network call to TimeTree was made during
verification. Do not describe the community provider as live-verified until the gated procedure has
been completed.

## Security review summary

- Secrets are accepted only from environment variables; they are not persisted or returned by
  tools.
- Logger keys containing credential-like names are redacted, and common token/email/cookie patterns
  are redacted from text.
- Publication is blocked when the work log contains common secret patterns.
- Remote writes require two independent controls: an environment gate and a per-call confirmation,
  plus a matching preview hash and calendar check.
- Only one configured calendar ID is accepted.
- Remote note and response sizes are bounded.
- Writes are not retried after transport, timeout, server, or schema failures. The adapter may
  replay a write once after a 401/403 authentication/session rejection, which is treated as not
  applied; all other retries are explicit and reconciled.
- No HTTP listener or remote management surface is exposed.

## Known limitations and remaining risk

1. **Live TimeTree integration is unverified.** The unofficial endpoints may behave differently for
   a real account, region, or calendar permission set.
2. **Unofficial upstream.** Endpoint and CSRF behavior can change without notice. The adapter maps
   schema changes to a typed error, but cannot prevent upstream breakage.
3. **No remote update/delete.** This is a deliberate safety choice. Resolve `STALE`/`CONFLICT`
   manually in TimeTree if necessary.
4. **Eventual consistency risk.** If TimeTree's event listing lags a successful create, a
   reconciliation immediately after an uncertain write could miss the memo. The correct response is
   to wait and reconcile again, never to force a create. This is documented in the uncertain-write
   procedure.
5. **SQLite is not encrypted by the application.** Protect the data directory with OS permissions
   and full-disk encryption.
6. **Report/test data is not a compliance record.** The report clearly labels user-reported and
   evidence-linked items, but it does not independently verify evidence references.
7. **Client approval is client-dependent.** The server enforces its confirmation and gates; whether
   the MCP client separately prompts the human is controlled by the client.
8. **No automatic reindex.** The Markdown archive is canonical, but if the SQLite database is lost,
   the server does not rebuild its index by scanning the archive. Back up both the database and the
   Markdown files.

## Handoff

1. Build with `npm ci && npm run build`.
2. Use `examples/mock-mcp-config.json` for a safe local smoke of the MCP surface.
3. For optional TimeTree setup, follow the README steps and keep writes disabled while discovering
   the private calendar ID.
4. Complete `docs/LIVE_TIMETREE_VERIFICATION.md` before making any live-support claim.
5. Back up the data directory and keep credentials outside the repository.

## Repository state

The project source is intended for the repository
`https://github.com/gideon211/timetree-worklog-mcp.git`. The lockfile is included. No credentials,
test artifacts, coverage output, `dist/`, or local data are intended for source control.
