# Error codes

Every error the API returns on purpose has a stable `code`. The code never changes once released; the
message can be reworded. Show the message to people and write your code against the `code`.

```json
{ "code": "not_found", "message": "We couldn’t find that. It may have been moved or deleted.", "requestId": "…", "fields": {} }
```

- `fields` is present on `validation_failed` and holds one message per input name.
- `requestId` matches the `x-request-id` response header. Quote it when you ask for help.
- The same list is available as JSON, without signing in: `GET /api/v1/errors` returns
  `{ "items": [{ "code", "status", "message" }] }`.
- Modules add their own codes, prefixed with the module id (`links.slug_taken`). Each module documents
  its codes next to its own docs; they also appear in `GET /api/v1/errors` once the module is installed.

A unit test (`test/services/errors.test.ts`) fails when a core code is added without a row here, when a
row's status or message drifts from the code, or when a row names a code that no longer exists. Keep this
table in step with `src/core/errors.ts` and `src/core/export.ts`.

## Core codes

| Code | Status | Message | What to do |
| --- | --- | --- | --- |
| `bad_request` | 400 | That request isn’t valid. Check it and try again. | The body was missing, was not JSON, or had the wrong shape. Fix the request. Retrying the same request will not help. |
| `conflict` | 409 | That clashes with something that already exists. | Something with the same name or id is already there, or the item changed since you read it. Reload, then change the name or try again. |
| `forbidden` | 403 | You don’t have access to that. Ask a workspace admin. | You are signed in but your role or API key scope is too low. Ask a workspace admin for access, or use a key with the right scope. |
| `internal` | 500 | Something went wrong on our side. Try again. | A bug or an outage on our side. Retry once. If it keeps failing, send the `requestId` to your administrator. |
| `method_not_allowed` | 405 | That action isn’t supported here. | Use a different HTTP method for this path. |
| `module_off` | 404 | That module is turned off for this workspace. | A workspace admin can turn the module on from Modules. |
| `needs_setup` | 409 | This needs one more setup step before it can run. | The message names the missing step, for example connecting email. Finish that step, then try again. |
| `not_found` | 404 | We couldn’t find that. It may have been moved or deleted. | Check the id. Items from other workspaces are reported as not found on purpose. |
| `rate_limited` | 429 | Too many tries. Wait a moment, then try again. | Wait for the number of seconds in the `retry-after` header, then try again. Do not retry in a tight loop. |
| `too_large` | 413 | That’s too large to accept. | Send less data, or split it into smaller requests. |
| `unauthorized` | 401 | Sign in to continue. | Sign in, or send a valid API key. An expired or revoked key gives this code too. |
| `validation_failed` | 422 | Some fields need fixing. | Read `fields` for what to change, fix those inputs and send the request again. |

## Export codes

These come from `src/core/export.ts` (Export in the workspace settings).

| Code | Status | Message | What to do |
| --- | --- | --- | --- |
| `export.already_running` | 409 | An export is already running for this workspace. Wait for it to finish. | Only one export runs at a time. Wait for the first to finish (usually a few minutes), then start another. An export that has been stuck for more than 30 minutes no longer blocks a new one. |
| `export.expired` | 410 | This export has expired. Start a new one. | Files are kept for 24 hours. Start a new export. |
| `export.failed` | 409 | This export didn’t finish. Start a new one. | Start a new export. If it fails again, send the export id to your administrator; the install owner can see the cause in the failed jobs list. |
| `export.not_ready` | 409 | This export is still being prepared. Try again in a minute. | Poll `GET /api/v1/export/:id` until `status` is `done`, then download. |
