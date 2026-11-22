# Links

Short links, QR codes and bio pages. It covers what Bitly, Dub, Short.io, Rebrandly and Linktree do for a small team. Module id `links`, tables `links_*`, scopes `links:read` and `links:write`.

## What it does

- Short links with a random or custom code, title, notes, tags, folders, archive and restore, duplicate and delete.
- A redirect engine: one KV read on the hot path, D1 on a miss, 301, 302 or 307, clicks recorded after the response.
- Controls: start date, expiry, click cap, password, and a destination to use after expiry.
- Rules by country, device or system, with the main destination as the default.
- Share preview (title, description, image) and a campaign tag (UTM) builder.
- QR codes as SVG with colour, margin and size options. PNG is drawn in the browser by a small script.
- Bio pages with link, heading and text blocks, ordering, a theme or your own colours, and a click count per block. No script runs on the public page.
- Stats per link and for the workspace: clicks and uniques by day, referrer, country, city, device, browser, system and UTM. Bots are counted apart.
- CSV import with a column mapping step and a skipped-rows report. CSV export of links, daily stats and recent clicks.
- Abuse controls: a report form, a blocked-domains list, scheme checks and rate limits.
- First run: one box, one button, and the short link with its QR code ready to copy. Sample data can be added and removed.

## Pages

Dashboard under `/app/links`: list, `/new`, `/:id` (editor), `/stats`, `/bio`, `/import`, `/settings`.

Public paths: `/<code>` (the redirect, through the module fallback) and the prefix `/l`:

| Path | What |
| --- | --- |
| `/l/p/<code>` | Password form |
| `/l/preview/<code>` | Preview of where a link goes |
| `/l/report/<code>` | Report form |
| `/l/b/<blockId>` | Bio block click, then redirect |
| `/l/s/<code>.css` | Bio custom colours |
| `/l/qr/<code>` | QR code SVG. Query: `fg`, `bg` (hex without `#`), `margin`, `size`, `ecc`, `download=1` |

Bio pages and short links share one namespace of codes. Some codes are reserved for the app.

## API

Base `/api/v1/links`. Reading needs `links:read`, changing needs `links:write`. Errors use the shared JSON shape and `links.*` codes.

```
curl -H "Authorization: Bearer $KEY" https://your.host/api/v1/links
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"url":"https://example.com/page","code":"spring","tags":["campaign"]}' \
  https://your.host/api/v1/links
curl -X PATCH -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"title":"Spring sale","expiresAt":"2030-01-01T00:00:00Z"}' https://your.host/api/v1/links/<id>
```

Routes: links (`GET/POST /`, `GET/PATCH/DELETE /:id`, `POST /:id/archive|restore|duplicate`, `GET /:id/stats`), `POST /bulk`, `POST /actions`, `GET /stats`, `GET /stats/top`, `GET /tags`, folders (`/folders`), bio pages (`/bios`, `/bios/:id`, `/bios/:id/blocks`, `/bios/:id/order`, `/bios/:id/stats`, `/blocks/:id`), `/blocklist`, `/reports`, `/import/preview`, `/import`, `/export/links.csv|daily.csv|clicks.csv`, `/settings`.

## Events

Sent through the shared event bus. Nothing is sent to outside addresses.

| Event | Data |
| --- | --- |
| `link.created` | `code`, `url`, optional `duplicatedFrom`, or `bulk` and `count` |
| `link.updated` | `code`, `changed` (field names) or `bulk` |
| `link.deleted` | `code` |
| `link.clicked` | `code`, `clicksToday`. Only at 1, 10, 100, 1000 and so on per day, so busy links do not flood the bus |
| `link.expired` | `code`, `reason` (`end_time` or `click_cap`) |
| `link.reported` | `code`, `reason`, `reportId` |
| `bio.updated` | `code`, `change` |

Schedules: `rollup` and `expire`, both hourly.

## Limits and cost

Built for the free plan: a human click is one batch of two row writes, a bot click one write. KV is read once per redirect and written when the cache fills (6 hours for links, 1 hour for passwords and previews). Raw clicks are kept 7 days, daily rollups 400 days. Bio pages hold at most 60 blocks and stay under 30 KB.

## Privacy

No IP addresses are stored. Country and city come from the request headers the platform adds. Uniques use a salted daily hash that cannot be turned back into a person. Passwords are hashed with PBKDF2.

## Not yet

- Custom domains. Links use the app's own host.
- A/B split tests.
- Stats days are UTC, not the workspace time zone.
- After a link is archived or the module is turned off, a cached redirect can keep working for up to 6 hours.
- The bio avatar uses an address you provide, so the visitor's browser loads it from that host.
- Codes cannot contain slashes.
