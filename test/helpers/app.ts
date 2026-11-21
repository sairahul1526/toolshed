/**
 * Mount one module the way `src/app.tsx` does, with a pretend caller, so a module's dashboard, API
 * and public routes can be tested without the sign-in system.
 *
 *   const t = createTestEnv();
 *   const app = await mountModule(t, links);                      // an admin, module turned on
 *   const res = await app.request('/api/v1/links', { json: { url: 'https://example.com' } });
 *   const viewer = app.as({ role: 'viewer' });                    // same database, weaker caller
 *   const key = app.as({ kind: 'apikey', scopes: ['links:read'] });
 *   const visitor = app.as({ kind: 'anon' });                     // public pages
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, errors, jsonError, toAppError, wantsJson } from '../../src/core/errors';
import { requireOrg, requireUser, sameOrigin } from '../../src/core/guards';
import type { ModuleDef } from '../../src/core/module';
import { registerModules, requireModule, setModuleEnabled } from '../../src/core/registry';
import type { AppEnv, AuthInfo, Role, SessionUser } from '../../src/env';
import type { TestEnv } from './d1';

export interface Caller {
  /** How the caller proved who it is. Defaults to a signed-in person. */
  kind?: AuthInfo['kind'];
  /** Role in the test workspace. Defaults to admin. */
  role?: Role;
  /** Scopes for API keys and JWTs. Sessions always hold `*`. */
  scopes?: string[];
  user?: Partial<SessionUser>;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | null;
  /** Sent as a JSON body. The method defaults to POST. */
  json?: unknown;
  /** Sent as a form post, the way a dashboard form submits. */
  form?: Record<string, string>;
}

export interface MountOptions {
  caller?: Caller;
  /** Leave the module turned off for the workspace. */
  off?: boolean;
  /** Other modules to register next to this one (for event handlers between modules). */
  others?: ModuleDef[];
}

export interface MountedModule {
  app: Hono<AppEnv>;
  /** Call a full path such as `/app/links` or `/api/v1/links/abc`. Background work has finished when this resolves. */
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** The same app and database, called by someone else. */
  as(caller: Caller): MountedModule;
}

const HEADER = 'x-test-caller';

function build(def: ModuleDef): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const caller = JSON.parse(c.req.header(HEADER) ?? '{}') as Caller & { orgId: string; orgName: string; orgSlug: string };
    const kind = caller.kind ?? 'session';
    c.set('requestId', 'req_test');
    c.set('user', null);
    c.set('org', null);
    c.set('auth', { kind: 'anon', scopes: [] });
    if (kind !== 'anon') {
      c.set('org', { id: caller.orgId, name: caller.orgName, slug: caller.orgSlug, role: caller.role ?? 'admin' });
      if (kind === 'session') {
        c.set('user', { id: 'usr_test', email: 'person@example.com', name: 'Test Person', image: null, isInstanceOwner: false, ...caller.user });
        c.set('auth', { kind, scopes: ['*'] });
      } else {
        c.set('auth', { kind, scopes: caller.scopes ?? [], ...(kind === 'apikey' ? { keyId: 'key_test' } : {}) });
      }
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (!(err instanceof AppError)) console.error(err);
    const appError = toAppError(err);
    if (wantsJson(c)) return jsonError(c, appError);
    return c.text(`${appError.code}: ${appError.message}`, appError.status as ContentfulStatusCode);
  });

  if (def.public) app.route('/', def.public);
  if (def.dashboard) {
    app.use(`/app/${def.id}`, requireUser, requireOrg(), sameOrigin, requireModule(def.id));
    app.use(`/app/${def.id}/*`, requireUser, requireOrg(), sameOrigin, requireModule(def.id));
    app.route(`/app/${def.id}`, def.dashboard);
  }
  if (def.api) {
    app.use(`/api/v1/${def.id}`, requireUser, requireOrg(), sameOrigin, requireModule(def.id));
    app.use(`/api/v1/${def.id}/*`, requireUser, requireOrg(), sameOrigin, requireModule(def.id));
    app.route(`/api/v1/${def.id}`, def.api);
  }

  app.notFound(async (c) => {
    if (def.fallback && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
      const res = await def.fallback(c);
      if (res) return res;
    }
    const err = errors.not_found();
    if (wantsJson(c)) return jsonError(c, err);
    return c.text(`${err.code}: ${err.message}`, 404);
  });

  return app;
}

function handle(t: TestEnv, app: Hono<AppEnv>, caller: Caller): MountedModule {
  return {
    app,
    async request(path, options = {}) {
      const { json, form, ...init } = options;
      const headers = new Headers(init.headers);
      headers.set(HEADER, JSON.stringify({ ...caller, orgId: t.org.id, orgName: t.org.name, orgSlug: t.org.slug }));
      let body = init.body ?? null;
      let method = init.method;
      if (json !== undefined) {
        body = JSON.stringify(json);
        headers.set('content-type', 'application/json');
        method ??= 'POST';
      } else if (form) {
        body = new URLSearchParams(form).toString();
        headers.set('content-type', 'application/x-www-form-urlencoded');
        method ??= 'POST';
      }
      const waiting: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => void waiting.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext;
      const res = await app.request(`http://localhost${path}`, { ...init, ...(method ? { method } : {}), headers, body }, t.env, ctx);
      await Promise.allSettled(waiting);
      return res;
    },
    as(next) {
      return handle(t, app, next);
    },
  };
}

/** Register the module, turn it on for the test workspace, and return something to call its routes with. */
export async function mountModule(t: TestEnv, def: ModuleDef, options: MountOptions = {}): Promise<MountedModule> {
  registerModules([def, ...(options.others ?? [])]);
  if (!options.off) await setModuleEnabled(t.env, t.org.id, def.id, true);
  return handle(t, build(def), options.caller ?? {});
}
