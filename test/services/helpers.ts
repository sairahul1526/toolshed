/** Shared bits for the service tests: a tiny Hono wrapper that stands in for sign-in and workspace middleware. */
import { Hono } from 'hono';
import type { AppEnv, Role } from '../../src/env';
import { jsonError, toAppError } from '../../src/core/errors';
import type { TestEnv } from '../helpers/d1';

export interface Who {
  userId?: string;
  email?: string;
  isInstanceOwner?: boolean;
  /** Role in the workspace. `null` means no active workspace. */
  role?: Role | null;
  orgId?: string;
  /** How the request signed in. Default `session`. */
  kind?: 'session' | 'apikey' | 'anon';
}

export function routeApp(routes: Hono<AppEnv>, t: TestEnv, who: Who = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const kind = who.kind ?? 'session';
    c.set('requestId', 'req_test');
    c.set(
      'user',
      kind === 'anon'
        ? null
        : { id: who.userId ?? 'usr_admin', email: who.email ?? 'admin@example.com', name: 'Admin', image: null, isInstanceOwner: who.isInstanceOwner ?? false },
    );
    const role = who.role === undefined ? 'admin' : who.role;
    c.set('org', role ? { id: who.orgId ?? t.org.id, name: t.org.name, slug: t.org.slug, role } : null);
    c.set('auth', { kind, scopes: ['*'] });
    await next();
  });
  app.route('/', routes);
  app.onError((err, c) => jsonError(c, toAppError(err)));
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, t.env),
    async json<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
      const res = await app.request(path, init, t.env);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, body: body as T, headers: res.headers };
    },
  };
}

export const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const put = (body: unknown): RequestInit => ({ ...post(body), method: 'PUT' });
