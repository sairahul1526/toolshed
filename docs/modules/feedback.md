# Feedback

Feedback is a place where customers suggest features, vote, follow a public roadmap and read a changelog. When you change a post's status, reply or ship something, the people who voted get an email. It replaces hosted tools such as Canny, Featurebase, Frill, Nolt and Beamer. It needs no third-party services.

Everything below uses a local install at `http://127.0.0.1:8787` and the workspace portal `acme`.

## Set up in three steps

1. Open Feedback in the dashboard and choose a name. The portal is made with a board, the six default statuses and a public address.
2. Add sample data if you want to look around. Sample rows are marked and can be cleared in one click.
3. Paste the widget snippet on your site. The Widget tab shows "Widget connected" once a page has loaded it.

Email is optional but recommended. Without it, visitors cannot sign in with a code, so posts and votes from guests are accepted as unverified and posts wait in the review queue. The settings screen says so.

## Public pages

| Path | What it is |
|---|---|
| `/feedback/acme` | Boards, search, sort (top, new, trending), submit |
| `/feedback/acme/p/<post>` | One post with votes and comments |
| `/feedback/acme/new` | Submit a post, with similar posts shown while typing |
| `/feedback/acme/embed` | The same portal without page chrome, for the widget |
| `/roadmap/acme` | One lane per status marked "show in roadmap" |
| `/changelog/acme` | Published entries |
| `/changelog/acme/feed.rss` | RSS feed |
| `/changelog/acme/subscribe` | Double opt-in subscription |
| `/feedback/acme/latest.json` | Latest published time, for the unread dot (CORS open) |

Private boards are not shown to visitors. Pages work without JavaScript; the scripts only add live similar-post search and small conveniences.

## Embed the widget

```html
<script src="https://feedback.example.com/m/feedback/widget.js" data-portal="acme" defer></script>
```

The script is under 15 KB, has no dependencies and puts one closed shadow root on your page. A failure inside it is caught and never reaches your page.

| Attribute | Meaning |
|---|---|
| `data-portal` | Portal slug. Required. |
| `data-mode` | `feedback` (default) or `changelog` for a "What's new" popover with an unread dot kept in `localStorage`. |
| `data-label` | Button text. |
| `data-position` | `right` (default) or `left`. |
| `data-target` | A CSS selector. The widget opens when those elements are clicked, and shows no floating button. |
| `data-sso` | A signed token from your app that says who the person is. See below. |

## Who is voting

1. Single sign-on. Your server signs a short-lived token for the signed-in customer and passes it in `data-sso`. A valid token marks the person as verified with no email step. Note: token verification currently uses the core `verifyJwt`, which is a placeholder in this build; it is covered by a stub test only.
2. Email code. Six digits, valid for ten minutes, five attempts, at most three codes per address per hour.
3. Guest. Only when email is not set up, or the portal allows anonymous posting. Guest posts and votes are unverified and held for approval.

## Spam control

- A hidden honeypot field. A filled field pretends to succeed and creates nothing.
- A signed timing token. Forms submitted faster than a person can type are refused.
- Rate limits per hour: 5 posts and 20 comments per person, 10 posts per visitor id, 120 votes per person and 240 per visitor id. The visitor id is a salted hash that changes daily and is never stored with the raw address.
- A link limit for unverified people. Over the limit, the post waits for review.
- A review queue, block a person, and mark a person as trusted to skip review.

## REST API

Call it with an API key that has `feedback:read` or `feedback:write` (write also covers read). See `docs/api.md` for keys.

```sh
export KEY=ts_live_...
curl http://127.0.0.1:8787/api/v1/feedback/posts?sort=top&limit=20 -H "Authorization: Bearer $KEY"

curl -X POST http://127.0.0.1:8787/api/v1/feedback/posts \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"board":"ideas","title":"Dark mode","body":"Please add it.","author_email":"ada@example.com","author_name":"Ada"}'

curl -X PUT http://127.0.0.1:8787/api/v1/feedback/posts/POST_ID \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"status_id":"STATUS_ID"}'

curl -X POST http://127.0.0.1:8787/api/v1/feedback/posts/POST_ID/merge \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"into":"OTHER_POST_ID"}'

curl -X POST http://127.0.0.1:8787/api/v1/feedback/entries \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"title":"CSV import","body":"You can now **import** posts.","labels":["New"]}'
curl -X POST http://127.0.0.1:8787/api/v1/feedback/entries/ENTRY_ID/publish -H "Authorization: Bearer $KEY"

curl "http://127.0.0.1:8787/api/v1/feedback/stats?days=30" -H "Authorization: Bearer $KEY"
curl "http://127.0.0.1:8787/api/v1/feedback/export?format=csv" -H "Authorization: Bearer $KEY" -o posts.csv
```

Resources: `portal`, `boards`, `categories`, `statuses`, `tags`, `posts` (with `approve`, `reject`, `merge`, `merge-preview/:target`, `comments`, `notes`, `votes`), `comments` (`approve`, `reject`, `pending`), `people` (`block`, `unblock`, `trust`, `untrust`), `entries` (`publish`), `subscribers`, `stats`, `export`, `import`.

List answers hold `items`. Posts page with `nextCursor`. Errors follow `docs/errors.md`.

## Limits

| What | Limit |
|---|---|
| Post title | 140 characters |
| Post body | 5,000 characters |
| Comment | 3,000 characters |
| Posts per API page | 1 to 100 |
| Import | 200 rows per batch, up to 5 MB of CSV text per request |
| Export | 50,000 posts, 100,000 rows per table in the JSON export |
| Widget script | under 15 KB |
| Changelog images | stored in R2 under `feedback/<workspace id>/`, served with a one-year cache header |

Free-plan Workers allow about 10 ms of CPU and 50 subrequests per request. Lists page by cursor, the import runs in batches, and mail goes through a queue in batches of 10 recipients, so no request does unbounded work.

## Emails

Status changed, admin replied, shipped, decline reason, and a weekly list of unanswered posts for admins (Mondays, 04:00 UTC). Digests of the changelog are weekly or monthly for subscribers who chose that.

- Sent through the queue in batches of 10 per post, so a stopped job resumes where it left off.
- Every email has an unsubscribe link. No tracking pixels and no click tracking.
- The install's email caps apply: by default 10 per recipient per hour and 300 per install per hour. When a cap is hit, the job waits 15 minutes and tries again instead of dropping people.
- The cap maths: a post with 3,000 voters needs 10 batches of 300 an hour, so about 10 hours at the default caps. Raise the caps in the email settings if that is too slow.
- Subscribers confirm by email (double opt-in). The unsubscribe page works with one click.

## Webhook events

Events are recorded and available to other modules. Outbound webhook delivery is not built yet (see below). Each event has a name, the workspace, a subject id, and `data`.

| Event | Subject | `data` |
|---|---|---|
| `post.created` | post id | `{ "title": "Dark mode", "board": "bd_...", "source": "portal" }` |
| `post.status_changed` | post id | `{ "from": "st_a", "to": "st_b", "status": "Planned", "kind": "open" }` |
| `post.merged` | source post id | `{ "into": "po_...", "votesMoved": 4 }` |
| `post.voted` | post id | `{ "votes": 10, "milestone": 10, "title": "Dark mode" }` |
| `comment.created` | comment id | `{ "post": "po_...", "staff": false }` |
| `changelog.published` | entry id | `{ "title": "CSV import", "slug": "csv-import", "posts": 2 }` |
| `person.verified` | person id | `{ "source": "email" }` |

`post.voted` fires once each time a post first reaches 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000 and 10000 votes, so a viral post cannot flood a webhook.

## Export and import

The Settings page exports posts as CSV and everything as JSON. Import takes a Canny CSV, shows a column mapping with a preview, and imports in batches of 200 rows. Imported people are unverified and are never emailed. Posts from the import start in the initial status.

## Privacy

- Visitors who only browse get no cookie. A signed, HttpOnly cookie is set after someone verifies or posts, and lasts 180 days.
- The visitor id used for rate limits is a salted hash that rotates daily.
- Last names can be hidden on the public pages.
- Emails carry no tracking. Subscribers and voters can leave with one click, and an admin can remove a subscriber.
- Deleting a post removes its votes, comments and notes.
- No third-party requests are made by the portal, the widget or the emails.

## Themes

Choose a theme and an accent colour (a six digit hex value). The "Powered by" line is off by default and never forced.

## Not yet

- Custom domains for the portal.
- Outbound webhook delivery. Events are recorded only.
- A workspace member picker for "assign". Assign is free text for now because there is no member list in this build.
- SSO tokens are checked by a core placeholder. Real verification arrives with the core auth work.
- Full-text search. Search uses `LIKE`; SQLite FTS5 is not tested on D1 and is not used.
- A list of sent emails in the dashboard. The queue records them, but the admin screen does not show them yet.
- Sign-in to the dashboard is a placeholder in this build, so the dashboard was checked with route tests and static screenshots, not in a live browser session.
