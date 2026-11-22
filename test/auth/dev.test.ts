import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, testApp } from './browser';

const app = testApp();
const workspaces = async (env: Env) => Number(await env.DB.prepare('SELECT COUNT(*) AS n FROM "organization"').first<number>('n'));

describe('the dev-only account doors', () => {
  let env: Env;

  beforeEach(() => {
    env = createTestEnv().env;
  });

  it.each(['production', 'staging', '', undefined])('do not exist when ENVIRONMENT is %j, even for the owner', async (mode) => {
    const live = createTestEnv({ ENVIRONMENT: mode }).env;
    const owner = adopt(new Browser(app, live), (await createTestSession(live, { instanceOwner: true })).cookie);
    expect(await owner.signedIn()).toBe(true);
    const doors = [
      'create-workspace', 'switch-workspace', 'list-workspaces', 'list-members', 'list-invites', 'invite', 'change-role', 'remove-member',
      'account', 'set-password', 'start-two-step', 'confirm-two-step', 'list-passkeys', 'nope',
    ];
    for (const door of doors) {
      const res = await owner.postJson(`/dev/auth/${door}`, { name: 'Sneaky' });
      expect(res.status).toBe(404);
    }
    expect((await owner.get('/dev/auth/list-workspaces')).status).toBe(404);
    expect(await workspaces(live)).toBe(1);
    expect(await live.DB.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'credential'`).first<number>('n')).toBe(0);
  });

  it('change only the caller’s own account, and nobody’s when signed out', async () => {
    const json = { accept: 'application/json' };
    const anon = new Browser(app, env);
    for (const door of ['account', 'set-password', 'start-two-step', 'confirm-two-step', 'list-passkeys']) {
      expect([door, (await anon.postJson(`/dev/auth/${door}`, { password: 'correct horse battery staple', code: '123456' }, json)).status]).toEqual([door, 401]);
    }
    const sam = await createTestSession(env, { email: 'sam@example.com', role: 'member' });
    const other = await createTestSession(env, { email: 'kim@example.com', role: 'member' });
    const b = adopt(new Browser(app, env), sam.cookie);
    // A user id in the body is ignored: the door has no way to name someone else.
    expect((await b.postJson('/dev/auth/set-password', { password: 'correct horse battery staple', userId: other.user.id }, json)).status).toBe(200);
    const rows = await env.DB.prepare(`SELECT "userId" FROM "account" WHERE "providerId" = 'credential'`).all<{ userId: string }>();
    expect(rows.results.map((r) => r.userId)).toEqual([sam.user.id]);
    const account = (await (await b.postJson('/dev/auth/account', {}, json)).json()) as { result: { email: string; hasPassword: boolean } };
    expect(account.result).toMatchObject({ email: 'sam@example.com' });
    expect((await b.postJson('/dev/auth/list-passkeys', {}, json)).status).toBe(200);
  });

  it('run the real service with the caller’s own session', async () => {
    const anon = await new Browser(app, env).postJson('/dev/auth/create-workspace', { name: 'Nobody' });
    expect(anon.status).toBe(401);

    // A member who may not create workspaces is refused here exactly as on any screen.
    const member = adopt(new Browser(app, env), (await createTestSession(env, { email: 'sam@example.com', role: 'member' })).cookie);
    const refused = await member.postJson('/dev/auth/create-workspace', { name: 'Mine' }, { accept: 'application/json' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'auth.workspace_create_off' });
    expect(await workspaces(env)).toBe(1);

    const owner = adopt(new Browser(app, env), (await createTestSession(env, { email: 'owner@example.com', instanceOwner: true, orgId: 'org_owner' })).cookie);
    const made = await owner.postJson('/dev/auth/create-workspace', { name: 'Second Shed' });
    expect(made.status).toBe(200);
    const { result } = (await made.json()) as { result: { id: string; slug: string; role: string } };
    expect(result).toMatchObject({ slug: 'second-shed', role: 'owner' });

    const listed = (await (await owner.postJson('/dev/auth/list-workspaces', {})).json()) as { result: { id: string }[] };
    expect(listed.result.map((w) => w.id)).toContain(result.id);
    // Someone outside a workspace cannot switch into it.
    expect((await member.postJson('/dev/auth/switch-workspace', { workspaceId: result.id })).status).toBe(404);
    expect((await owner.postJson('/dev/auth/switch-workspace', { workspaceId: result.id })).status).toBe(200);
  });

  it('hold the member doors to the same role rules', async () => {
    const owner = await createTestSession(env, { email: 'owner@example.com', instanceOwner: true });
    const viewer = adopt(new Browser(app, env), (await createTestSession(env, { email: 'vic@example.com', role: 'viewer' })).cookie);
    const json = { accept: 'application/json' };
    for (const [door, body] of [
      ['invite', { email: 'new@example.com', role: 'owner' }],
      ['list-invites', {}],
      ['change-role', { userId: owner.user.id, role: 'viewer' }],
      ['remove-member', { userId: owner.user.id }],
    ] as const) {
      const res = await viewer.postJson(`/dev/auth/${door}`, body, json);
      expect([door, res.status, ((await res.json()) as { code: string }).code]).toEqual([door, 403, 'auth.role_needed']);
    }
    expect((await viewer.postJson('/dev/auth/list-members', {})).status).toBe(200);
    // No door hands out the install: an invited owner of a workspace is still an ordinary account.
    const boss = adopt(new Browser(app, env), owner.cookie);
    const sent = await boss.postJson('/dev/auth/invite', { email: 'new@example.com', role: 'owner', instanceOwner: true });
    expect(sent.status).toBe(200);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "role" = 'admin'`).first<number>('n')).toBe(1);
  });

  it('refuse a post from another site, and unknown doors', async () => {
    const owner = adopt(new Browser(app, env), (await createTestSession(env, { instanceOwner: true })).cookie);
    expect((await owner.postJson('/dev/auth/create-workspace', { name: 'X' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await owner.postJson('/dev/auth/constructor', {})).status).toBe(404);
    expect((await owner.postJson('/dev/auth/make-owner', { email: 'mallory@example.com' })).status).toBe(404);
    expect(await workspaces(env)).toBe(1);
  });
});
