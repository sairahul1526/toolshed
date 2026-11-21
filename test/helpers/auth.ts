/**
 * Sign-in for route tests, with real rows and a real signed cookie:
 *
 *   const t = createTestEnv();
 *   const { headers } = await createTestSession(t.env, { role: 'viewer' });
 *   const res = await app.request('/app/links', { headers }, t.env);
 *
 * The workspace defaults to the test env's own (`org_test`), so rows a module test stored under
 * `t.org.id` are visible to the session.
 */
import { newId, randomToken } from '../../src/core/db';
import type { ActiveOrg, Env, Role, SessionUser } from '../../src/env';
import { baseUrl } from '../../src/auth/auth';
import { sessionCookieName } from '../../src/auth/session';

export interface TestSessionOptions {
  email?: string;
  name?: string;
  /** Role in the workspace. Defaults to owner. */
  role?: Role;
  /** Workspace to join. Created when it does not exist yet. Defaults to `org_test`. */
  orgId?: string;
  /** Make this person the one who claimed the install. */
  instanceOwner?: boolean;
}

export interface TestSession {
  user: SessionUser;
  org: ActiveOrg;
  /** The `name=value` pair, for a Cookie header. */
  cookie: string;
  /** Headers for `app.request(path, { headers }, env)`. */
  headers: Record<string, string>;
  sessionId: string;
}

/** Sign a session token the way the session cookie is signed: `<token>.<base64 HMAC-SHA256>`. */
export async function signSessionToken(secret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token)));
  return encodeURIComponent(`${token}.${btoa(String.fromCharCode(...mac))}`);
}

let counter = 0;

export async function createTestSession(env: Env, opts: TestSessionOptions = {}): Promise<TestSession> {
  const now = new Date();
  const iso = now.toISOString();
  const n = ++counter;
  const role = opts.role ?? 'owner';
  const orgId = opts.orgId ?? 'org_test';
  const email = (opts.email ?? `person${n}@example.com`).toLowerCase();
  const name = opts.name ?? `Person ${n}`;

  await env.DB.prepare('INSERT OR IGNORE INTO "organization" ("id", "name", "slug", "createdAt") VALUES (?1, ?2, ?3, ?4)')
    .bind(orgId, orgId === 'org_test' ? 'Test Workspace' : `Workspace ${orgId}`, orgId === 'org_test' ? 'test' : orgId.replace(/_/g, '-'), iso)
    .run();
  const org = (await env.DB.prepare('SELECT "id", "name", "slug" FROM "organization" WHERE "id" = ?1').bind(orgId).first<{ id: string; name: string; slug: string }>())!;

  let userId = await env.DB.prepare('SELECT "id" FROM "user" WHERE "email" = ?1').bind(email).first<string>('id');
  if (!userId) {
    userId = newId('usr');
    await env.DB.prepare(
      'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "banned", "twoFactorEnabled") VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5, 0, 0)',
    )
      .bind(userId, name, email, iso, opts.instanceOwner ? 'admin' : 'user')
      .run();
  }
  await env.DB.prepare('INSERT OR REPLACE INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(newId('mem'), orgId, userId, role, iso)
    .run();

  const sessionId = newId('ses');
  const token = randomToken(24);
  await env.DB.prepare(
    'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "activeOrganizationId") VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)',
  )
    .bind(sessionId, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), token, iso, '203.0.113.7', 'Vitest', userId, orgId)
    .run();

  const origin = baseUrl(env);
  const cookie = `${sessionCookieName(origin)}=${await signSessionToken(env.AUTH_SECRET, token)}`;
  return {
    user: { id: userId, email, name, image: null, isInstanceOwner: opts.instanceOwner === true },
    org: { ...org, role },
    cookie,
    // `origin` makes state-changing requests pass the same-origin guard, as a real form post does.
    headers: { cookie, origin },
    sessionId,
  };
}

/** Counts D1 statements while `run` executes. A batch counts each of its statements. */
export async function countQueries<T>(env: Env, run: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
  const db = env.DB as unknown as { prepare(sql: string): unknown };
  const original = db.prepare;
  const queries: string[] = [];
  db.prepare = function (sql: string) {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    return original.call(this, sql);
  };
  try {
    return { result: await run(), queries };
  } finally {
    db.prepare = original;
  }
}
