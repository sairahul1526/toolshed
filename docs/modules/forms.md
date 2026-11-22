# Forms

Build forms, share them by link or embed, and read the answers in your workspace. It covers what Typeform, Tally, Jotform, Google Forms and Formspree do, without a badge, without third-party requests and without visitor cookies.

Turn it on under Modules. The first screen offers six templates (Contact, Feedback with NPS, CSAT after support, Event registration, Waitlist, Blank) and a switch that adds sample forms with made-up responses, which you can remove in one click.

## Set up

1. Pick a template or start blank. The builder opens at once and saves as you type.
2. Publish. The public address is `/f/<slug>`. Slugs are unique across the whole install.
3. Open Share, copy the link or an embed, and use "Waiting for the first response" to see it arrive.
4. Optional: set up email under `/app/email`. Without it, form notifications and the autoresponder do not send, and the Settings and Share screens say so.

## What it does

- Builder: drag to reorder (or Alt with the arrow keys), undo and redo, autosave, version history with restore, and a publish step so edits stay private until you publish. Field types: short and long text, email, number, phone, URL, date, single and multiple choice, dropdown, rating, NPS, CSAT, scale, yes or no, file upload, hidden fields filled from the URL, statement and section blocks, and multi-page forms.
- Logic: show or hide fields, jump to a page, scores, calculations and piped answers (`{{name}}`). The server and the browser share one set of rules and a test keeps them identical.
- Public page: password, open and close dates, response cap, several endings chosen by logic, redirect on completion. The workspace's public preset applies, with per-form colours, logo and cover. No forced badge.
- Embeds: an iframe that resizes itself, and a popup script under 8 KB (`/m/forms/embed.js`).
- Responses: search, filter by date, unread and starred, choose columns, detail view, notes, mark as spam, delete and bulk actions, CSV export.
- Partial responses: off by default, switched on per form under Privacy, and clearly labelled where they appear.
- File uploads are stored in R2, with type and size limits per field.
- Scoring: NPS, CSAT and CES summaries, daily counts and drop-off by question.
- Spam protection: honeypot, signed page token, minimum fill time, rate limits, duplicate detection and bot user agents. Held posts go to the Spam folder.
- Notifications: email to the team and an autoresponder to the respondent, rate limited per address.
- Webhooks: Forms emits `form.submitted`, `form.partial`, `form.published`, `form.closed` and `submission.spam`. Add endpoints under Webhooks.
- Import and export: export a form definition, export responses as CSV, and import responses from a CSV with column mapping.

## API

Keys need `forms:read` or `forms:write`. All paths start with `/api/v1/forms`.

```sh
# list forms
curl -H "Authorization: Bearer $KEY" https://your.app/api/v1/forms
# create one from a template
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"template":"contact","name":"Contact us"}' https://your.app/api/v1/forms
# publish it
curl -X POST -H "Authorization: Bearer $KEY" https://your.app/api/v1/forms/$ID/publish
# read responses, then download them as CSV
curl -H "Authorization: Bearer $KEY" "https://your.app/api/v1/forms/$ID/submissions?limit=50"
curl -H "Authorization: Bearer $KEY" https://your.app/api/v1/forms/$ID/submissions/export.csv
```

Other routes: `GET /templates`, `GET|PATCH|DELETE /:id`, `PUT /:id/draft`, `GET /:id/versions`, `POST /:id/versions/:vid/restore`, `POST /:id/close`, `POST /:id/reopen`, `PATCH /:id/settings`, `GET /:id/stats`, `GET /:id/export`, `POST /import`, `POST /:id/submissions/import`, `POST /:id/submissions/bulk`, `GET|POST|DELETE` on submission notes, `GET|DELETE /respondents?email=` for privacy requests.

Plain HTML forms can post to `/f/<slug>/submit` when "Allow direct posts" is on (Settings, Access). It is off by default, because a direct post skips the page token and gets a smaller rate limit.

## Privacy

- No IP address is stored. Addresses are used only to build rate-limit keys and are never saved on a response.
- Each form can collect no metadata at all (Settings, Privacy).
- Privacy screen (`/app/forms/privacy`): find everything one email sent across all forms, download it as JSON, or delete it with its notes and files.
- Spam and partial rows nobody opened for 30 days are removed by a daily job.

## Limits

Sized for the Cloudflare free plan, which allows about 10 ms of CPU and 50 subrequests per request, 100,000 D1 row writes a day and 1,000 KV writes a day.

- A submission is one D1 batch (response row plus a rollup bump), plus one queue message for notifications and webhooks. No KV writes. Rate-limit counters are D1 rows (one small write per check).
- Rate limits: 10 submissions per visitor per 10 minutes, 3 for direct posts, 120 per form per minute, 8 password tries per 10 minutes.
- Stats come from daily rollups, so the summary page does not scan responses.
- Uploads: 10 MB per file by default, with a hard ceiling. Responses per list page: 50. CSV import: the first 500 rows per run.
- Roughly 100,000 D1 writes a day is about 20,000 responses a day on the free plan.

## Not yet

- Custom domains for form pages.
- Importing forms or responses from Typeform or Tally.
- A shared contacts table. Respondents are matched by email only.
- Date and time settings are read as UTC and labelled that way.
