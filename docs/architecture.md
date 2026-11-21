# How Toolshed is built

Toolshed is one Cloudflare Worker. This page explains where code goes and the rules every module follows. Read it before adding a module or a dashboard screen.

## The pieces

| Piece | Cloudflare product | Binding | Used for |
|---|---|---|---|
| Database | D1 | `DB` | Everything that is stored |
| Cache | KV | `KV` | Hot lookups that can be a little stale (short-link targets, public page HTML) |
| Files | R2 | `FILES` | Uploads and exports |
| Jobs | Queues | `JOBS` | Background work with retries |
| Schedules | Cron | (none) | One trigger a minute; code decides what is due |
| Static files | Workers Assets | `ASSETS` | Everything in `public/` |
| Email | Email Sending | `EMAIL` (optional) | Sign-in codes, invites, notifications |

The pages are rendered on the server with [Hono](https://hono.dev) and its JSX. There is no client framework and no build step for the dashboard: a page is HTML, one stylesheet and a few small scripts.

## Layout

```
src/
  index.ts              Worker entry: HTTP, queue, schedule
  app.tsx               Builds the app. Route order lives here
  env.ts                Bindings and per-request values (user, org, auth)
  core/                 Services every module uses (see below)
    migrations/         Core tables, add-only
  auth/                 Sign-in, sessions, the request loader
  ui/                   The UI kit: layout, components, icons
    routes/<name>.ts    Core API routes. Default-exports { api?, public? } → /api/v1/<name>
  dashboard/<name>/     Core screens. index.tsx default-exports a Hono app → /app/<name>
  modules/<id>/         One product each (see "A module")
  generated/            Written by scripts/prepare.mjs. Not in git
public/                 Static files, served as-is
  assets/               The UI kit's CSS and JS
  m/<id>/               A module's own static files (embeds, widgets)
scripts/prepare.mjs     Finds modules, screens and migrations
test/                   Unit tests (Vitest) and test/e2e (Playwright)
  helpers/d1.ts         In-memory bindings for unit tests
```

`scripts/prepare.mjs` runs before every dev, test and typecheck command. It writes `src/generated/modules.ts`, `screens.ts` and `routes.ts`, and copies every migration into `migrations/` with names that sort core first. You never register a module or a screen by hand.

## Routes

| Path | Who serves it | Sign-in |
|---|---|---|
| `/healthz` | `app.tsx` | No |
| A module's public paths (`publicPrefixes`) | The module's `public` app | No. These skip the session lookup to stay fast |
| `/sign-in`, `/setup`, `/invite/:id`, `/welcome`, `/api/auth/*` | `src/auth` | Their own rules |
| `/app` | `src/dashboard/overview` | Signed in, in a workspace |
| `/app/<name>` | `src/dashboard/<name>` | Signed in, in a workspace |
| `/app/<moduleId>/*` | The module's `dashboard` app | Signed in, module turned on |
| `/api/v1/<name>/*` | A core route file, `src/core/routes/<name>.ts` | Session cookie, API key or JWT |
| `/api/v1/<moduleId>/*` | The module's `api` app | Session cookie, API key or JWT; module turned on |
| `/dev/*` | Dev helpers (`/dev/ui`, `/dev/outbox`) | Only when `ENVIRONMENT=dev` |
| Anything else | Each module's `fallback`, then a 404 | No |

Every request has these values (`c.get(...)`):

- `user`: the signed-in person, or `null`.
- `org`: the active workspace and the caller's role in it (`owner`, `admin`, `member`, `viewer`), or `null`.
- `auth`: how the request proved itself (`session`, `apikey`, `jwt` or `anon`) and its scopes.
- `requestId`: shown on error pages and in API errors.

Guards in `core/guards.ts` read those values: `requireUser`, `requireOrg('admin')`, `requireScope('links:write')`, `requireInstanceOwner`, `needRole(c, 'admin')`. The app already applies `requireUser` and `requireOrg()` to everything under `/app` and `/api/v1`, plus a same-origin check on anything that changes data. A module adds `requireScope` to its API routes and `needRole` where an action needs more than Viewer.

## A module

A module is a folder. Nothing outside it changes when you add one.

```
src/modules/links/
  module.ts             default-exports defineModule({...})
  migrations/0001_init.sql
  dashboard.tsx         Hono app for /app/links
  api.ts                Hono app for /api/v1/links
  public.ts             Hono app for public paths
  service.ts            The logic, called by all three
  links.test.ts         Unit tests next to the code they test
public/m/links/         Static files, if it has any
test/e2e/links.e2e.ts   End-to-end tests
```

`module.ts` describes the module (the full type is `ModuleDef` in `core/module.ts`):

```ts
import { defineModule } from '../../core/module';

export default defineModule({
  id: 'links',                       // also the URL segment
  name: 'Links',
  description: 'Short links with click counts',
  icon: 'link',
  category: 'growth',
  version: '0.1.0',
  permissions: [
    { scope: 'links:read', label: 'See links and clicks' },
    { scope: 'links:write', label: 'Create, edit and delete links' },
  ],
  tables: ['links', 'link_clicks'],  // every table it owns
  dashboard, api,
  public: publicApp, publicPrefixes: ['/l'],
  fallback,                          // optional: claim otherwise-unmatched paths
  jobs: { rollup: async (env, payload) => { /* ... */ } },
  schedules: [{ name: 'rollup', every: 'hour', run: async (env, at) => { /* ... */ } }],
  events: { emits: ['link.created', 'link.clicked'] },
  count: (ctx) => ctx.db.count('links'),
  overview: async (ctx) => [{ label: 'Clicks, 7 days', value: '1,204' }],
  onboarding: { title: 'Share a short link', body: 'Turn a long address into one you can say out loud.' },
  sampleData, clearSampleData,
});
```

Rules:

1. **Every table has `org_id TEXT NOT NULL`**, and every table is listed in `tables`. That list is how a deleted workspace's data is removed and how Export finds it.
2. **Query through `orgDb(env.DB, orgId)`** (`core/db.ts`). Its helpers add the workspace filter for you, and its raw `all/first/run` refuse SQL that has no `:org`. Use `env.DB` directly only on public paths that start from a slug or code, to find the row; then switch to `orgDb` with that row's `org_id`.
3. **Migrations only add.** Never edit a released migration file; add the next number. Files are plain SQL in `migrations/`, named `0001_init.sql`, `0002_add_tags.sql`.
4. **Ids are `newId('lnk')`**: prefixed, lowercase, and sortable by creation time. Times are integer milliseconds in columns ending `_at`.
5. **Public routes stay under `publicPrefixes`.** The app refuses to start if a public route falls outside them, or if two modules claim the same prefix. Module ids may not reuse a name in `RESERVED_IDS`.
6. **Errors carry stable codes.** Throw `errors.not_found()` and friends from `core/errors.ts`, or define the module's own with `defineErrors('links', { slug_taken: { status: 409, message: '…' } })`. Validate input with `parse(schema, data)` (Zod); it turns failures into one message per field. Never change a released code.
7. **Record what happened.** `emit(env, { orgId, module: 'links', name: 'link.clicked', subject: link.id })` counts the event per day (read back with `eventCounts`), keeps a short recent log, and delivers it to modules that subscribed with `events.on`. `auditFromRequest(c, { action: 'link.deleted', summary: '…' })` writes the audit log for changes an admin would want to trace.
8. **Slow work goes on the queue.** `enqueue(env, 'links.rollup', payload)` runs `jobs.rollup` with retries. On public hot paths, wrap follow-up work in `c.executionCtx.waitUntil(...)` so the visitor is not kept waiting.
9. **Strangers are rate limited.** Call `enforceRateLimit(env, 'forms.submit:<id>:<ip>', { limit: 10, windowSec: 60 })` on anything a visitor can repeat.
10. **Fit the Free plan.** About 10 ms of CPU and 50 subrequests a request. Keep public paths to one or two queries, or a KV read.

## Core services

| File | What it gives you |
|---|---|
| `core/db.ts` | `orgDb`, `newId`, `randomToken`, `parseJson` |
| `core/errors.ts` | `errors`, `defineErrors`, `AppError`, `parse`, `readJson` |
| `core/guards.ts` | `requireUser`, `requireOrg`, `requireScope`, `requireInstanceOwner`, `needRole`, `hasScope` |
| `core/registry.ts` | Which modules exist and which are on: `allModules`, `moduleStates`, `setModuleEnabled`, `getModuleSettings`, `setModuleSettings`, `moduleContext`, `exportModules`, `purgeOrgData` |
| `core/events.ts` | `emit`, `eventCounts`, `eventTotal`, `recentEvents` |
| `core/jobs.ts` | `enqueue`, `registerCoreJob`, `registerCoreSchedule` |
| `core/audit.ts` | `audit`, `auditFromRequest` |
| `core/email.ts` | `sendEmail`, `emailReady`, `devOutbox` |
| `core/ratelimit.ts` | `rateLimit`, `enforceRateLimit` |
| `core/settings.ts` | `getSetting`, `setSetting` for the install (`'instance'`) or a workspace |
| `core/apikeys.ts`, `core/jwt.ts` | `verifyApiKey`, `verifyJwt`, used by the request loader |
| `core/shell-data.ts` | `shellData(c)`: what the sidebar and top bar show |

## Tests

- **Unit tests** run in plain Node. `createTestEnv()` from `test/helpers/d1.ts` gives a fresh in-memory database with every migration applied, plus in-memory KV, R2 and a queue you empty with `drainJobs()`. Call `registerModules([yourModule])` when a test needs the registry.
- **Route tests** use `mountModule(t, yourModule)` from `test/helpers/app.ts`. It mounts the module's dashboard, API and public routes behind the real guards with a pretend caller, so you can check roles, API key scopes and public pages without signing in: `app.as({ role: 'viewer' })`, `app.as({ kind: 'apikey', scopes: ['links:read'] })`, `app.as({ kind: 'anon' })`.
- **End-to-end tests** (`test/e2e/*.e2e.ts`) run in a real browser against `wrangler dev` with an empty database. Emails sent in dev are readable at `/dev/outbox`, which is how tests sign in with a code.
- Every module ships both, and its screens are checked at desktop width, at 375 px and in dark mode.

## Local development

```bash
npm run dev          # http://127.0.0.1:8787, local D1/KV/R2/Queues, dev routes on
npm run check        # typecheck + unit tests
npm run test:e2e     # Playwright; starts its own server on PORT (default 8787)
```

Local secrets go in `.dev.vars` (copy `.dev.vars.example`). Nothing here needs a Cloudflare account.

## Shared helpers

Small, dependency-free helpers any module can import. Each one is covered by tests in `test/utils/`.

| Helper | What it is for |
| --- | --- |
| `core/net.ts`: `baseUrl`, `clientIp`, `geo` | The public address of the install, the visitor's IP, and country, region, city and time zone from Cloudflare. |
| `core/net.ts`: `parseUserAgent`, `isBot`, `isPreviewBot` | Device, browser and system for analytics, and telling people from crawlers and link-preview fetchers. |
| `core/net.ts`: `visitorId` | A 16 character id for counting unique visitors per day without storing the IP. It hashes a salt that changes every day, kept in KV for 48 hours. |
| `core/net.ts`: `assertPublicUrl`, `safeFetch` | Fetching an address a stranger typed. Refuses private and local addresses, checks every redirect, and caps time and size. |
| `core/markdown.ts`: `renderMarkdown`, `markdownToText`, `excerpt` | Markdown from strangers as safe HTML (raw HTML is shown as text), plain text for email, and short previews. |
| `core/csv-parse.ts`: `parseCsv`, `guessColumns`, `rowsToObjects` | Reading imports: quotes, byte order marks, `;` and tab files, then matching columns to fields. The writer is `core/csv.ts`. |
| `core/signing.ts`: `sign`, `verify`, `signedToken`, `readSignedToken` | Links that must not be forged (unsubscribe, confirm, download). Each purpose gets its own key derived from `AUTH_SECRET`. |

`assertPublicUrl` works on the text of the address only. A Worker cannot look up DNS, so a public name that points at a private address is not caught. Do not use `safeFetch` as the only protection for anything that sits on a private network.
