# Workspace export

An admin can download everything in their workspace as one ZIP file. It is meant for backups, for moving
away, and for answering "can I get my data out" with a yes.

## What you get

The file is named `<workspace>-export-YYYY-MM-DD.zip` and holds:

```
manifest.json          what is in the file, row counts, when it was made
json/<name>.json       each table as a JSON array
csv/<name>.csv         the same rows as CSV (UTF-8 with a byte order mark, so Excel opens it correctly)
```

Tables, in order:

| Group | Tables |
| --- | --- |
| Workspace | `core.settings`, `core.module_state`, `core.audit_log`, `core.members` (name and email joined in) |
| Access | `core.api_keys` (names, scopes and dates only; hashes, secrets and tokens are removed) |
| Each tool | Its own tables, or whatever its `exportData` function returns |

Passwords, sessions and key secrets are never included.

## How it works

1. An admin asks for an export. It returns at once with status `queued`.
2. A background job reads each table 500 rows at a time and streams the ZIP into R2. Nothing is held in
   memory, so a large workspace does not hit the Worker memory limit.
3. When it finishes the person who asked gets a notification, and an email if email is on.
4. The file can be downloaded for 24 hours. Then it is deleted. The record of the export stays for 90 days.

Statuses: `queued`, `running` (with `tablesDone` of `tablesTotal`), `done`, `failed`, `expired`.

Rules:

- Admin or owner only.
- One export at a time per workspace. A second request while one is running is refused with `export.already_running`.
- At most 6 requests per hour per workspace.
- A failed job is retried up to 5 times before the export is marked `failed`. A job stuck for 30 minutes is marked failed by the daily cleanup.
- Requests, completions and downloads are written to the audit log.

## Routes

All under `/api/v1/export`, signed in as an admin, same-origin only.

| Route | What it does |
| --- | --- |
| `POST /` | Start an export. Returns 202 and `{ export }`. |
| `GET /` | The latest exports, newest first, as `{ items }`. |
| `GET /:id` | One export, for progress. |
| `GET /:id/download` | The ZIP, as an attachment. `export.not_ready` (409) until done, `export.expired` (410) after 24 hours. |

Error codes are in [errors.md](./errors.md).

## For tool authors

Every tool table is exported automatically if the tool lists it in `tables`. Two things to know:

- Tables must be normal rowid tables (no `WITHOUT ROWID`), because paging uses the row id. Tables need an `org_id` column so only this workspace's rows are read.
- If a tool keeps data elsewhere, or needs to hide or reshape columns, give it an `exportData` function. It returns `{ name, columns, pages() }`, where `pages()` yields arrays of rows.

## Limits

- The ZIP has no compression and no ZIP64, so a single file is limited to 4 GiB and 65,535 entries. Far beyond a normal workspace.
- Each page costs one D1 query per format, so a table needs about `2 x ceil(rows / 500)` queries. On the Workers Free plan (about 50 queries per invocation) that caps an export at roughly 12,000 rows in total. The Workers Paid plan allows 1,000 queries and handles about 250,000 rows. Larger workspaces on Free should export one tool at a time or move to Paid.
- R2 must be bound as `FILES`. Without a multipart-capable bucket the ZIP is written in one request, which is fine for small workspaces.
