# Images

Share images and templated graphics from a URL. It covers what Bannerbear, Placid, Vercel OG and similar image APIs do for a small team. Module id `images`, tables `img_*`, scopes `images:read` and `images:write`.

## What it does

- Templates: a design made of text, picture, rectangle, ellipse and line layers. Any text, colour or picture can be bound to a named field with a default, written as `{{title}}`.
- A layer editor with live preview: select, drag, resize, nudge with the keyboard, undo and redo, autosave. Text wraps, shrinks to fit and cuts to a set number of lines with an ellipsis. The editor flags what it cannot draw (a missing font, characters with no glyph, a missing picture, cut text).
- Nine starter templates (blog post, launch card, X card, quote, story, video thumbnail, LinkedIn post, changelog, product card) and size presets: link preview 1200 x 630, X card 1200 x 675, LinkedIn 1200 x 627, Instagram square 1080 x 1080, Instagram story 1080 x 1920, YouTube thumbnail 1280 x 720.
- An image from a URL: `GET /i/<template>.svg?title=Hello&sig=...`. Drawn on the first request, stored, and served from storage after that.
- Signed URLs by default. Each template has an "open" switch that lets anyone change the fields, an optional expiry per URL and an optional cap on new images.
- PNG without a paid plan: the dashboard and the generator page draw the PNG in the browser. The dashboard stores it and gives it a permanent URL.
- A public generator page per template (`/i/<template>/make`): a form made from the template's fields, live preview and a PNG download. No account needed.
- "Copy meta tags" for a page's share image, with a plain warning when the URL is an SVG that social networks will not show.
- Batches: up to 100 rows from CSV or JSON, drawn in the background, with a results CSV and a ZIP download.
- Your own pictures and TrueType fonts, stored in the workspace.
- Usage: new images, images served from storage, bytes, most requested images and a 30 day log of new images and failures.
- Templates export and import as JSON.

## Set-up

Turn the module on. The first screen shows a starter card with sample text, one title box, and the image URL and meta tags ready to copy. Open the URL once and the page shows that the first request arrived. There is no API key or form to fill in first.

Nothing else is needed on the free plan. To let the Worker draw PNG files itself, turn on "Draw PNG on the server" under Images, Settings. That needs the Workers Paid plan (see Limits).

## Pages

Dashboard under `/app/images`: template list, `/new`, `/import`, `/t/:id` (use and share), `/t/:id/edit` (design), `/t/:id/settings`, `/assets`, `/batch`, `/usage`, `/settings`.

Public paths under the prefix `/i`:

| Path | What |
| --- | --- |
| `/i/<slug>.svg`, `/i/<slug>.png` | The image. Query: one value per field, `w` (width in pixels, 16 to 2400), `v` (pin a design version), `exp` (expiry, set when the URL is made), `sig` |
| `/i/<slug>/make` | Generator page, when the template has it turned on |
| `/i/<slug>/make.json` | The published design for the generator page's script |
| `/i/<slug>/image?src=` | A picture the published design itself names, for the generator page |
| `/i/a/<id>` | An uploaded picture or font |

Template slugs are unique across the install. A failed image request answers with a short text and an `x-images-error` header holding the error code.

## URLs, signing and caching

- A signed URL covers the template and every value in it. Change one character and the answer is 403 `images.bad_signature`. An unsigned URL is refused (`images.signature_required`) unless the template is open.
- On an open template only the template's own fields are read, each cut to its length limit; other query names are ignored. Picture fields in an unsigned URL accept only uploaded pictures, never a web address. New images from unsigned URLs are limited to 30 a minute per connection.
- Web pictures in signed URLs and designs must come from a site on the workspace's allow list. They are fetched once with a 5 second timeout and a 2 MB cap, checked to be a real PNG, JPEG, WebP or GIF, and kept in storage. They are never loaded again on each request.
- The storage key is a hash of the template, its design version, the format, the width and the normalised values. Publishing a change makes a new version.
- A plain URL always shows the latest published design and is cached for one hour (`Cache-Control: public, max-age=3600`). A URL made with "pin" carries `v=<version>` and keeps its look after later edits; it is cached for a year and marked immutable. If the stored file for a pinned version has been cleared, the current design is drawn instead, because old designs are not kept.
- Every image has an `ETag`; `If-None-Match` answers 304. `x-images-cache` says `hit` or `miss`.
- SVG output holds no scripts, no outside references and no fonts: text is drawn as outlines, pictures are embedded. It is served with a locked-down content security policy.

## API

Base `/api/v1/images`. Reading needs `images:read`, changing needs `images:write`. Errors use the shared JSON shape. Lists take `?limit=&cursor=` and answer `{ items, nextCursor }`.

```
curl -H "Authorization: Bearer $KEY" https://your.host/api/v1/images/templates
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"name":"Blog post","starter":"blog","publish":true}' https://your.host/api/v1/images/templates
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"values":{"title":"Hello"},"format":"svg","pin":true,"expiresIn":86400}' \
  https://your.host/api/v1/images/templates/<id>/url
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"template":"<id>","values":{"title":"Hello"},"format":"svg"}' https://your.host/api/v1/images/render
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: image/png" --data-binary @card.png \
  "https://your.host/api/v1/images/templates/<id>/bake?title=Hello"
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"templateId":"<id>","rows":[{"title":"One"},{"title":"Two"}]}' https://your.host/api/v1/images/batches
```

`POST /render` draws and stores one image and answers `{ image: { url, format, width, height, bytes, cached, warnings }, metaTags }`. `POST /templates/:id/url` only makes a URL; the image is drawn when it is first opened. `POST /batches` answers 202; poll `GET /batches/:id` until `status` is `done` or `failed`.

Routes: templates (`GET/POST /templates`, `GET/PATCH/DELETE /templates/:id`, `POST /templates/import`, `POST /templates/:id/publish|revert|duplicate|clear|preview|url|bake`, `GET /templates/:id/export`), `POST /render`, `GET /starters`, `GET /fonts`, assets (`GET/POST /assets`, `GET/DELETE /assets/:id`), `GET /picture?src=`, batches (`GET/POST /batches`, `GET/DELETE /batches/:id`, `GET /batches/:id/results.csv|download.zip`), `GET /usage`, `GET /log`, `GET/PUT /settings`.

Error codes, all starting with `images.`: `slug_taken`, `not_published`, `signature_required`, `bad_signature`, `link_expired`, `png_needs_bake`, `server_png_off`, `daily_cap`, `template_cap`, `too_many_templates`, `bad_template`, `unsupported_file`, `bad_font`, `storage_full`, `image_host_not_allowed`, `bad_png`, `batch_running`, `batch_too_large`, `batch_empty`, `render_failed`. A drawn image can also carry warnings: `font_missing`, `missing_glyphs`, `complex_script`, `image_missing`, `text_cut`.

## Events

Sent through the shared event bus. Nothing is sent to outside addresses.

| Event | Data |
| --- | --- |
| `template.created` | `id`, `slug`, `name`, `width`, `height` |
| `template.updated` | `id`, `slug`, `name`, `version` |
| `render.completed` | `templateId`, `slug`, `format`, `width`, `bytes`, `url`, `source` (`api` or `batch`). Not sent for images made by URL |
| `batch.completed` | `id`, `templateId`, `total`, `done`, `failed` |
| `quota.reached` | `kind` (`daily` or `template`), `limit`, optional `templateId`. At most once a day for each |

Jobs: `batch` (draws a batch in steps) and `purge` (removes stored files after a template or batch is deleted). Schedules: `images.rollup` hourly (adds the hit counts to each image) and `images.prune` daily.

## Fonts and scripts

Bundled, all under the SIL Open Font License: Inter (400, 600, 800; Latin, Latin Extended, Cyrillic, Greek, Vietnamese), Libre Baskerville (400, 700; Latin, Latin Extended), JetBrains Mono (500; Latin, Latin Extended, Cyrillic, Greek) and Noto Emoji in one colour. A character no font covers is drawn as the font's own missing-character box and reported as `missing_glyphs`, so it is never dropped without a sign. Scripts that need shaping or right-to-left layout (Arabic, Hebrew, Devanagari, Thai and others) and CJK are reported as `complex_script` or `missing_glyphs`; upload a font for CJK. Uploaded fonts must be TrueType (`.ttf`) with glyph outlines, 5 MB at most.

## Limits and cost

Measured with the 1200 x 630 blog post starter (five layers, three of them text) in a local Worker:

| What | Time | Plan |
| --- | --- | --- |
| SVG, fonts already in memory | under 1 ms | Free |
| SVG, first request on a fresh Worker (reads the font files) | about 4 ms | Free |
| PNG drawn on the server (resvg) | 32 to 67 ms | Workers Paid |
| PNG drawn in the browser, then stored | none on the Worker | Free |
| Any stored image | no drawing | Free |

The free plan allows about 10 ms of CPU per request, so PNG on the server is off by default and `/i/<slug>.png` answers 404 `images.png_needs_bake` until the PNG has been made in the browser. Local timings are a guide, not a promise: check your own numbers in the Cloudflare dashboard.

Bundle weight: the module's own code is about 113 KB minified. The PNG engine adds an 8 KB loader and a 2.48 MB WebAssembly file (about 0.95 MB compressed), which counts toward the Worker size limit (3 MB compressed on Free, 10 MB on Paid) even when server PNG is off. The bundled fonts (1.9 MB) are static files and do not count.

Per request: a stored image costs two database reads, one file read and one row write after the response. A new image costs four reads, four row writes and one file write, plus one more row write for the rate limit when the URL is unsigned. On the free plan's 100,000 requests and 100,000 row writes a day that is roughly 90,000 stored images served and the default 1,000 new images a day. The module does not use KV. A batch of 100 rows is 20 queue messages for SVG (five rows a message) and 100 for PNG (one row a message).

Caps: 200 templates, 40 layers and 20 fields per template, canvas 16 to 2400 px a side, design file 64 KB, text 2,000 characters per layer, 200 uploads and 100 MB per workspace, pictures 2 MB and 4096 px a side, fonts 5 MB, baked PNG 5 MB, 100 rows per batch, new images per day 1,000 by default (0 to 100,000). The log is kept 30 days, daily totals 400 days. A workspace export holds the newest 5,000 rows of each table.

The "Time" in the log is mostly time spent waiting for fonts and pictures. Cloudflare stops the clock while a Worker computes, so a quick draw reads 0 ms. Days and times are UTC.

## Privacy

Image requests set no cookies and store no IP address. Rate limits use a salted hash of the connection that changes daily. The log keeps the template, format, size, time taken and, for failures, the error; it does not keep who asked. Field values are stored with each image (they are the image). Anyone with an image URL or an uploaded file's address can open it, so do not put private text or files in them. The generator page loads nothing from other sites and is marked `noindex`.

## Not yet

- PNG by URL on the free plan. Use SVG, or make the PNG in the browser.
- JPEG, WebP and AVIF output, and resizing pictures from other sites.
- Edge caching with the Cache API: every request reaches the Worker, though stored images are not drawn again.
- Colour emoji, kerning, right-to-left and shaped scripts, OpenType (CFF, `.otf`) and WOFF fonts.
- QR code layers, rotation for lines that slope up to the right, and renaming a field or picking a size preset inside the editor.
- Keeping old versions of a design. A pinned URL keeps its stored picture, not the design behind it.
- Automatic clean-up of stored images that are no longer asked for. Use "Clear stored images" on a template. Stored files are also not removed when a workspace is deleted.
- Counting downloads from the generator page. The PNG is made in the visitor's browser and never reaches the server.
- Custom domains. Image URLs use the app's own host.
- Outbound webhooks. Events go to the shared event bus only.
