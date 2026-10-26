# Gated live TimeTree verification

This procedure is the only approved way to check the optional community TimeTree provider against a
real account. It exists because the provider uses undocumented web endpoints and because **no live
integration is claimed until this procedure has been completed successfully**.

The automated test suite uses the mock provider. The live check is deliberately not part of
`npm test`.

## Preconditions

- You own or are authorized to use the TimeTree account.
- You have created a **dedicated private test calendar**. Do not test in a shared, team, family, or
  production calendar.
- You can delete a test memo manually in the TimeTree app after the test.
- The test work log contains synthetic content only. Do not paste real sensitive work data into a
  provider you have not approved.
- Credentials are supplied through the MCP client environment, an OS keychain, or a secret
  injection mechanism. Do not commit them, put them in shell history, or paste them into logs.
- Remote writes remain disabled until the write-test step below.

## 1. Read-only authentication and calendar discovery

Use a temporary local data directory so the smoke check cannot touch real archives:

```bash
TIMETREE_LIVE_SMOKE=1 \
TIMETREE_PROVIDER=community \
TIMETREE_EMAIL="<authorized-email>" \
TIMETREE_PASSWORD="<secret-from-your-store>" \
npm run test:live
```

Expected result:

```text
Read-only sign-in passed. Calendars visible: N.
Read-only live smoke passed. No memo was created, updated, or deleted.
```

The script prints only counts. It does not print the password, session cookie, CSRF token, or memo
notes. It does not create, update, or delete anything.

To also verify the memo listing used during reconciliation:

```bash
TIMETREE_LIVE_SMOKE=1 \
TIMETREE_PROVIDER=community \
TIMETREE_EMAIL="<authorized-email>" \
TIMETREE_PASSWORD="<secret-from-your-store>" \
TIMETREE_CALENDAR_ID="<dedicated-private-calendar-id>" \
npm run test:live -- --include-memos
```

Expected additional line:

```text
Memo listing passed for the configured calendar. Total active memos: N; work-log memos: M.
```

The listing can contain existing private memo titles and notes in memory, but the script only prints
counts and never logs note contents.

If the script exits non-zero, stop. Do not enable remote writes. Capture only the error code and
message, not credentials or cookies.

## 2. Local-only MCP verification

Use the MCP client configuration in
[`examples/community-mcp-config.json`](../examples/community-mcp-config.json), but keep:

```text
TIMETREE_ENABLE_REMOTE_WRITES=false
```

Restart the client and verify:

1. `get_sync_status` returns provider health `ok` and `calendarConfigured: true`. Call
   `list_calendars` separately to confirm the configured calendar ID is visible.
2. `preview_daily_worklog` with a synthetic work log returns Markdown, a remote note, and a
   `previewHash`.
3. `save_worklog` saves locally and returns the same stable work-log ID.
4. `publish_worklog` is rejected with `REMOTE_WRITES_DISABLED` and creates nothing remote.

Confirm the Markdown file exists in the configured archive directory and contains the expected
sections and front matter.

## 3. Full write verification in the dedicated calendar

Do this only after the read-only steps pass and the operator explicitly authorizes one test write.

1. Set `TIMETREE_ENABLE_REMOTE_WRITES=true` in the test MCP client environment.
2. Restart the client.
3. Create a synthetic work log with a date and content you can recognize. Do not use real
   sensitive material.
4. Call `preview_daily_worklog` and inspect the remote title and note.
5. Call `save_worklog` and confirm the returned `previewHash`.
6. Call `publish_worklog` with that hash and `confirmation: "PUBLISH"`.
7. Require the result to be:

   ```json
   {
     "state": "PUBLISHED",
     "verified": true,
     "alreadyPublished": false
   }
   ```

8. Open the dedicated private calendar and confirm there is exactly one memo with the expected
   stable ID in the title and the metadata header in the note.
9. Call `get_sync_status` and confirm the state is `PUBLISHED` with a memo ID and verification
   timestamp.
10. Call `publish_worklog` again with the same preview hash. Require `alreadyPublished: true` and
    exactly one memo in the calendar.
11. Call `retry_pending_sync` with that `worklogId` and `dryRun: true`; require
    `already_published` and no second memo.

Do not force timeouts, kill the process mid-write, or deliberately trigger upstream failures in a
live account. Uncertain-write recovery is covered by deterministic mock tests.

## 4. Optional metadata-only edit check

This verifies the safety behavior when local content changes after publication:

1. Save a changed version of the same synthetic work log.
2. Confirm the state becomes `STALE`.
3. Attempt `publish_worklog` with the new preview hash.
4. Require `CONFLICT` and confirm no second memo was created.

There is no update or delete tool. Resolve the test conflict manually in the TimeTree app if
needed.

## 5. Cleanup

1. Delete the synthetic memo manually in the TimeTree app.
2. Remove the temporary test data directory used by the smoke script, if it still exists.
3. Set `TIMETREE_ENABLE_REMOTE_WRITES=false` again.
4. Remove temporary MCP client configuration containing test credentials.
5. If credentials were exposed, rotate them.
6. Record the result in your own verification notes, including the date, provider behavior, and any
   upstream changes. Do not record secrets.

## Acceptance checklist

- [ ] Read-only sign-in succeeded.
- [ ] Calendar listing succeeded.
- [ ] Memo listing succeeded for the dedicated calendar.
- [ ] Local preview and save succeeded.
- [ ] Disabled publication was rejected without a remote write.
- [ ] One explicitly confirmed publication succeeded and was read back.
- [ ] The memo title and metadata hash matched the saved work log.
- [ ] A repeat publication did not create a duplicate.
- [ ] Local edit after publication produced `STALE` and then `CONFLICT` without a second memo.
- [ ] Cleanup removed the test memo and credentials.
- [ ] No secret appeared in terminal output, logs, screenshots, or reports.

Only after every item passes may you say that live publication worked against that account, that
calendar, and that date. A successful run does not make the unofficial endpoints official or
guarantee future compatibility.
