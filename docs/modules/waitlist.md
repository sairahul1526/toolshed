# Waitlist

Collect signups before launch, give each person a referral link, let people move up by inviting friends, and let them in in waves. Everything runs inside your workspace: no third-party requests, no visitor cookies.

Turn it on under Modules. The first screen offers a sample waitlist with 24 made-up people so you can look around, and removes it in one click.

## Set up

1. Create a waitlist. Pick a page address (`/w/<slug>`), a headline, button text and up to five questions.
2. Check email. If email is not set up for the workspace, the module says so on every screen. People can still join without confirming, and they are marked unverified. Referrals only count once the invited person has confirmed, so set up email before you promote the page.
3. Share the hosted page, the embed, a plain form or the JSON API (all shown in the editor).
4. Use Preview page to try the flow. Signups made through it are marked as tests, are left out of every number, and are cleared with one button.

## What it does

- Waitlists with custom questions, a hosted page with presets, a signup count and an optional launch date note.
- Embed with an iframe or a tiny script, a plain HTML form, and a JSON signup endpoint with CORS.
- Double opt-in, with confirm, welcome, milestone and you-are-in emails.
- Referral links and a personal status page with position, referrals and reward progress. Position is computed from signup order and confirmed referrals; it is never stored.
- Public leaderboard (names shortened to "Jo K.", never emails; switchable).
- Reward tiers by number of confirmed referrals.
- Fraud rules (off, relaxed, balanced, strict), blocked or allowed domains, throwaway domains. Held signups go to a review queue with the reason shown.
- Signups list with search, filters, detail page and bulk actions (approve, reject, tag, unsubscribe, remove).
- Invite waves with invite codes, and broadcasts to a segment. A broadcast needs a test send first, goes out in batches through the queue and resumes if interrupted.
- Stats by day, K-factor, sources, view-to-signup conversion and top referrers.
- Import CSV with column mapping, export CSV, erase one person.
- REST API and events.

## Public pages

| Path | Page |
| --- | --- |
| `/w/<slug>` | Hosted signup page (`?ref=CODE`, `utm_*` are picked up) |
| `/w/<slug>/embed` | The same form without chrome, for iframes |
| `/w/<slug>/join` | Form post or JSON signup (CORS open) |
| `/w/<slug>/me/<token>` | Personal status page |
| `/w/<slug>/confirm/<token>` | Confirm email |
| `/w/<slug>/leaderboard`, `.json` | Top referrers |
| `/w/<slug>/count.json` | Signup count |
| `/w/<slug>/invite/<code>` | Invite landing |
| `/w/unsubscribe/<token>` | Unsubscribe from marketing email |
| `/m/waitlist/embed.js` | Embed script |

Pages are under 30 KB. Signups are protected by a honeypot field, a signed timing token (a form sent in under two seconds is refused) and a per-visitor rate limit. There is no CAPTCHA.

## API

Scopes: `waitlist:read`, `waitlist:write`. Base path `/api/v1/waitlist`.

```
curl https://YOUR_APP/api/v1/waitlist/waitlists -H "authorization: Bearer YOUR_API_KEY"
curl -X POST https://YOUR_APP/api/v1/waitlist/waitlists/WL_ID/signups \
  -H "authorization: Bearer YOUR_API_KEY" -H "content-type: application/json" \
  -d '{"email":"jo@example.com","name":"Jo"}'
```

Routes: `waitlists` (list, create, get, patch, delete), `waitlists/:id/tiers`, `waitlists/:id/signups` (list, create, get, patch, delete, `bulk`, `:sid/accept`), `review`, `test` (delete test signups), `waves`, `broadcasts`, `stats`, `export.csv`, `import`. Errors are JSON with a `code` and plain message.

Public signup response:

```
{ "ok": true, "status": "active", "needsConfirm": false, "position": 12,
  "referralCode": "k3x9", "referralLink": "https://.../w/launch?ref=k3x9", "statusUrl": "..." }
```

## Events

`signup.created`, `signup.confirmed`, `signup.referred`, `signup.milestone`, `signup.invited`, `signup.accepted`, `signup.flagged`, `signup.removed`. Each carries the waitlist id, the signup id and the time. Events are recorded for other modules; delivery to outside webhooks is not part of this module.

## Limits

- 10 emails per queue message; bulk actions run in chunks of 8 and the rest finish in the background.
- Import: up to 2,000 rows per file, 1.5 MB.
- The core email cap is 300 an hour, so a large broadcast spreads over several hours.
- D1 on the free plan allows 100,000 writes a day; each signup is a handful of writes.
- The signup endpoint uses few queries; counts, emails and events run after the response.

## Privacy

No cookies for visitors and no third-party requests. Visitors are counted with a keyed hash that cannot be reversed. Every marketing email has an unsubscribe link from a signed token. Erase removes a person's email, name and answers and keeps an anonymous count.

## Not yet

- Uploading a cover image (use an https address).
- Custom domains for the hosted page.
- Delivering events to outside webhooks.
- A live ticking countdown (the page shows days to go).
- An embed that resizes itself to its content.
