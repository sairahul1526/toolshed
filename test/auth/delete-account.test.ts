import { beforeEach, describe, expect, it } from 'vitest';
import { accountDeletionBlockers, deleteAccount } from '../../src/auth/service';
import * as apikeys from '../../src/core/apikeys';
import type { Env } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, testApp } from './browser';
import { codeOf, must, seenAs } from './harness';

const app = testApp();

let env: Env;
let olive: TestSession;
let mel: TestSession;
let asOlive: Browser;
let asMel: Browser;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const exists = (userId: string) => count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', userId);

beforeEach(async () => {
  env = createTestEnv().env;
  olive = await createTestSession(env, { email: 'olive@example.com', name: 'Olive', role: 'owner', instanceOwner: true });
  mel = await createTestSession(env, { email: 'mel@example.com', name: 'Mel', role: 'member' });
  asOlive = adopt(new Browser(app, env), olive.cookie);
  asMel = adopt(new Browser(app, env), mel.cookie);
});

describe('deleting your own account', () => {
  it('removes the account and everything that signs it in', async () => {
    const key = await apikeys.createApiKey(env, { orgId: mel.org.id, userId: mel.user.id, role: 'member', label: mel.user.email, via: 'session' }, { name: 'CI', scopes: ['*'] });
    await env.DB.prepare(
      `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp") VALUES ('pk_mel', 'Phone', 'pk', ?1, 'cred', 0, 'multiDevice', 1)`,
    )
      .bind(mel.user.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId") VALUES ('inv_1', ?1, 'new@example.com', 'member', 'pending', ?2, ?3, ?4)`,
    )
      .bind(mel.org.id, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString(), mel.user.id)
      .run();
    expect((await seenAs(env, { authorization: `Bearer ${key.secret}` })).kind).toBe('apikey');
    expect(await must(env, asMel, (c) => accountDeletionBlockers(c))).toEqual([]);

    await must(env, asMel, (c) => deleteAccount(c, { confirm: ' Mel@Example.com ' }));

    expect(await exists(mel.user.id)).toBe(0);
    for (const table of ['session', 'member', 'passkey']) {
      expect(await count(`SELECT COUNT(*) AS n FROM "${table}" WHERE "userId" = ?1`, mel.user.id)).toBe(0);
    }
    expect(await count('SELECT COUNT(*) AS n FROM "invitation" WHERE "inviterId" = ?1', mel.user.id)).toBe(0);
    expect((await seenAs(env, { authorization: `Bearer ${key.secret}` })).kind).toBe('anon');
    expect(await asMel.signedIn()).toBe(false);
    expect(await audits('user.deleted')).toBe(1);
    // Everyone else is untouched.
    expect(await exists(olive.user.id)).toBe(1);
    expect(await asOlive.signedIn()).toBe(true);
  });

  it('wants the email address typed out', async () => {
    expect(await codeOf(env, asMel, (c) => deleteAccount(c, { confirm: 'yes' }))).toBe('validation_failed');
    expect(await codeOf(env, asMel, (c) => deleteAccount(c, { confirm: undefined as unknown as string }))).toBe('validation_failed');
    expect(await codeOf(env, asMel, (c) => deleteAccount(c, { confirm: olive.user.email }))).toBe('validation_failed');
    expect(await exists(mel.user.id)).toBe(1);
  });

  it('is refused while the person is the only owner of a workspace, and says which', async () => {
    const solo = await createTestSession(env, { email: 'mel@example.com', orgId: 'org_solo', role: 'owner' });
    const b = adopt(new Browser(app, env), solo.cookie);
    expect(await must(env, b, (c) => accountDeletionBlockers(c))).toEqual([{ id: 'org_solo', name: 'Workspace org_solo', slug: 'org-solo' }]);
    expect(await codeOf(env, b, (c) => deleteAccount(c, { confirm: 'mel@example.com' }))).toBe('auth.sole_owner');
    expect(await exists(mel.user.id)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?1', mel.user.id)).toBe(2);

    // With a second owner there, nothing stands in the way.
    await createTestSession(env, { email: 'olive@example.com', orgId: 'org_solo', role: 'owner' });
    expect(await must(env, b, (c) => accountDeletionBlockers(c))).toEqual([]);
    await must(env, b, (c) => deleteAccount(c, { confirm: 'mel@example.com' }));
    expect(await exists(mel.user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "organization" WHERE "id" = ?1', 'org_solo')).toBe(1);
  });

  it('never leaves the install without an owner', async () => {
    await createTestSession(env, { email: 'adam@example.com', role: 'owner' });
    expect(await must(env, asOlive, (c) => accountDeletionBlockers(c))).toEqual([]);
    expect(await codeOf(env, asOlive, (c) => deleteAccount(c, { confirm: olive.user.email }))).toBe('auth.last_instance_owner');
    expect(await exists(olive.user.id)).toBe(1);
    expect(await audits('user.deleted')).toBe(0);
  });

  it('needs the person themselves and a recent sign-in', async () => {
    expect(await codeOf(env, new Browser(app, env), (c) => deleteAccount(c, { confirm: mel.user.email }))).toBe('unauthorized');

    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind(olive.user.id, mel.sessionId).run();
    expect(await codeOf(env, asMel, (c) => deleteAccount(c, { confirm: mel.user.email }))).toBe('auth.impersonating');

    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = NULL, "createdAt" = ?1 WHERE "id" = ?2').bind(new Date(Date.now() - 31 * 60_000).toISOString(), mel.sessionId).run();
    expect(await codeOf(env, asMel, (c) => deleteAccount(c, { confirm: mel.user.email }))).toBe('auth.sign_in_again');
    expect(await exists(mel.user.id)).toBe(1);
  });
});
