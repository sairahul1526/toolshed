/**
 * Builds the one Hono app: public module routes, auth, dashboard, API, dev routes, errors.
 * Route order matters here, so this file is edited only when the platform itself changes.
 * Modules and screens plug in through `src/modules/<id>/module.ts` and `src/dashboard/<name>/index.tsx`.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authApp, loadAuth } from './auth';
import { devOutbox } from './core/email';
import { AppError, errors, jsonError, toAppError, wantsJson } from './core/errors';
import './core/events';
import { requireOrg, requireUser, sameOrigin } from './core/guards';
import { RESERVED_IDS } from './core/module';
import { allModules, requireModule } from './core/registry';
import type { AppEnv } from './env';
import { isDev } from './env';
import { devUi } from './ui/dev';
import { ErrorPage } from './ui/error-page';

/**
 * A core route file, `src/core/routes/<name>.ts`, default-exports one of these.
 * `api` is mounted at /api/v1/<name> (signed in, inside a workspace). `public` is mounted at / with
 * no sign-in, for things like /.well-known/jwks.json; it must only declare exact paths it owns.
 */
export interface CoreRoutes {
  api?: Hono<AppEnv>;
  public?: Hono<AppEnv>;
}

export interface AppParts {
  /** Core dashboard screens by folder name. `overview` is mounted at /app, the rest at /app/<name>. */
  screens: Record<string, Hono<AppEnv>>;
  /** Core API routes by file name. */
  routes?: Record<string, CoreRoutes>;
}

export function createApp(parts: AppParts): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const modules = allModules();

  for (const name of Object.keys(parts.screens)) {
    if (modules.some((m) => m.id === name)) throw new Error(`A module and a core screen are both called "${name}"`);
    if (!RESERVED_IDS.includes(name)) throw new Error(`Add "${name}" to RESERVED_IDS in src/core/module.ts before adding the screen`);
  }
  const routes = parts.routes ?? {};
  for (const name of Object.keys(routes)) {
    if (!RESERVED_IDS.includes(name)) throw new Error(`Add "${name}" to RESERVED_IDS in src/core/module.ts before adding the core route`);
  }

  app.use('*', async (c, next) => {
    const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('user', null);
    c.set('org', null);
    c.set('auth', { kind: 'anon', scopes: [] });
    await next();
    c.header('x-request-id', requestId);
    c.header('x-content-type-options', 'nosniff');
    if (!c.res.headers.has('referrer-policy')) c.header('referrer-policy', 'strict-origin-when-cross-origin');
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (!(err instanceof AppError)) console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname}`, err);
    const appError = toAppError(err);
    if (wantsJson(c)) return jsonError(c, appError);
    for (const [k, v] of Object.entries(appError.headers ?? {})) c.header(k, v);
    return c.html(
      <ErrorPage status={appError.status} code={appError.code} message={appError.message} requestId={c.get('requestId')} signedIn={c.get('user') !== null} />,
      appError.status as ContentfulStatusCode,
    );
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // 1. Public module routes. No session lookup, so redirects, embeds and collect endpoints stay fast.
  for (const r of Object.values(routes)) if (r.public) app.route('/', r.public);
  for (const m of modules) if (m.public) app.route('/', m.public);

  // 2. Everything below may need to know who is asking.
  for (const path of ['/', '/app/*', '/api/*', '/sign-in', '/sign-in/*', '/sign-up', '/setup', '/setup/*', '/invite/*', '/welcome', '/welcome/*', '/dev/*']) {
    app.use(path, loadAuth);
  }

  // 3. Sign-in pages, first-run claim, invites, and /api/auth/*.
  app.route('/', authApp);
  app.get('/', (c) => c.redirect('/app'));

  // 4. Dashboard: signed in, inside a workspace, no cross-site posts, never framed.
  app.use('/app/*', requireUser, requireOrg(), sameOrigin, async (c, next) => {
    await next();
    c.header('x-frame-options', 'DENY');
    c.header('cache-control', 'no-store');
  });
  for (const [name, screen] of Object.entries(parts.screens)) {
    app.route(name === 'overview' ? '/app' : `/app/${name}`, screen);
  }
  for (const m of modules) {
    if (!m.dashboard) continue;
    app.use(`/app/${m.id}/*`, requireModule(m.id));
    app.route(`/app/${m.id}`, m.dashboard);
  }

  // 5. REST API: session cookie, API key or JWT.
  app.use('/api/v1/*', requireUser, requireOrg(), sameOrigin);
  for (const [name, r] of Object.entries(routes)) if (r.api) app.route(`/api/v1/${name}`, r.api);
  for (const m of modules) {
    if (!m.api) continue;
    app.use(`/api/v1/${m.id}/*`, requireModule(m.id));
    app.route(`/api/v1/${m.id}`, m.api);
  }

  // 6. Dev-only helpers.
  app.use('/dev/*', async (c, next) => {
    if (!isDev(c.env)) throw errors.not_found();
    await next();
  });
  app.get('/dev/outbox', async (c) => {
    const to = c.req.query('to');
    return c.json({ emails: await devOutbox(c.env, to ? { to } : {}) });
  });
  app.route('/dev/ui', devUi);

  // 7. Last chance: module fallbacks (short links live at /<code>), then a 404.
  app.notFound(async (c) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      for (const m of modules) {
        if (!m.fallback) continue;
        const res = await m.fallback(c);
        if (res) return res;
      }
    }
    const err = errors.not_found();
    if (wantsJson(c)) return jsonError(c, err);
    return c.html(
      <ErrorPage status={404} code={err.code} message={err.message} requestId={c.get('requestId')} signedIn={c.get('user') !== null} />,
      404,
    );
  });

  return app;
}
