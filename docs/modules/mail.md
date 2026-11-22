# Mail

Newsletters and product emails from your own workspace. Collect subscribers with double opt-in, write and send broadcasts, run a welcome sequence, send product emails from templates, turn an RSS feed into email, and publish a public archive. Tracking is off by default and no third-party hosts are used.

## Set up

1. Turn on Mail under Modules. The first screen is a three-step first run: set your postal address, create a newsletter, send yourself a test.
2. Check email. If email is not set up for the workspace, the module says so on every screen and on Deliverability. Emails are then written to the log and not delivered.
3. Share the hosted signup page or the embed from the newsletter screen.

## What it does

- Subscribers, newsletters (lists), tags, custom fields, CSV import (with a consent checkbox and a report) and CSV export.
- Segments built from up to five rules (list, tag, field, status, signup date, opens, clicks).
- Hosted signup page and embed with double opt-in. The confirmation page needs a button press, so mail scanners cannot confirm by accident.
- Broadcast editor in Markdown with a toolbar, preview, test send, schedule (UTC), pause, resume and duplicate.
- Pre-send checklist: email mode, subject, content, postal address, unsubscribe link, audience size, test sent.
- Send engine that goes out in batches through the queue and resumes if interrupted.
- One-click unsubscribe (link and `List-Unsubscribe` headers) and a suppression list.
- Welcome sequence of up to 10 steps with delays.
- Product emails: templates with `{{variables}}` and a send API with idempotency.
- RSS to email: a feed is checked hourly and new items become drafts or are sent.
- Stats: growth, sends, and optional opens and clicks.
- Public archive and RSS feed per newsletter.
- REST API and events.

## Limits on the free plan

- A request has about 10 ms of CPU and 50 subrequests. Sending is therefore done in small batches of 10 messages per queue run, one batch at a time.
- Core email caps apply: 10 messages per recipient and 300 messages per workspace install per hour. A broadcast to more people than the hourly cap takes several hours; the send engine pauses when it hits the cap and carries on in the next hour. Your email provider has its own daily limit too, so check it before a large send.
- Dashboard times are UTC.

## Deliverability

- Sender status, blocked addresses and the "No automatic bounce or complaint feedback yet" note are on the Deliverability screen.
- There is no provider bounce or complaint feedback yet. You can mark an address bounced or a complaint by hand, import a list of bounced addresses as CSV, or call the bounce endpoint from your own code. These addresses are suppressed and never emailed again.
- Always send a test to yourself and check it on your phone before a broadcast.

## Privacy

- Open and click tracking are off by default. When you turn them on, subscribers are told in the email footer, and clicks go through your own install.
- A subscriber is only emailed after they confirm, or after you tick the consent box on an import or manual add. The consent note is stored with the person.
- Every email has an unsubscribe link and a one-click header. Unsubscribed and bounced addresses are suppressed.
- Your postal address is added to every footer. A broadcast cannot be sent without it.
- Deleting a subscriber removes their rows and keeps only a hashed suppression entry if they had unsubscribed.

## Public pages

All under `/n`. They set no cookies.

| Path | What |
| --- | --- |
| `/n/<slug>` | Signup page |
| `/n/<slug>/embed` | Embeddable signup form (can be framed) |
| `POST /n/<slug>/subscribe` | Signup |
| `/n/confirm/<token>` | Confirm (button, then POST) |
| `/n/u/<token>` | Unsubscribe |
| `/n/c/<token>`, `/n/o/<token>` | Click and open tracking, only when on |
| `/n/<slug>/archive`, `/n/<slug>/archive/<post>` | Archive of sent emails you marked public |
| `/n/<slug>/rss.xml` | RSS of the archive |

## API

Scopes: `mail:read`, `mail:write`, `mail:send`. Base path `/api/v1/mail`.

```sh
curl https://YOUR_APP/api/v1/mail/lists -H "authorization: Bearer YOUR_API_KEY"

curl -X POST https://YOUR_APP/api/v1/mail/subscribers \
  -H "authorization: Bearer YOUR_API_KEY" -H "content-type: application/json" \
  -d '{"list_id":"LIST_ID","email":"ada@example.com","consent":"Signed up at the conference"}'

curl -X POST https://YOUR_APP/api/v1/mail/subscribers/import \
  -H "authorization: Bearer YOUR_API_KEY" -H "content-type: application/json" \
  -d '{"list_id":"LIST_ID","consent":true,"csv":"email,first_name\nada@example.com,Ada"}'

# One product email. A retry with the same key never sends twice.
curl -X POST https://YOUR_APP/api/v1/mail/send \
  -H "authorization: Bearer YOUR_API_KEY" -H "content-type: application/json" \
  -H "idempotency-key: order-1042-receipt" \
  -d '{"to":"ada@example.com","template":"receipt","data":{"first_name":"Ada","total":"12.00"}}'

# Report a bounce from your own provider webhook
curl -X POST https://YOUR_APP/api/v1/mail/bounces \
  -H "authorization: Bearer YOUR_API_KEY" -H "content-type: application/json" \
  -d '{"email":"gone@example.com","type":"bounce"}'
```

Other endpoints: `lists`, `fields`, `subscribers` (list, get, patch, `unsubscribe`, delete, `tag`, `export.csv`), `segments` (and `segments/count`), `broadcasts` (create, patch, `preview`, `test`, `check`, `stats`, `send`, `schedule`, `unschedule`, `pause`, `resume`, `duplicate`), `lists/:id/sequence`, `templates`, `sent`, `feeds`, `suppressions`, `bounces/import`, `stats`, `settings`, `status`. Sending a broadcast needs `mail:send`.

## Events

`subscriber.created`, `subscriber.confirmed`, `subscriber.unsubscribed`, `subscriber.bounced`, `broadcast.scheduled`, `broadcast.sent`, `broadcast.failed`, `email.sent`, `sequence.completed`. Each payload carries the record id, the newsletter id and a timestamp, never the message body.

## Jobs and schedules

- Job `mail.send-batch` sends one batch of a broadcast.
- Every minute: a watchdog that restarts stalled sends, and the sequence runner. Every hour: the RSS feed check.

## Not yet

- Custom sending domains and DKIM set-up inside the app.
- Automatic bounce and complaint feedback from the email provider.
- Open and click numbers are approximate: mail apps preload images.
