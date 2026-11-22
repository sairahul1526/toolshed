import { beforeEach, describe, expect, it } from 'vitest';
import { listPasskeys, listSessions, removePasskey, renamePasskey, revokeOtherSessions, revokeSession } from '../../src/auth/service';
import type { Env } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, testApp } from './browser';
import { codeOf, must } from './harness';

const app = testApp();

let env: Env;
let ada: TestSession;
let bob: TestSession;
let b: Browser;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const alive = (sessionId: string) => count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', sessionId);
const makeStale = () => env.DB.prepare('UPDATE "session" SET "createdAt" = ?1').bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();

async function addPasskey(userId: string, id: string, name: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt")
     VALUES (?1, ?2, 'pk', ?3, ?1, 0, 'multiDevice', 1, ?4)`,
  )
    .bind(id, name, userId, new Date().toISOString())
    .run();
}

beforeEach(async () => {
  env = createTestEnv().env;
  ada = await createTestSession(env, { email: 'ada@example.com', name: 'Ada' });
  bob = await createTestSession(env, { email: 'bob@example.com', name: 'Bob', role: 'member' });
  b = adopt(new Browser(app, env), ada.cookie);
});

describe('the devices a person is signed in on', () => {
  it('lists their own, this one first, and leaves out the ones that ran out', async () => {
    const phone = await createTestSession(env, { email: 'ada@example.com' });
    const old = await createTestSession(env, { email: 'ada@example.com' });
    await env.DB.prepare('UPDATE "session" SET "userAgent" = ?1, "updatedAt" = ?2 WHERE "id" = ?3')
      .bind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', new Date(Date.now() + 60_000).toISOString(), phone.sessionId)
      .run();
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ?1 WHERE "id" = ?2').bind(new Date(Date.now() - 1000).toISOString(), old.sessionId).run();

    const list = await must(env, b, (c) => listSessions(c));
    expect(list.map((s) => s.id)).toEqual([ada.sessionId, phone.sessionId]);
    expect(list[0]).toMatchObject({ current: true, ip: '203.0.113.7', impersonated: false });
    expect(list[1]).toMatchObject({ current: false, kind: 'phone', os: 'iPhone', browser: 'Safari', device: 'Safari on iPhone' });
    expect(list.some((s) => s.id === bob.sessionId)).toBe(false);
  });

  it('signs one device out and records it', async () => {
    const phone = await createTestSession(env, { email: 'ada@example.com' });
    expect(await must(env, b, (c) => revokeSession(c, phone.sessionId))).toEqual({ current: false });
    expect(await alive(phone.sessionId)).toBe(0);
    expect(await alive(ada.sessionId)).toBe(1);
    expect(await audits('session.revoked')).toBe(1);
    expect(await codeOf(env, b, (c) => revokeSession(c, phone.sessionId))).toBe('auth.session_not_found');
  });

  it('cannot reach someone else’s device', async () => {
    expect(await codeOf(env, b, (c) => revokeSession(c, bob.sessionId))).toBe('auth.session_not_found');
    expect(await codeOf(env, b, (c) => revokeSession(c, undefined as unknown as string))).toBe('auth.session_not_found');
    expect(await alive(bob.sessionId)).toBe(1);
    expect(await audits('session.revoked')).toBe(0);
  });

  it('says so when the device signed out is the one asking', async () => {
    expect(await must(env, b, (c) => revokeSession(c, ada.sessionId))).toEqual({ current: true });
    expect(await b.signedIn()).toBe(false);
  });

  it('signs out everywhere else and keeps this device', async () => {
    await createTestSession(env, { email: 'ada@example.com' });
    await createTestSession(env, { email: 'ada@example.com' });
    expect(await must(env, b, (c) => revokeOtherSessions(c))).toEqual({ count: 2 });
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?1', ada.user.id)).toBe(1);
    expect(await alive(bob.sessionId)).toBe(1);
    expect(await b.signedIn()).toBe(true);
    expect(await audits('session.revoked_others')).toBe(1);

    expect(await must(env, b, (c) => revokeOtherSessions(c))).toEqual({ count: 0 });
    expect(await audits('session.revoked_others')).toBe(1);
  });

  it('needs the person themselves', async () => {
    const anon = new Browser(app, env);
    expect(await codeOf(env, anon, (c) => listSessions(c))).toBe('unauthorized');
    expect(await codeOf(env, anon, (c) => revokeOtherSessions(c))).toBe('unauthorized');

    const phone = await createTestSession(env, { email: 'ada@example.com' });
    const owner = await createTestSession(env, { email: 'install-owner@example.com', instanceOwner: true, orgId: 'org_install' });
    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind(owner.user.id, ada.sessionId).run();
    expect((await must(env, b, (c) => listSessions(c)))[0]).toMatchObject({ current: true, impersonated: true });
    expect(await codeOf(env, b, (c) => revokeSession(c, phone.sessionId))).toBe('auth.impersonating');
    expect(await codeOf(env, b, (c) => revokeOtherSessions(c))).toBe('auth.impersonating');
    expect(await alive(phone.sessionId)).toBe(1);
  });
});

describe('passkeys on the account', () => {
  beforeEach(async () => {
    await addPasskey(ada.user.id, 'pk_ada_1', 'MacBook');
    await addPasskey(ada.user.id, 'pk_ada_2', null);
    await addPasskey(bob.user.id, 'pk_bob', 'Bob’s phone');
  });

  it('lists only the person’s own', async () => {
    const list = await must(env, b, (c) => listPasskeys(c));
    expect(list.map((p) => [p.id, p.name, p.synced])).toEqual([
      ['pk_ada_1', 'MacBook', true],
      ['pk_ada_2', 'Passkey', true],
    ]);
  });

  it('renames one', async () => {
    expect(await must(env, b, (c) => renamePasskey(c, 'pk_ada_2', { name: '  Work laptop ' }))).toMatchObject({ id: 'pk_ada_2', name: 'Work laptop' });
    expect(await audits('passkey.renamed')).toBe(1);
    expect(await codeOf(env, b, (c) => renamePasskey(c, 'pk_ada_2', { name: '' }))).toBe('validation_failed');
    expect(await codeOf(env, b, (c) => renamePasskey(c, 'pk_ada_2', { name: 'x'.repeat(61) }))).toBe('validation_failed');
    expect(await codeOf(env, b, (c) => renamePasskey(c, 'pk_ada_2', { name: '<b>bold</b>' }))).toBe('validation_failed');
  });

  it('removes one after a recent sign-in', async () => {
    await must(env, b, (c) => removePasskey(c, 'pk_ada_1'));
    expect(await count('SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = ?1', ada.user.id)).toBe(1);
    expect(await audits('passkey.removed')).toBe(1);

    await makeStale();
    expect(await codeOf(env, b, (c) => removePasskey(c, 'pk_ada_2'))).toBe('auth.sign_in_again');
    expect(await count('SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = ?1', ada.user.id)).toBe(1);
  });

  it('cannot rename or remove someone else’s', async () => {
    expect(await codeOf(env, b, (c) => renamePasskey(c, 'pk_bob', { name: 'Mine now' }))).toBe('auth.passkey_not_found');
    expect(await codeOf(env, b, (c) => removePasskey(c, 'pk_bob'))).toBe('auth.passkey_not_found');
    expect(await env.DB.prepare('SELECT "name" FROM "passkey" WHERE "id" = ?1').bind('pk_bob').first<string>('name')).toBe('Bob’s phone');
  });
});
