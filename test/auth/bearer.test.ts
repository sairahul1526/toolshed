/**
 * A key or a token is checked against today's facts on every request: is its owner still a
 * member, what role do they hold now, are they suspended, does the key it came from still work.
 * Membership is changed here with plain SQL on purpose, so these prove the per-request check on
 * its own, without the tidy-up the members code also does.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadAuth } from '../../src/auth/load';
import * as apikeys from '../../src/core/apikeys';
import { signJwt } from '../../src/core/jwt';
import type { AppEnv, Env } from '../../src/env';
import { countQueries, createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';

const ORG = 'org_test';

let env: Env;
let olive: TestSession;
let ada: TestSession;

interface Seen {
  kind: string;
  role: string | null;
}

const ANON: Seen = { kind: 'anon', role: null };
let address = 0;

/** What a request carrying this bearer is seen as. Each call comes from its own address, so refusals never add up to a 429. */
async function seen(bearer: string): Promise<Seen> {
  const probe = new Hono<AppEnv>();
  probe.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('user', null);
    c.set('org', null);
    c.set('auth', { kind: 'anon', scopes: [] });
    await next();
  });
  probe.use('*', loadAuth);
  probe.get('/who', (c) => c.json({ kind: c.get('auth').kind, role: c.get('org')?.role ?? null }));
  const res = await probe.request('/who', { headers: { authorization: `Bearer ${bearer}`, 'cf-connecting-ip': `203.0.113.${++address}` } }, env);
  return (await res.json()) as Seen;
}

const actorOf = (who: TestSession, role: 'owner' | 'admin'): apikeys.KeyActor => ({ orgId: ORG, userId: who.user.id, role, label: who.user.email, via: 'session' });

/** Ada's three ways in: her key, a token she asked for, and a token made from her key. */
async function adasCredentials() {
  const key = await apikeys.createApiKey(env, actorOf(ada, 'admin'), { name: 'CI', scopes: ['*'] });
  const own = await signJwt(env, { sub: ada.user.id, orgId: ORG, role: 'admin', scopes: ['*'], kind: 'user' });
  const fromKey = await signJwt(env, { sub: key.key.id, orgId: ORG, role: 'admin', scopes: ['*'], kind: 'key' });
  return { keyId: key.key.id, key: key.secret, own: own.token, fromKey: fromKey.token };
}

const setRole = (role: string) => env.DB.prepare('UPDATE "member" SET "role" = ?1 WHERE "organizationId" = ?2 AND "userId" = ?3').bind(role, ORG, ada.user.id).run();

beforeEach(async () => {
  env = createTestEnv().env;
  olive = await createTestSession(env, { email: 'olive@example.com', role: 'owner' });
  ada = await createTestSession(env, { email: 'ada@example.com', role: 'admin' });
});

describe('a key or token that stands for a person', () => {
  it('stops the moment they are no longer a member: key, token, and token made from the key', async () => {
    const c = await adasCredentials();
    expect(await seen(c.key)).toEqual({ kind: 'apikey', role: 'admin' });
    expect(await seen(c.own)).toEqual({ kind: 'jwt', role: 'admin' });
    expect(await seen(c.fromKey)).toEqual({ kind: 'jwt', role: 'admin' });

    await env.DB.prepare('DELETE FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2').bind(ORG, ada.user.id).run();
    // The key itself was not revoked: the membership check alone refuses all three.
    expect(await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id = ?1').bind(c.keyId).first<number | null>('revoked_at')).toBeNull();
    expect(await seen(c.key)).toEqual(ANON);
    expect(await seen(c.own)).toEqual(ANON);
    expect(await seen(c.fromKey)).toEqual(ANON);
  });

  it('is not let in by a membership of some other workspace', async () => {
    const c = await adasCredentials();
    await env.DB.prepare('DELETE FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2').bind(ORG, ada.user.id).run();
    await createTestSession(env, { email: 'ada@example.com', role: 'owner', orgId: 'org_other' });
    expect(await seen(c.key)).toEqual(ANON);
    expect(await seen(c.own)).toEqual(ANON);
    expect(await seen(c.fromKey)).toEqual(ANON);
  });

  it('is never stronger than the role they hold today, and never raised by a promotion', async () => {
    const c = await adasCredentials();
    await setRole('viewer');
    expect(await seen(c.key)).toEqual({ kind: 'apikey', role: 'viewer' });
    expect(await seen(c.own)).toEqual({ kind: 'jwt', role: 'viewer' });
    expect(await seen(c.fromKey)).toEqual({ kind: 'jwt', role: 'viewer' });

    await setRole('member');
    expect(await seen(c.key)).toEqual({ kind: 'apikey', role: 'member' });
    expect(await seen(c.own)).toEqual({ kind: 'jwt', role: 'member' });

    await setRole('owner');
    expect(await seen(c.key)).toEqual({ kind: 'apikey', role: 'admin' });
    expect(await seen(c.own)).toEqual({ kind: 'jwt', role: 'admin' });
    expect(await seen(c.fromKey)).toEqual({ kind: 'jwt', role: 'admin' });

    // A role nobody could read counts as no membership.
    await setRole('root');
    expect(await seen(c.key)).toEqual(ANON);
    expect(await seen(c.own)).toEqual(ANON);
  });

  it('stops while they are suspended, tokens made from their key included', async () => {
    const c = await adasCredentials();
    await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?1').bind(ada.user.id).run();
    expect(await seen(c.key)).toEqual(ANON);
    expect(await seen(c.own)).toEqual(ANON);
    expect(await seen(c.fromKey)).toEqual(ANON);

    // A suspension that has run out no longer counts.
    await env.DB.prepare('UPDATE "user" SET "banExpires" = ?1 WHERE "id" = ?2').bind(new Date(Date.now() - 1000).toISOString(), ada.user.id).run();
    expect(await seen(c.fromKey)).toEqual({ kind: 'jwt', role: 'admin' });
  });

  it('stops when their account is gone', async () => {
    const c = await adasCredentials();
    await env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?1').bind(ada.user.id).run();
    await env.DB.prepare('DELETE FROM "member" WHERE "userId" = ?1').bind(ada.user.id).run();
    await env.DB.prepare('DELETE FROM "user" WHERE "id" = ?1').bind(ada.user.id).run();
    expect(await seen(c.key)).toEqual(ANON);
    expect(await seen(c.own)).toEqual(ANON);
    expect(await seen(c.fromKey)).toEqual(ANON);
  });
});

describe('a token made from a key', () => {
  it('stops with the key: revoked, run out, or never there', async () => {
    const c = await adasCredentials();
    await apikeys.revokeApiKey(env, actorOf(ada, 'admin'), c.keyId);
    expect(await seen(c.fromKey)).toEqual(ANON);
    // The token Ada asked for herself does not hang on that key.
    expect(await seen(c.own)).toEqual({ kind: 'jwt', role: 'admin' });

    const short = await apikeys.createApiKey(env, actorOf(ada, 'admin'), { name: 'Short', scopes: ['*'] });
    const fromShort = await signJwt(env, { sub: short.key.id, orgId: ORG, role: 'admin', scopes: ['*'], kind: 'key' });
    expect(await seen(fromShort.token)).toEqual({ kind: 'jwt', role: 'admin' });
    await env.DB.prepare('UPDATE api_keys SET expires_at = ?1 WHERE id = ?2').bind(Date.now() - 1000, short.key.id).run();
    expect(await seen(fromShort.token)).toEqual(ANON);

    const madeUp = await signJwt(env, { sub: 'key_madeUp', orgId: ORG, role: 'admin', scopes: ['*'], kind: 'key' });
    expect(await seen(madeUp.token)).toEqual(ANON);
  });

  it('follows the key’s own role when that is lowered', async () => {
    const c = await adasCredentials();
    await env.DB.prepare(`UPDATE api_keys SET role = 'viewer' WHERE id = ?1`).bind(c.keyId).run();
    expect(await seen(c.fromKey)).toEqual({ kind: 'jwt', role: 'viewer' });
  });

  it('does not work in a workspace the key is not in', async () => {
    const c = await adasCredentials();
    await createTestSession(env, { email: 'ada@example.com', role: 'owner', orgId: 'org_other' });
    const elsewhere = await signJwt(env, { sub: c.keyId, orgId: 'org_other', role: 'admin', scopes: ['*'], kind: 'key' });
    expect(await seen(elsewhere.token)).toEqual(ANON);
  });
});

describe('a service account key', () => {
  it('carries on when the person who made it leaves or is suspended, and stops with the account', async () => {
    const account = await apikeys.createServiceAccount(env, actorOf(ada, 'admin'), { name: 'Deploy bot', role: 'member' });
    const key = await apikeys.createApiKey(env, actorOf(ada, 'admin'), { name: 'Bot key', scopes: ['*'], serviceAccountId: account.id });
    const fromKey = await signJwt(env, { sub: key.key.id, orgId: ORG, role: 'member', scopes: ['*'], kind: 'key' });

    await env.DB.prepare('DELETE FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2').bind(ORG, ada.user.id).run();
    await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?1').bind(ada.user.id).run();
    expect(await seen(key.secret)).toEqual({ kind: 'apikey', role: 'member' });
    expect(await seen(fromKey.token)).toEqual({ kind: 'jwt', role: 'member' });

    await apikeys.updateServiceAccount(env, actorOf(olive, 'owner'), account.id, { role: 'viewer' });
    expect(await seen(fromKey.token)).toEqual({ kind: 'jwt', role: 'viewer' });

    await apikeys.deleteServiceAccount(env, actorOf(olive, 'owner'), account.id);
    expect(await seen(key.secret)).toEqual(ANON);
    expect(await seen(fromKey.token)).toEqual(ANON);
  });
});

describe('the cost of checking', () => {
  it('is one query for the workspace, the key, the person and their membership together', async () => {
    const c = await adasCredentials();
    const own = await countQueries(env, () => seen(c.own));
    expect(own.result.kind).toBe('jwt');
    expect(own.queries).toHaveLength(1);
    // A token made from a key also counts one call against that key's limit.
    const fromKey = await countQueries(env, () => seen(c.fromKey));
    expect(fromKey.result.kind).toBe('jwt');
    expect(fromKey.queries).toHaveLength(2);
  });
});
