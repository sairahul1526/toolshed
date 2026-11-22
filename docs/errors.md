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
| `fetch_failed` | 502 | We couldn’t reach that address. Check it and try again. | The address you gave did not answer or refused the connection. Check that it is online and public, then try again. |
| `fetch_timeout` | 504 | That address took too long to answer. Try again in a moment. | The address you gave did not answer in time. Try again later, or use a faster endpoint. |
| `fetch_too_large` | 502 | The page at that address is too large to read. | The response from the address you gave was over the size limit. Point to a smaller page or file. |
| `forbidden` | 403 | You don’t have access to that. Ask a workspace admin. | You are signed in but your role or API key scope is too low. Ask a workspace admin for access, or use a key with the right scope. |
| `internal` | 500 | Something went wrong on our side. Try again. | A bug or an outage on our side. Retry once. If it keeps failing, send the `requestId` to your administrator. |
| `method_not_allowed` | 405 | That action isn’t supported here. | Use a different HTTP method for this path. |
| `module_off` | 404 | That module is turned off for this workspace. | A workspace admin can turn the module on from Modules. |
| `needs_setup` | 409 | This needs one more setup step before it can run. | The message names the missing step, for example connecting email. Finish that step, then try again. |
| `not_found` | 404 | We couldn’t find that. It may have been moved or deleted. | Check the id. Items from other workspaces are reported as not found on purpose. |
| `rate_limited` | 429 | Too many tries. Wait a moment, then try again. | Wait for the number of seconds in the `retry-after` header, then try again. Do not retry in a tight loop. |
| `redirect_not_followed` | 502 | That address redirects somewhere we can’t follow safely, so we stopped. Use the final address directly, and make sure it starts with https://. | The address redirected from https to http, or tried to send a request with a body to a different site. Use the final address directly. |
| `too_large` | 413 | That’s too large to accept. | Send less data, or split it into smaller requests. |
| `too_many_redirects` | 502 | That address sends visitors around in circles. Check where it redirects to. | The address redirected more times than allowed. Use the final address directly. |
| `unauthorized` | 401 | Sign in to continue. | Sign in, or send a valid API key. An expired or revoked key gives this code too. |
| `url_not_allowed` | 400 | That address can’t be used. Enter a public web address that starts with http:// or https://. | Only public http and https addresses are accepted. Private, local and internal hosts are refused, and so are addresses with a username or password in them. |
| `validation_failed` | 422 | Some fields need fixing. | Read `fields` for what to change, fix those inputs and send the request again. |

## Export codes

These come from `src/core/export.ts` (Export in the workspace settings).

| Code | Status | Message | What to do |
| --- | --- | --- | --- |
| `export.already_running` | 409 | An export is already running for this workspace. Wait for it to finish. | Only one export runs at a time. Wait for the first to finish (usually a few minutes), then start another. An export that has been stuck for more than 30 minutes no longer blocks a new one. |
| `export.expired` | 410 | This export has expired. Start a new one. | Files are kept for 24 hours. Start a new export. |
| `export.failed` | 409 | This export didn’t finish. Start a new one. | Start a new export. If it fails again, send the export id to your administrator; the install owner can see the cause in the failed jobs list. |
| `export.not_ready` | 409 | This export is still being prepared. Try again in a minute. | Poll `GET /api/v1/export/:id` until `status` is `done`, then download. |
