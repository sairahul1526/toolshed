# Monitor

Know when a site or cron job goes down, tell the right people, and show customers a public status page. It replaces a hosted uptime checker, a status page service and a cron-job watcher with one module on your own Worker.

## Set up in a minute

1. Turn the module on under Modules, then open Monitor.
2. Paste your website address and press Check it now. The first check runs straight away.
3. Add an alert channel under Alerts. "Email me" is one click when email is set up.
4. Optionally create a status page, add components, and share the link.

Subscriber emails (confirm and unsubscribe links) need `APP_URL` set to your public address.

## What it does

- HTTP checks every 1, 5, 10, 30 or 60 minutes: expected status codes, keyword present or absent, timeout, redirects, method, headers, body. Down after N failed checks, with a quick second look before counting a failure.
- Cron heartbeats: a ping address per job (`/hb/<token>`, plus `/start` and `/fail`). Down when a ping is late past its grace time.
- Six alert channels: email, Slack, Discord, Microsoft Teams, Telegram and signed webhooks. Recovery notices, slow alerts, repeat reminders and quiet hours per channel.
- Maintenance windows (once or repeating) that pause alerts and show on the status page.
- Incidents opened automatically on a down monitor, or by hand, with a timeline and a postmortem.
- Public status pages at `/status/<slug>`: groups, components, 90-day bars, incidents, maintenance, custom CSS, email subscribers, RSS and Atom feeds, `status.json`, an SVG badge and a one-line widget.
- Uptime history (24 hours to 90 days), response-time chart, CSV export and an UptimeRobot CSV import (20 monitors per upload).
- Optional "alive" ping out to your own heartbeat address, so you know the checker itself is running.

## REST API

Scopes: `monitor:read`, `monitor:write`. Base path `/api/v1/monitor`.

```
curl -H "Authorization: Bearer $KEY" https://your.host/api/v1/monitor/summary

curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"name":"Home","url":"https://example.com/"}' \
  https://your.host/api/v1/monitor/monitors

curl -X POST -H "Authorization: Bearer $KEY" https://your.host/api/v1/monitor/monitors/<id>/check
curl -H "Authorization: Bearer $KEY" https://your.host/api/v1/monitor/monitors/<id>/history?days=30
curl -H "Authorization: Bearer $KEY" https://your.host/api/v1/monitor/export/monitors.csv
```

Resources: `monitors`, `channels`, `incidents` (with `/updates`), `maintenance`, `pages` (with `groups`, `components`, `order`, `subscribers`), `settings`, `import`.

## Events

Other modules can listen for these. Each carries the monitor id as the subject.

- `monitor.down`, `monitor.recovered`, `monitor.slow`
- `incident.opened`, `incident.updated`, `incident.resolved`
- `maintenance.started`, `maintenance.ended`
- `subscriber.added`

Webhook channels post JSON and sign it in the `x-toolshed-signature` header (HMAC-SHA256 of the body with the channel secret).

## Limits and capacity

On the free Cloudflare plan:

- About 20 checks a minute run inline in the one-minute cron with no queue use. More than that is split into chunks of 20, each costing about 3 queue operations.
- An uncached status page costs about 12 database queries. Pages are cached for about two minutes.
- Limits: 100 monitors, 10 status pages, 100 components per page, 5000 subscribers per page.

## Privacy

Monitors only call the addresses you give them, and refuse localhost and private network addresses. Status pages set no cookies and load no third-party files. Subscriber addresses are stored only for sending updates, and every email has an unsubscribe link. Secrets (webhook URLs, bot tokens) are stored privately and shown only as a short prefix.

## Not yet

- Checks from several regions (all checks run from Cloudflare's network near the Worker).
- Ping, port, DNS and SSL-expiry checks.
- SMS and phone-call alerts.
- Status page custom domains.
- Teams and roles per status page.
