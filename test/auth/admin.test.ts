import { beforeEach, describe, expect, it } from 'vitest';
import { IMPERSONATION_TTL_SEC, LIMITS } from '../../src/auth/config';
import { hit } from '../../src/auth/http';
import {
  banUser,
  currentImpersonation,
  deleteAnyWorkspace,
  deleteUser,
  getAccount,
  getUser,
  listAllWorkspaces,
  listUsers,
  renameAnyWorkspace,
  setPassword,
  startImpersonation,
  stopImpersonation,
  unbanUser,
} from '../../src/auth/service';
import * as apikeys from '../../src/core/apikeys';
import type { Env } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastCode, signInByCode, testApp } from './browser';
import { codeOf, must, seenAs } from './harness';

const ORG = 'org_test';
const app = testApp();

let env: Env;
let olive: TestSession;
let adam: TestSession;
let mel: TestSession;
let asOlive: Browser;
let asAdam: Browser;
let asMel: Browser;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const lastAudit = (action: string) =>
  env.DB.prepare('SELECT org_id, actor_id, target_id, meta FROM audit_log WHERE action = ?1 ORDER BY created_at DESC, id DESC LIMIT 1')
    .bind(action)
    .first<{ org_id: string | null; actor_id: string | null; target_id: string | null; meta: string | null }>();
const sessionsOf = (userId: string) => count('SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?1', userId);
const exists = (userId: string) => count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', userId);
const makeStale = (sessionId: string) =>
  env.DB.prepare('UPDATE "session" SET "createdAt" = ?1 WHERE "id" = ?2').bind(new Date(Date.now() - 31 * 60_000).toISOString(), sessionId).run();
const who = (b: Browser) => must(env, b, (c) => getAccount(c));

beforeEach(async () => {
  env = createTestEnv().env;
  olive = await createTestSession(env, { email: 'olive@example.com', name: 'Olive', role: 'owner', instanceOwner: true });
  adam = await createTestSession(env, { email: 'adam@example.com', name: 'Adam', role: 'owner' });
  mel = await createTestSession(env, { email: 'mel@example.com', name: 'Mel', role: 'member' });
  asOlive = adopt(new Browser(app, env), olive.cookie);
  asAdam = adopt(new Browser(app, env), adam.cookie);
  asMel = adopt(new Browser(app, env), mel.cookie);
});

describe('who may run the install', () => {
  it('is the owner of the install and nobody else, not even a workspace owner', async () => {
    for (const b of [asAdam, asMel]) {
      expect(await codeOf(env, b, (c) => listUsers(c))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => getUser(c, olive.user.id))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => banUser(c, mel.user.id))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => unbanUser(c, mel.user.id))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => deleteUser(c, mel.user.id, { confirm: mel.user.email }))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => startImpersonation(c, olive.user.id))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => listAllWorkspaces(c))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => renameAnyWorkspace(c, ORG, { name: 'Taken over' }))).toBe('auth.owner_only');
      expect(await codeOf(env, b, (c) => deleteAnyWorkspace(c, ORG, { confirm: 'test' }))).toBe('auth.owner_only');
    }
    expect(await codeOf(env, new Browser(app, env), (c) => listUsers(c))).toBe('unauthorized');
    expect(await exists(mel.user.id)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "banned" = 1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM audit_log')).toBe(0);
  });

  it('is never an API key, even the owner’s own', async () => {
    const key = await apikeys.createApiKey(env, { orgId: ORG, userId: olive.user.id, role: 'owner', label: olive.user.email, via: 'session' }, { name: 'CI', scopes: ['*'] });
    const headers = { authorization: `Bearer ${key.secret}` };
    expect((await seenAs(env, headers)).kind).toBe('apikey');
    expect(await codeOf(env, headers, (c) => listUsers(c))).toBe('unauthorized');
    expect(await codeOf(env, headers, (c) => banUser(c, mel.user.id))).toBe('unauthorized');
    expect(await codeOf(env, headers, (c) => startImpersonation(c, mel.user.id))).toBe('unauthorized');
  });

  it('stops working the moment ownership is gone', async () => {
    expect((await must(env, asOlive, (c) => listUsers(c))).items).toHaveLength(3);
    await env.DB.prepare(`UPDATE "user" SET "role" = 'user' WHERE "id" = ?1`).bind(olive.user.id).run();
    expect(await codeOf(env, asOlive, (c) => listUsers(c))).toBe('auth.owner_only');
    expect(await codeOf(env, asOlive, (c) => banUser(c, mel.user.id))).toBe('auth.owner_only');
  });

  it('asks for a recent sign-in before the changes that cannot be undone', async () => {
    await makeStale(olive.sessionId);
    expect(await codeOf(env, asOlive, (c) => deleteUser(c, mel.user.id, { confirm: mel.user.email }))).toBe('auth.sign_in_again');
    expect(await codeOf(env, asOlive, (c) => startImpersonation(c, mel.user.id))).toBe('auth.sign_in_again');
    expect(await codeOf(env, asOlive, (c) => deleteAnyWorkspace(c, ORG, { confirm: 'test' }))).toBe('auth.sign_in_again');
    expect((await must(env, asOlive, (c) => listUsers(c))).items).toHaveLength(3);
  });
});

describe('looking people up', () => {
  it('lists everyone with what the Users screen shows', async () => {
    await env.DB.prepare(
      `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp") VALUES ('pk_1', 'Phone', 'pk', ?1, 'cred', 0, 'multiDevice', 1)`,
    )
      .bind(mel.user.id)
      .run();
    await createTestSession(env, { email: 'mel@example.com', orgId: 'org_two', role: 'owner' });
    const { items, nextCursor } = await must(env, asOlive, (c) => listUsers(c));
    expect(nextCursor).toBeNull();
    expect(items.map((u) => u.email).sort()).toEqual(['adam@example.com', 'mel@example.com', 'olive@example.com']);
    const byEmail = Object.fromEntries(items.map((u) => [u.email, u]));
    expect(byEmail['olive@example.com']).toMatchObject({ isInstanceOwner: true, isYou: true, banned: false, workspaces: 1 });
    expect(byEmail['mel@example.com']).toMatchObject({ isInstanceOwner: false, isYou: false, passkeys: 1, workspaces: 2, twoStep: false, banReason: null });
    expect(byEmail['mel@example.com']?.lastSeenAt).toBeGreaterThan(0);
  });

  it('searches by name or email, and treats % and _ as plain text', async () => {
    const find = async (query: string) => (await must(env, asOlive, (c) => listUsers(c, { query }))).items.map((u) => u.email);
    expect(await find('MEL')).toEqual(['mel@example.com']);
    expect(await find('adam@ex')).toEqual(['adam@example.com']);
    expect(await find('%')).toEqual([]);
    expect(await find('_')).toEqual([]);
    expect(await find("' OR 1=1 --")).toEqual([]);
    expect(await find('   ')).toHaveLength(3);
  });

  it('pages through a long list without repeats or gaps', async () => {
    for (let i = 0; i < 7; i++) await createTestSession(env, { email: `extra${i}@example.com` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await must(env, asOlive, (c) => listUsers(c, { limit: 4, cursor }));
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((u) => u.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(10);
    expect(await codeOf(env, asOlive, (c) => listUsers(c, { cursor: 'nonsense' }))).toBe('bad_request');
    expect((await must(env, asOlive, (c) => listUsers(c, { limit: 100000 }))).items).toHaveLength(10);
  });

  it('shows one person with their workspaces', async () => {
    const detail = await must(env, asOlive, (c) => getUser(c, mel.user.id));
    expect(detail).toMatchObject({ email: 'mel@example.com', isYou: false });
    expect(detail.memberships.map((w) => [w.id, w.role])).toEqual([[ORG, 'member']]);
    expect(await codeOf(env, asOlive, (c) => getUser(c, 'usr_nobody'))).toBe('auth.user_not_found');
  });
});

describe('suspending someone', () => {
  it('signs them out everywhere and keeps them out until it is lifted', async () => {
    const key = await apikeys.createApiKey(env, { orgId: ORG, userId: mel.user.id, role: 'member', label: mel.user.email, via: 'session' }, { name: 'CI', scopes: ['*'] });
    await env.DB.prepare(
      `INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId") VALUES ('inv_1', ?1, 'new@example.com', 'member', 'pending', ?2, ?3, ?4)`,
    )
      .bind(ORG, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString(), mel.user.id)
      .run();
    expect((await seenAs(env, { authorization: `Bearer ${key.secret}` })).kind).toBe('apikey');

    expect(await must(env, asOlive, (c) => banUser(c, mel.user.id, { reason: ' Spam ' }))).toEqual({ userId: mel.user.id, until: null });

    expect(await sessionsOf(mel.user.id)).toBe(0);
    expect(await asMel.signedIn()).toBe(false);
    expect((await seenAs(env, { authorization: `Bearer ${key.secret}` })).kind).toBe('anon');
    expect(await env.DB.prepare(`SELECT "status" FROM "invitation" WHERE "id" = 'inv_1'`).first<string>('status')).toBe('canceled');
    expect((await must(env, asOlive, (c) => getUser(c, mel.user.id)))).toMatchObject({ banned: true, banReason: 'Spam', banExpiresAt: null });
    expect(JSON.parse((await lastAudit('user.banned'))?.meta ?? '{}')).toMatchObject({ reason: 'Spam', days: null });
    expect((await lastAudit('user.banned'))?.actor_id).toBe(olive.user.id);

    const fresh = new Browser(app, env);
    await fresh.post('/sign-in', { email: mel.user.email, intent: 'code' });
    const refused = await fresh.post('/sign-in/code', { code: await lastCode(env, mel.user.email) });
    expect(refused.status).toBe(400);
    expect(await sessionsOf(mel.user.id)).toBe(0);

    await must(env, asOlive, (c) => unbanUser(c, mel.user.id));
    expect(await audits('user.unbanned')).toBe(1);
    expect((await signInByCode(new Browser(app, env), env, mel.user.email)).status).toBe(303);
    expect((await seenAs(env, { authorization: `Bearer ${key.secret}` })).kind).toBe('apikey');
    // Lifting it twice is not news.
    await must(env, asOlive, (c) => unbanUser(c, mel.user.id));
    expect(await audits('user.unbanned')).toBe(1);
  });

  it('can end by itself after 7 or 30 days', async () => {
    const now = Date.now();
    const { until } = await must(env, asOlive, (c) => banUser(c, mel.user.id, { days: 7 }, now));
    expect(until).toBe(now + 7 * 86_400_000);
    expect((await must(env, asOlive, (c) => getUser(c, mel.user.id))).banExpiresAt).toBe(until);
    expect(await codeOf(env, asOlive, (c) => banUser(c, mel.user.id, { days: 3 }))).toBe('validation_failed');
    expect(await codeOf(env, asOlive, (c) => banUser(c, mel.user.id, { reason: 'x'.repeat(201) }))).toBe('validation_failed');

    await env.DB.prepare('UPDATE "user" SET "banExpires" = ?1 WHERE "id" = ?2').bind(new Date(now - 1000).toISOString(), mel.user.id).run();
    expect((await must(env, asOlive, (c) => getUser(c, mel.user.id)))).toMatchObject({ banned: false, banReason: null });
    expect((await signInByCode(new Browser(app, env), env, mel.user.email)).status).toBe(303);
  });

  it('cannot be turned on the owner, by anyone', async () => {
    const second = await createTestSession(env, { email: 'second@example.com', instanceOwner: true });
    expect(await codeOf(env, asOlive, (c) => banUser(c, olive.user.id))).toBe('auth.self_action');
    expect(await codeOf(env, asOlive, (c) => banUser(c, second.user.id))).toBe('auth.is_owner');
    expect(await codeOf(env, asOlive, (c) => deleteUser(c, second.user.id, { confirm: second.user.email }))).toBe('auth.is_owner');
    expect(await codeOf(env, asOlive, (c) => deleteUser(c, olive.user.id, { confirm: olive.user.email }))).toBe('auth.self_action');
    expect(await codeOf(env, asOlive, (c) => startImpersonation(c, second.user.id))).toBe('auth.is_owner');
    expect(await codeOf(env, asOlive, (c) => startImpersonation(c, olive.user.id))).toBe('auth.self_action');
    expect(await codeOf(env, asOlive, (c) => banUser(c, 'usr_nobody'))).toBe('auth.user_not_found');
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "banned" = 1')).toBe(0);
    expect(await sessionsOf(second.user.id)).toBe(1);
  });
});

describe('deleting someone’s account', () => {
  it('removes them once their email is typed out', async () => {
    expect(await codeOf(env, asOlive, (c) => deleteUser(c, mel.user.id, { confirm: 'mel' }))).toBe('validation_failed');
    expect(await exists(mel.user.id)).toBe(1);

    await must(env, asOlive, (c) => deleteUser(c, mel.user.id, { confirm: mel.user.email }));
    expect(await exists(mel.user.id)).toBe(0);
    expect(await sessionsOf(mel.user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "member" WHERE "userId" = ?1', mel.user.id)).toBe(0);
    expect(await asMel.signedIn()).toBe(false);
    const line = await lastAudit('user.deleted');
    expect(line).toMatchObject({ actor_id: olive.user.id, target_id: mel.user.id, org_id: null });
    expect(await codeOf(env, asOlive, (c) => deleteUser(c, mel.user.id, { confirm: mel.user.email }))).toBe('auth.user_not_found');
  });

  it('is refused while they are the only owner of a workspace', async () => {
    await createTestSession(env, { email: 'mel@example.com', orgId: 'org_solo', role: 'owner' });
    expect(await codeOf(env, asOlive, (c) => deleteUser(c, mel.user.id, { confirm: mel.user.email }))).toBe('auth.sole_owner');
    expect(await exists(mel.user.id)).toBe(1);
    expect(await audits('user.deleted')).toBe(0);
  });
});

describe('signing in as someone', () => {
  it('shows what they see for an hour at most, and every start and stop is on record', async () => {
    const started = await must(env, asOlive, (c) => startImpersonation(c, mel.user.id));
    expect(started.user).toEqual({ id: mel.user.id, name: 'Mel', email: 'mel@example.com' });
    expect(started.by.id).toBe(olive.user.id);
    expect(Math.abs(started.expiresAt - (Date.now() + IMPERSONATION_TTL_SEC * 1000))).toBeLessThan(5000);

    // The browser is now Mel, with the owner's name attached to the session.
    expect(await who(asOlive)).toMatchObject({ email: 'mel@example.com', impersonatedBy: olive.user.id, fresh: false });
    expect(await must(env, asOlive, (c) => currentImpersonation(c))).toMatchObject({ user: { id: mel.user.id }, by: { id: olive.user.id, email: 'olive@example.com' } });
    const row = await env.DB.prepare('SELECT "id", "expiresAt" FROM "session" WHERE "impersonatedBy" = ?1').bind(olive.user.id).first<{ id: string; expiresAt: string }>();
    expect(Date.parse(row!.expiresAt)).toBe(started.expiresAt);
    const start = await lastAudit('impersonation.started');
    expect(start).toMatchObject({ actor_id: olive.user.id, target_id: mel.user.id, org_id: null });
    expect(JSON.parse(start?.meta ?? '{}').sessionId).toBe(row!.id);

    // Mel's account is out of reach, and so is the owner's power.
    expect(await codeOf(env, asOlive, (c) => setPassword(c, { password: 'correct horse battery' }))).toBe('auth.impersonating');
    expect(await codeOf(env, asOlive, (c) => listUsers(c))).toBe('auth.impersonating');
    expect(await codeOf(env, asOlive, (c) => startImpersonation(c, adam.user.id))).toBe('auth.impersonating');
    // Mel's own devices carry on as before.
    expect(await who(asMel)).toMatchObject({ email: 'mel@example.com', impersonatedBy: null });
    expect(await must(env, asMel, (c) => currentImpersonation(c))).toBeNull();

    expect(await must(env, asOlive, (c) => stopImpersonation(c))).toEqual({ signedOut: false });
    expect(await who(asOlive)).toMatchObject({ email: 'olive@example.com', impersonatedBy: null });
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "impersonatedBy" IS NOT NULL')).toBe(0);
    expect(await lastAudit('impersonation.stopped')).toMatchObject({ actor_id: olive.user.id, target_id: mel.user.id });
    expect(await codeOf(env, asOlive, (c) => stopImpersonation(c))).toBe('auth.not_impersonating');
    expect(await audits('impersonation.stopped')).toBe(1);
  });

  it('ends by itself when the hour is up, and is never pushed forward by use', async () => {
    await must(env, asOlive, (c) => startImpersonation(c, mel.user.id));
    const before = await env.DB.prepare('SELECT "expiresAt" FROM "session" WHERE "impersonatedBy" IS NOT NULL').first<string>('expiresAt');
    // Old enough that an ordinary session would be refreshed on its next use.
    await env.DB.prepare('UPDATE "session" SET "updatedAt" = ?1 WHERE "impersonatedBy" IS NOT NULL').bind(new Date(Date.now() - 2 * 3600_000).toISOString()).run();
    expect((await who(asOlive)).email).toBe('mel@example.com');
    expect(await env.DB.prepare('SELECT "expiresAt" FROM "session" WHERE "impersonatedBy" IS NOT NULL').first<string>('expiresAt')).toBe(before);

    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ?1 WHERE "impersonatedBy" IS NOT NULL').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect(await codeOf(env, asOlive, (c) => getAccount(c))).toBe('unauthorized');
    expect(await asOlive.signedIn()).toBe(false);
  });

  it('refuses a suspended account', async () => {
    await must(env, asOlive, (c) => banUser(c, mel.user.id));
    expect(await codeOf(env, asOlive, (c) => startImpersonation(c, mel.user.id))).toBe('auth.user_banned');
    expect(await audits('impersonation.started')).toBe(0);
    expect((await who(asOlive)).email).toBe('olive@example.com');
  });

  it('ends both sessions when the owner signs out in the middle of it', async () => {
    await must(env, asOlive, (c) => startImpersonation(c, mel.user.id));
    const res = await asOlive.post('/sign-out');
    expect(res.status).toBe(303);
    expect(await asOlive.signedIn()).toBe(false);
    expect(await sessionsOf(olive.user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "impersonatedBy" IS NOT NULL')).toBe(0);
    expect(await sessionsOf(mel.user.id)).toBe(1);
    expect(await audits('impersonation.stopped')).toBe(1);
    expect(await audits('user.signed_out')).toBe(0);
  });

  it('signs the browser out when the owner’s own session ended meanwhile', async () => {
    await must(env, asOlive, (c) => startImpersonation(c, mel.user.id));
    await env.DB.prepare('DELETE FROM "session" WHERE "id" = ?1').bind(olive.sessionId).run();
    expect(await must(env, asOlive, (c) => stopImpersonation(c))).toEqual({ signedOut: true });
    expect(await asOlive.signedIn()).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "impersonatedBy" IS NOT NULL')).toBe(0);
    expect(await audits('impersonation.stopped')).toBe(1);
  });

  it('cannot be forged by handing the browser a made-up owner cookie', async () => {
    await must(env, asOlive, (c) => startImpersonation(c, mel.user.id));
    const name = [...asOlive.cookies.keys()].find((k) => k.endsWith('admin_session'));
    expect(name).toBeDefined();
    // Mel's browser gets a copy of the cookie with Adam's session token swapped in, unsigned.
    const adamToken = await env.DB.prepare('SELECT "token" FROM "session" WHERE "id" = ?1').bind(adam.sessionId).first<string>('token');
    asOlive.cookies.set(name!, encodeURIComponent(`${adamToken}:.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`));
    expect(await must(env, asOlive, (c) => stopImpersonation(c))).toEqual({ signedOut: true });
    expect(await asOlive.signedIn()).toBe(false);
    expect(await sessionsOf(adam.user.id)).toBe(1);
  });

  it('is limited per owner', async () => {
    for (let i = 0; i < LIMITS.impersonatePerOwner.limit; i++) await hit(env, 'impersonatePerOwner', olive.user.id);
    expect(await codeOf(env, asOlive, (c) => startImpersonation(c, mel.user.id))).toBe('rate_limited');
    expect(await audits('impersonation.started')).toBe(0);
    expect((await who(asOlive)).email).toBe('olive@example.com');
  });
});

describe('every workspace on the install', () => {
  beforeEach(async () => {
    await createTestSession(env, { email: 'mel@example.com', orgId: 'org_solo', role: 'owner' });
    await createTestSession(env, { email: 'zed@example.com', orgId: 'org_solo', role: 'owner' });
    await createTestSession(env, { email: 'vic@example.com', orgId: 'org_solo', role: 'viewer' });
  });

  it('lists them with who owns each, including ones the owner is not in', async () => {
    const { items } = await must(env, asOlive, (c) => listAllWorkspaces(c));
    const byId = Object.fromEntries(items.map((w) => [w.id, w]));
    expect(Object.keys(byId).sort()).toEqual(['org_solo', 'org_test']);
    expect(byId['org_solo']).toMatchObject({ slug: 'org-solo', members: 3, owners: ['mel@example.com', 'zed@example.com'] });
    expect(byId['org_test']).toMatchObject({ members: 3, owners: ['adam@example.com', 'olive@example.com'] });
    expect((await must(env, asOlive, (c) => listAllWorkspaces(c, { query: 'SOLO' }))).items.map((w) => w.id)).toEqual(['org_solo']);
    expect((await must(env, asOlive, (c) => listAllWorkspaces(c, { limit: 1 }))).nextCursor).not.toBeNull();
  });

  it('renames one and writes it in that workspace’s own log', async () => {
    expect(await must(env, asOlive, (c) => renameAnyWorkspace(c, 'org_solo', { name: 'Solo Works', slug: 'solo-works' }))).toEqual({ id: 'org_solo', name: 'Solo Works', slug: 'solo-works' });
    const line = await lastAudit('workspace.renamed');
    expect(line).toMatchObject({ org_id: 'org_solo', actor_id: olive.user.id });
    expect(JSON.parse(line?.meta ?? '{}').byInstanceOwner).toBe(true);
    expect(await codeOf(env, asOlive, (c) => renameAnyWorkspace(c, 'org_solo', { name: '' }))).toBe('validation_failed');
    expect(await codeOf(env, asOlive, (c) => renameAnyWorkspace(c, 'org_solo', { name: 'Solo Works', slug: 'test' }))).toBe('auth.slug_taken');
    expect(await codeOf(env, asOlive, (c) => renameAnyWorkspace(c, 'org_nowhere', { name: 'X' }))).toBe('auth.workspace_not_found');
  });

  it('deletes one, with everyone’s place in it, once its short name is typed out', async () => {
    expect(await codeOf(env, asOlive, (c) => deleteAnyWorkspace(c, 'org_solo', { confirm: 'org_solo' }))).toBe('validation_failed');
    expect(await count('SELECT COUNT(*) AS n FROM "organization"')).toBe(2);

    await must(env, asOlive, (c) => deleteAnyWorkspace(c, 'org_solo', { confirm: 'org-solo' }));
    expect(await count('SELECT COUNT(*) AS n FROM "organization" WHERE "id" = ?1', 'org_solo')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1', 'org_solo')).toBe(0);
    expect(await exists(mel.user.id)).toBe(1);
    expect(await lastAudit('workspace.deleted')).toMatchObject({ org_id: null, actor_id: olive.user.id, target_id: 'org_solo' });
    expect(await codeOf(env, asOlive, (c) => deleteAnyWorkspace(c, 'org_solo', { confirm: 'org-solo' }))).toBe('auth.workspace_not_found');
  });
});
