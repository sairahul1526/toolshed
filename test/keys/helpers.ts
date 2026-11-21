/**
 * Shared set-up for the key and token tests: a fixed clock, two modules that declare scopes,
 * a few people, and a tiny app that stands in for the request loader.
 */
import { Hono } from 'hono';
import type { CoreRoutes } from '../../src/app';
import type { KeyActor } from '../../src/core/apikeys';
import { AppError, jsonError, toAppError } from '../../src/core/errors';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import type { AppEnv, AuthInfo, Env, Role, SessionUser } from '../../src/env';
import type { TestEnv } from '../helpers/d1';

/** A fixed "now" so nothing depends on the clock of the machine running the tests. */
export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

export const ORG_A = 'org_a';
export const ORG_B = 'org_b';

const links = defineModule({
  id: 'links',
  name: 'Links',
  description: 'Short links.',
  icon: 'link',
  category: 'growth',
  version: '1.0.0',
  permissions: [
    { scope: 'links:read', label: 'See links' },
    { scope: 'links:write', label: 'Create, edit and delete links' },
  ],
});

const forms = defineModule({
  id: 'forms',
  name: 'Forms',
  description: 'Forms.',
  icon: 'form',
  category: 'growth',
  version: '1.0.0',
  permissions: [{ scope: 'forms:read', label: 'See forms and answers' }],
});

/** Register the two modules above. Pair with `afterEach(() => registerModules([]))`. */
export function useModules(): void {
  registerModules([links, forms]);
}

export function actor(role: Role, userId = `usr_${role}`, orgId = ORG_A): KeyActor {
  return { orgId, userId, role, label: `${userId}@example.com`, ip: '203.0.113.7', via: 'session' };
}

/** Run something that should fail and hand back the error, so its code and fields can be checked. */
export async function failure(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('Expected an error, but the call worked');
}

export interface AuditRow {
  org_id: string | null;
  actor_id: string | null;
  actor_type: string;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string | null;
  meta: string | null;
  ip: string | null;
}

export function auditRows(t: TestEnv, action?: string): AuditRow[] {
  const rows = t.sqlite.prepare('SELECT * FROM audit_log ORDER BY rowid').all() as unknown as AuditRow[];
  return action ? rows.filter((r) => r.action === action) : rows;
}

export function tableRows<T = Record<string, unknown>>(t: TestEnv, table: 'api_keys' | 'service_accounts' | 'jwt_signing_keys'): T[] {
  return t.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown as T[];
}

/**
 * The same database seen by a Worker instance that has only just started: nothing cached in
 * memory. `queries` counts the statements it prepares, to prove a code path reads no database.
 */
export function coldInstance(env: Env): { env: Env; queries: () => number } {
  let count = 0;
  const source = env.DB;
  const db = Object.create(source) as D1Database;
  db.prepare = (sql: string) => {
    count++;
    return source.prepare(sql);
  };
  db.batch = ((statements: D1PreparedStatement[]) => {
    count += statements.length;
    return source.batch(statements);
  }) as D1Database['batch'];
  return { env: { ...env, DB: db }, queries: () => count };
}

export interface Caller {
  user?: Partial<SessionUser> | null;
  org?: { id?: string; role: Role } | null;
  auth: AuthInfo;
}

export const session = (role: Role, userId = `usr_${role}`, orgId = ORG_A): Caller => ({
  user: { id: userId },
  org: { id: orgId, role },
  auth: { kind: 'session', scopes: ['*'] },
});

export const viaKey = (role: Role, scopes: string[], keyId = 'key_caller', orgId = ORG_A): Caller => ({
  user: null,
  org: { id: orgId, role },
  auth: { kind: 'apikey', scopes, keyId },
});

export const viaJwt = (role: Role, scopes: string[], orgId = ORG_A): Caller => ({
  user: { id: 'usr_jwt' },
  org: { id: orgId, role },
  auth: { kind: 'jwt', scopes },
});

export const anon: Caller = { user: null, org: null, auth: { kind: 'anon', scopes: [] } };

/**
 * Mount a core route file the way the app does, with `who` standing in for what the request
 * loader would have put on the request. Returns a function that sends one request.
 */
export function mount(env: Env, routes: CoreRoutes, base: string, who: Caller) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set(
      'user',
      who.user ? { id: 'usr_x', email: `${who.user.id ?? 'usr_x'}@example.com`, name: '', image: null, isInstanceOwner: false, ...who.user } : null,
    );
    c.set('org', who.org ? { id: who.org.id ?? ORG_A, name: 'Workspace', slug: 'workspace', role: who.org.role } : null);
    c.set('auth', who.auth);
    await next();
  });
  if (routes.public) app.route('/', routes.public);
  if (routes.api) app.route(base, routes.api);
  app.onError((err, c) => jsonError(c, toAppError(err)));

  return async (method: string, path: string, body?: unknown, url = 'http://localhost'): Promise<{ status: number; headers: Headers; json: any }> => {
    const init: RequestInit = { method, headers: { 'cf-connecting-ip': '203.0.113.7' } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers = { ...init.headers, 'content-type': 'application/json' };
    }
    const res = await app.request(`${url}${path}`, init, env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
}
