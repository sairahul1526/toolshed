# Analytics

Privacy-friendly web analytics: who visits your sites, where they come from and what they do, with no cookies and no consent banner. It covers what Plausible, Fathom, Simple Analytics, Umami and the web analytics part of PostHog do for a small team. Module id `analytics`, tables `an_*`, scopes `analytics:read` and `analytics:write`.

## Set up in a minute

1. Open **Analytics**, choose **Add a site** and enter the domain.
2. Copy the one line it shows into the `<head>` of your pages:

   ```html
   <script defer data-site="YOUR_SITE_KEY" src="https://your.host/m/analytics/t.js"></script>
   ```

3. Open your site in another tab. The set-up page checks every few seconds and says "It works" when the first page view arrives.

No site of your own yet? **Add the sample site** on the empty screen makes a pretend site with a month of visits. Remove it with one click.

## What it does

- Visitors, page views, views per visit, bounce rate and visit time, with a chart by hour, day or month.
- Top pages, entry pages and exit pages. Sources and channels. Campaign tags (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`). Countries, regions and cities. Devices, browsers and systems.
- Click any row to filter the whole page by it. Filters live in the address, so a view can be bookmarked or sent to someone.
- Date ranges: today, yesterday, last 7 or 30 days, this month, last month, last 12 months, this year, or your own dates. Compare with the period before.
- Visitors on the site now (last five minutes).
- Custom events with properties, and goals (an event name or a page path, `*` allowed) with conversion rates.
- Channels: Direct, Search, Paid search, Social, Paid social, Email, Referral, Campaign and **AI assistants** (ChatGPT, Claude, Perplexity, Gemini, Copilot and similar get their own channel).
- Share links: a public read-only dashboard, with an optional password and expiry, and an embed for your own pages.
- Several sites per workspace (up to 50) with an all-sites overview.
- CSV export of every report, and a full export of raw hits.
- A weekly email report and a traffic spike alert per site.
- A data health panel: hits stored today and hits refused in the last seven days, by reason.

## The script

`/m/analytics/t.js` is a static file of about 1.8 KB gzipped. It sets no cookie and keeps no identifier in the browser. It records:

- page views, including address changes in single-page apps (`history.pushState`, back and forward),
- clicks on outbound links (event `Outbound link`) and on links to files (event `File download`),
- pages that answered 404 (event `404`), where the browser reports the status. Elsewhere call `toolshed('404')` on your not-found page,
- time on page, with a small ping when the tab is hidden or closed.

Options are attributes on the script tag:

| Attribute | What it does |
| --- | --- |
| `data-site` | The site key. Required. |
| `data-api` | Where hits go. Defaults to `/a/e` on the host the script came from. |
| `data-hash` | Count the part after `#` as part of the page, for apps that route with the hash. |
| `data-manual` | Send no automatic page views. Call `toolshed('pageview')` yourself. |
| `data-no-pings` | Send no time-on-page pings. |

Send your own events from the page:

```html
<script>window.toolshed = window.toolshed || function () { (toolshed.q = toolshed.q || []).push(arguments); };</script>
<script>toolshed('Signup', { plan: 'pro' });</script>
```

The first line is only needed when you call `toolshed` before the script has loaded. An event takes up to 30 properties; names are cut at 120 characters.

For pages where scripts cannot run, use the pixel. It counts a page view from the address the browser reports, and cannot see the referrer, time on page or events:

```html
<noscript><img src="https://your.host/a/p.gif?k=YOUR_SITE_KEY" alt="" width="1" height="1" referrerpolicy="no-referrer-when-downgrade"></noscript>
```

The script does nothing on `localhost`, on `file:` pages, in automated browsers, or in a browser that opened `https://yoursite.example/#toolshed-ignore` (this is how you leave your own visits out; `#toolshed-unignore` turns counting back on).

## Privacy

- No cookies and nothing stored in the visitor's browser. The one exception is the opt-out flag `toolshed_ignore`, set only when someone opens the opt-out address themselves.
- A visitor is a hash of the site, IP address, browser and a secret that changes every day at 00:00 UTC. The IP address is never stored, and yesterday's visitors cannot be linked to today's.
- Because of that, **visitors for a range of several days is the sum of each day's visitors**. Someone who comes on Monday and Tuesday counts twice. The dashboard says so under the numbers.
- Do Not Track is ignored unless you turn on "Respect Do Not Track" in the site's settings.
- A share link with a password sets one cookie, `an_share`, on the person who typed the password, scoped to that link, for seven days.
- Site visitors are rate limited in memory, by their visitor hash. People who open a public dashboard or try a share password are rate limited by IP address: that address sits in a counter row that is deleted within two days.

## How counting works

- A visit ends after 30 minutes without a hit, or at midnight in the site's time zone. A visit that crosses midnight is counted as two.
- The source of a visit is where its first page view came from. It does not change within the visit.
- A visit is a bounce when it had one page view and less than ten seconds on the page.
- Times are stored in UTC and totalled by day in the site's time zone.
- Totals are added up by a job that runs every hour, and when someone opens a report. Reports can be up to a minute behind, the all-sites overview and public dashboards up to five minutes.
- Filtered views are counted from single hits. Hits are kept for the site's retention time (7, 30, 90, 180 or 365 days, 30 by default) and deleted daily after that; daily totals are kept for good. For a filtered range older than that, the page says only totals are kept. A filtered comparison with a period older than the retention time is left out.
- Regions and cities exist only inside the retention time.
- Under a page or event filter, visits, bounce rate and visit time describe parts of visits, and the page says so.

## What is refused

Hits are checked before they are stored. The visitor's browser always gets the same empty `202` answer; a refused hit is counted for the data health panel instead.

| Reason | Meaning |
| --- | --- |
| `bot` | A known crawler or headless browser. |
| `prerender` | The page was loaded ahead of time, not seen. |
| `localhost` | The page was on a local address. |
| `origin` | The page's host is not the site's domain or one of its allowed domains (`*.example.com` allows subdomains). |
| `dnt` | Do Not Track was on and the site respects it. |
| `excluded` | The path or IP address is on the site's exclude list. |
| `spam` | The referrer is a known spam domain. |
| `rate` | More than 60 hits a minute from one visitor, or 3,000 a minute for the site. |
| `cap` | The site passed its daily limit. |
| `invalid` | The hit could not be read. |

## Limits on the Cloudflare free plan

Each stored hit (page view, event or time-on-page ping) is one database batch of two statements that runs after the browser has its answer: one row for the hit and one for the visitor's day. There is no KV write per hit and at most one KV read per day per running copy of the app.

| | 10,000 hits a day | 100,000 hits a day |
| --- | --- | --- |
| Hit and visitor rows written | 20,000 | 200,000 |
| Hourly totals written | about 5,000 | about 15,000 |
| Rows deleted later by pruning | about 13,000 | about 130,000 |
| Rows read by the totals job | 10,000 | 100,000 |
| **Rows written in all** | **about 38,000** | **about 345,000** |

That is about 3.8 rows written and three to four rows read per hit. The free plan allows 100,000 rows written a day across the whole install, so it carries about **25,000 hits a day**, which is roughly 15,000 to 17,000 page views a day with time-on-page pings on (about 25,000 with `data-no-pings`). Each hit is also one of the plan's 100,000 daily requests. 100,000 hits a day needs the paid plan.

Each site has a daily limit (20,000 hits by default, changeable in settings). Past it, hits are dropped and counted under `cap`. Nothing breaks on your site: the browser still gets `202`. The "stored today" number is an estimate that moves in steps of 16, because only one hit in 16 touches the counter.

Other limits: 50 sites per workspace, 30 goals and 20 share links per site, 1,000 stored hits per visitor per day, 8 KB per hit, paths cut at 300 characters. Public dashboards are cached for a minute, and one address may load 30 different uncached pages a minute. Eight wrong passwords in ten minutes lock a share link for that address.

## Pages

Dashboard under `/app/analytics`: all sites, `/new`, `/sites/:id` (the dashboard), `/sites/:id/setup`, `/sites/:id/breakdown/:dim`, `/sites/:id/events/:name`, `/sites/:id/goals`, `/sites/:id/share`, `/sites/:id/export`, `/sites/:id/settings`.

Public paths, under the prefix `/a`:

| Path | What |
| --- | --- |
| `POST /a/e` | One hit, as JSON in a text body. Always answers `202` with no body. |
| `GET /a/p.gif` | Pixel for pages without scripts. `k` is the site key. |
| `/a/share/<token>` | Public dashboard. Not indexed. Range and compare only, no filters. |
| `/a/share/<token>/embed` | The same without the page frame, allowed inside an `iframe` on any site. Add `?theme=dark` or `?theme=light`. |

A share link with a password cannot be unlocked inside an embed. The embed shows a link to open it in a new tab.

## API

Base `/api/v1/analytics`. Reading needs `analytics:read`, changing things and sending events needs `analytics:write`. Lists answer `{ "items": [...], "nextCursor": null }` and take `?limit=&cursor=` where there can be more than one page.

```
# Sites
curl -H "Authorization: Bearer $KEY" https://your.host/api/v1/analytics/sites
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"domain":"example.com","timezone":"Europe/Berlin"}' https://your.host/api/v1/analytics/sites

# Stats: totals, a time series and a breakdown
curl -H "Authorization: Bearer $KEY" "https://your.host/api/v1/analytics/sites/$SITE/stats?period=30d&compare=1"
curl -H "Authorization: Bearer $KEY" "https://your.host/api/v1/analytics/sites/$SITE/timeseries?from=2026-01-01&to=2026-01-31"
curl -H "Authorization: Bearer $KEY" "https://your.host/api/v1/analytics/sites/$SITE/breakdown/page?period=7d&country=DE&limit=20"
curl -H "Authorization: Bearer $KEY" "https://your.host/api/v1/analytics/sites/$SITE/breakdown/source?format=csv"

# Events API: record something from your own server
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"name":"Order paid","url":"https://example.com/checkout","props":{"plan":"pro"},"ip":"203.0.113.9","user_agent":"Mozilla/5.0 ..."}' \
  https://your.host/api/v1/analytics/sites/$SITE/events
```

| Route | What |
| --- | --- |
| `GET/POST /sites`, `GET/PATCH/DELETE /sites/:id` | Sites and their settings. Deleting needs an admin. |
| `GET /overview` | Today's numbers for every site. |
| `GET /sites/:id/stats` | Totals. `?compare=1` adds the period before. |
| `GET /sites/:id/timeseries` | Visitors and page views per hour, day or month. |
| `GET /sites/:id/breakdown/:dim` | `page`, `entry`, `exit`, `source`, `channel`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `country`, `region`, `city`, `device`, `browser`, `os`, `event`. `?format=csv` for a file. |
| `GET /sites/:id/conversions` | Every goal with its conversion rate. |
| `GET /sites/:id/events/:name/props` | Property values sent with one event. |
| `GET /sites/:id/live` | Visitors in the last five minutes. |
| `GET /sites/:id/health` | Hits stored today and refused, by reason. |
| `GET /sites/:id/hits` | Raw hits, oldest first. `?format=csv` gives up to 5,000 rows a call; the next cursor is in the `x-next-cursor` header. |
| `POST /sites/:id/events` | Record an event or page view (`"type":"pageview"`). |
| `GET/POST /sites/:id/goals`, `DELETE /sites/:id/goals/:goalId` | Goals. |
| `GET/POST /sites/:id/shares`, `DELETE /sites/:id/shares/:shareId` | Share links. |

Stats routes take `?period=` (`today`, `yesterday`, `7d`, `30d`, `month`, `lastmonth`, `12mo`, `year`) or `?from=&to=` as days in the site's time zone, and any filter: `page`, `source`, `channel`, the five `utm_*`, `country`, `region`, `city`, `device`, `browser`, `os`, `event`, `goal`.

Pass the visitor's own `ip` and `user_agent` to the Events API so the event joins the visit their browser started. Without them, every server event belongs to one visitor.

## Export

- Each report has a CSV link, and the export page lists them all.
- Raw hits download in parts of 5,000 rows from the export page, or page through `GET /sites/:id/hits`.
- The workspace export includes every `an_*` table. Sites, goals, share links (without password hashes), counters and daily totals go in whole (totals up to 40,000 rows); raw hits are limited to the newest 10,000 and open visits to 5,000.

## Emails and alerts

- **Weekly report**: Mondays from 08:00 in the site's time zone, to the addresses in the site's settings. Visitors, page views, top pages and top sources against the week before.
- **Traffic spike**: when the last hour had more visitors than the threshold you set (0 turns it off). At most once every 12 hours per site. Also shows as a notification in the app.

Both need email to be set up for the install. Until then the settings page says so and links to `/app/email`; everything else keeps working.

## Events

| Event | When | Data |
| --- | --- | --- |
| `analytics.site.created` | A site is added. | `domain`, `name` |
| `analytics.goal.completed` | A goal gained completions. Sent by the hourly job, never per hit: at most one event per goal per hour, carrying how many were added, and at most five goals per site per hour. | `siteId`, `domain`, `goal`, `kind`, `match`, `completions`, `day`, `dayTotal` |
| `analytics.traffic.spike` | The last hour passed the site's threshold. At most once every 12 hours per site. | `siteId`, `domain`, `visitors`, `threshold` |
| `analytics.report.sent` | A weekly report went out. | `siteId`, `domain`, `week`, `recipients` |

Nothing is sent per page view.

## Jobs

`hourly` (every hour: add up totals, goal events, spike check, weekly report, a few sites per run), `prune` (daily: delete hits past the retention time), `purge` (after a site is deleted), `report` and `alert` (one email each).

## Not yet

- A drawn map. Countries, regions and cities are tables.
- Filtering by entry or exit page.
- Filters on public dashboards, and password-protected embeds.
- Custom domains for the script or for share links.
- Funnels, cohorts, revenue and a "last 24 hours" range.
- Importing history from another analytics product.
