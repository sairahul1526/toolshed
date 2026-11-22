import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadAuth } from '../../src/auth/load';
import {
  assertMayAssign,
  changeMemberRole,
  deleteWorkspace,
  inviteMember,
  isLowered,
  leaveWorkspace,
  listMembers,
  listWorkspaces,
  parseRole,
  removeMember,
  renameWorkspace,
} from '../../src/auth/service';
import { sessionFromRequest } from '../../src/auth/session';
import * as apikeys from '../../src/core/apikeys';
import { AppError } from '../../src/core/errors';
import { setSetting } from '../../src/core/settings';
import type { AppEnv, Env, Role } from '../../src/env';
import { ROLES } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, testApp } from './browser';
import { codeOf, must } from './harness';

const app = testApp();
const ORG = 'org_test';

let env: Env;
let people: Record<Role, TestSession>;
let as: Record<Role, Browser>;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const roleOf = (userId: string, org = ORG) => env.DB.prepare('SELECT "role" FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2').bind(org, userId).first<string>('role');
const codeFrom = (err: unknown) => (err instanceof AppError ? err.code : String(err));

/** What a request carrying this API key is seen as. */
async function keyHolder(secret: string): Promise<{ kind: string; role: string | null }> {
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
  const res = await probe.request('/who', { headers: { authorization: `Bearer ${secret}`, 'cf-connecting-ip': '203.0.113.9' } }, env);
  return (await res.json()) as { kind: string; role: string | null };
}

async function keyFor(who: TestSession, role: 'admin' | 'member' | 'viewer') {
  return apikeys.createApiKey(env, { orgId: ORG, userId: who.user.id, role, label: who.user.email, via: 'session' }, { name: 'CI', scopes: ['*'] });
}

beforeEach(async () => {
  env = createTestEnv().env;
  people = {
    owner: await createTestSession(env, { email: 'olive@example.com', name: 'Olive', role: 'owner', instanceOwner: true }),
    admin: await createTestSession(env, { email: 'adam@example.com', name: 'Adam', role: 'admin' }),
    member: await createTestSession(env, { email: 'mel@example.com', name: 'Mel', role: 'member' }),
    viewer: await createTestSession(env, { email: 'vic@example.com', name: 'Vic', role: 'viewer' }),
  };
  as = {
    owner: adopt(new Browser(app, env), people.owner.cookie),
    admin: adopt(new Browser(app, env), people.admin.cookie),
    member: adopt(new Browser(app, env), people.member.cookie),
    viewer: adopt(new Browser(app, env), people.viewer.cookie),
  };
});

describe('the role rules on their own', () => {
  const tryAssign = (actor: Role, current: Role | null, next: Role | null) => {
    try {
      assertMayAssign(actor, current, next);
      return 'ok';
    } catch (err) {
      return codeFrom(err);
    }
  };

  it('lets only admins and owners manage people', () => {
    for (const next of ROLES) {
      expect(tryAssign('member', 'viewer', next)).toBe('auth.role_needed');
      expect(tryAssign('viewer', 'viewer', next)).toBe('auth.role_needed');
    }
    expect(tryAssign('member', null, 'viewer')).toBe('auth.role_needed');
    expect(tryAssign('viewer', 'member', null)).toBe('auth.role_needed');
  });

  it('lets only an owner add, change or remove an owner', () => {
    expect(tryAssign('admin', 'member', 'owner')).toBe('auth.role_over_owner');
    expect(tryAssign('admin', 'owner', 'member')).toBe('auth.role_over_owner');
    expect(tryAssign('admin', 'owner', null)).toBe('auth.role_over_owner');
    expect(tryAssign('admin', null, 'owner')).toBe('auth.role_over_owner');
    expect(tryAssign('owner', 'owner', 'admin')).toBe('ok');
    expect(tryAssign('owner', null, 'owner')).toBe('ok');
    for (const current of ['admin', 'member', 'viewer'] as const) for (const next of ['admin', 'member', 'viewer'] as const) expect(tryAssign('admin', current, next)).toBe('ok');
  });

  it('knows a lower role from a higher one, and a role from a typo', () => {
    expect(isLowered('admin', 'member')).toBe(true);
    expect(isLowered('owner', 'admin')).toBe(true);
    expect(isLowered('viewer', 'member')).toBe(false);
    expect(isLowered('member', 'member')).toBe(false);
    expect(parseRole(' Admin ')).toBe('admin');
    for (const bad of ['', 'root', 'superadmin', null, 3, 'owner,admin']) expect(() => parseRole(bad)).toThrow();
  });
});

describe('listing members', () => {
  it('shows everyone to everyone, and sign-in details to admins only', async () => {
    const seen = await must(env, as.viewer, (c) => listMembers(c));
    // Joined in the same millisecond here, so the order between them is not fixed.
    expect(seen.map((m) => [m.email, m.role, m.isYou]).sort()).toEqual([
      ['adam@example.com', 'admin', false],
      ['mel@example.com', 'member', false],
      ['olive@example.com', 'owner', false],
      ['vic@example.com', 'viewer', true],
    ]);
    expect(seen.every((m) => m.twoStep === null && m.passkeys === null && m.lastSeenAt === null)).toBe(true);

    const full = await must(env, as.admin, (c) => listMembers(c));
    expect(full.every((m) => m.twoStep === false && m.passkeys === 0 && typeof m.lastSeenAt === 'number')).toBe(true);
  });

  it('needs a signed-in person who is in a workspace', async () => {
    expect(await codeOf(env, new Browser(app, env), (c) => listMembers(c))).toBe('unauthorized');
    await env.DB.prepare('DELETE FROM "member" WHERE "userId" = ?1').bind(people.viewer.user.id).run();
    expect(await codeOf(env, as.viewer, (c) => listMembers(c))).toBe('auth.workspace_not_found');
  });

  it('does not answer an API key', async () => {
    const key = await keyFor(people.admin, 'admin');
    expect(await codeOf(env, { authorization: `Bearer ${key.secret}` }, (c) => listMembers(c))).toBe('unauthorized');
    expect(await codeOf(env, { authorization: `Bearer ${key.secret}` }, (c) => removeMember(c, people.member.user.id))).toBe('unauthorized');
  });
});

describe('changing a role', () => {
  it('is for admins and owners', async () => {
    expect(await codeOf(env, as.member, (c) => changeMemberRole(c, people.viewer.user.id, 'member'))).toBe('auth.role_needed');
    expect(await codeOf(env, as.viewer, (c) => changeMemberRole(c, people.member.user.id, 'viewer'))).toBe('auth.role_needed');
    expect(await roleOf(people.viewer.user.id)).toBe('viewer');
  });

  it('lets an admin move people between admin, member and viewer', async () => {
    expect(await must(env, as.admin, (c) => changeMemberRole(c, people.viewer.user.id, 'member'))).toEqual({ userId: people.viewer.user.id, role: 'member', changed: true });
    expect(await must(env, as.admin, (c) => changeMemberRole(c, people.member.user.id, 'admin'))).toMatchObject({ role: 'admin', changed: true });
    expect(await roleOf(people.viewer.user.id)).toBe('member');
    expect(await roleOf(people.member.user.id)).toBe('admin');
    expect(await audits('member.role_changed')).toBe(2);
    const meta = await env.DB.prepare(`SELECT meta FROM audit_log WHERE action = 'member.role_changed' AND target_id = ?1`).bind(people.viewer.user.id).first<string>('meta');
    expect(JSON.parse(meta!)).toEqual({ from: 'viewer', to: 'member' });
  });

  it('keeps owners out of an admin’s reach', async () => {
    expect(await codeOf(env, as.admin, (c) => changeMemberRole(c, people.owner.user.id, 'member'))).toBe('auth.role_over_owner');
    expect(await codeOf(env, as.admin, (c) => changeMemberRole(c, people.member.user.id, 'owner'))).toBe('auth.role_over_owner');
    expect(await roleOf(people.owner.user.id)).toBe('owner');
    expect(await roleOf(people.member.user.id)).toBe('member');
  });

  it('lets nobody change their own role', async () => {
    expect(await codeOf(env, as.admin, (c) => changeMemberRole(c, people.admin.user.id, 'owner'))).toBe('auth.role_self');
    expect(await codeOf(env, as.owner, (c) => changeMemberRole(c, people.owner.user.id, 'admin'))).toBe('auth.role_self');
    expect(await roleOf(people.admin.user.id)).toBe('admin');
  });

  it('lets an owner make another owner, who can then step the first one down', async () => {
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'owner'));
    await must(env, as.admin, (c) => changeMemberRole(c, people.owner.user.id, 'member'));
    expect(await roleOf(people.owner.user.id)).toBe('member');
    expect(await count(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1 AND "role" = 'owner'`, ORG)).toBe(1);
    // The one who stepped down is a plain member now.
    expect(await codeOf(env, as.owner, (c) => changeMemberRole(c, people.viewer.user.id, 'member'))).toBe('auth.role_needed');
  });

  it('refuses a made-up role and a person who is not here', async () => {
    expect(await codeOf(env, as.owner, (c) => changeMemberRole(c, people.member.user.id, 'root'))).toBe('auth.role_unknown');
    expect(await codeOf(env, as.owner, (c) => changeMemberRole(c, 'usr_nobody', 'member'))).toBe('auth.not_member');
    const elsewhere = await createTestSession(env, { email: 'far@example.com', orgId: 'org_other' });
    expect(await codeOf(env, as.owner, (c) => changeMemberRole(c, elsewhere.user.id, 'viewer'))).toBe('auth.not_member');
    expect(await roleOf(elsewhere.user.id, 'org_other')).toBe('owner');
  });

  it('does nothing, and logs nothing, when the role is the same', async () => {
    expect(await must(env, as.owner, (c) => changeMemberRole(c, people.member.user.id, 'member'))).toMatchObject({ changed: false });
    expect(await audits('member.role_changed')).toBe(0);
  });

  it('uses the role the database holds at the moment of the change', async () => {
    // The admin's role is read, then taken away before the change is made.
    const code = await codeOf(env, as.admin, async (c) => {
      await sessionFromRequest(c);
      await c.env.DB.prepare(`UPDATE "member" SET "role" = 'viewer' WHERE "userId" = ?1`).bind(people.admin.user.id).run();
      return changeMemberRole(c, people.viewer.user.id, 'admin');
    });
    expect(code).toBe('auth.role_needed');
    expect(await roleOf(people.viewer.user.id)).toBe('viewer');
  });

  it('lowers the person’s API keys with them, and never raises a key', async () => {
    const key = await keyFor(people.admin, 'admin');
    expect(await keyHolder(key.secret)).toEqual({ kind: 'apikey', role: 'admin' });
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'viewer'));
    expect(await keyHolder(key.secret)).toEqual({ kind: 'apikey', role: 'viewer' });
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'admin'));
    expect(await keyHolder(key.secret)).toEqual({ kind: 'apikey', role: 'viewer' });
  });

  it('cancels the invites a person sent once they can no longer invite', async () => {
    await must(env, as.admin, (c) => inviteMember(c, { email: 'new@example.com', role: 'member' }));
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'member'));
    expect(await count(`SELECT COUNT(*) AS n FROM "invitation" WHERE "status" = 'pending'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "invitation" WHERE "status" = 'canceled'`)).toBe(1);
  });

  it('keeps an ex-owner’s ordinary invites but cancels the owner invites they sent', async () => {
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'owner'));
    await must(env, as.admin, (c) => inviteMember(c, { email: 'boss@example.com', role: 'owner' }));
    await must(env, as.admin, (c) => inviteMember(c, { email: 'new@example.com', role: 'member' }));
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'admin'));
    const left = await env.DB.prepare(`SELECT "email" FROM "invitation" WHERE "status" = 'pending'`).all<{ email: string }>();
    expect(left.results.map((r) => r.email)).toEqual(['new@example.com']);
  });
});

describe('removing a member', () => {
  it('is for admins and owners, and never for owners by admins', async () => {
    expect(await codeOf(env, as.member, (c) => removeMember(c, people.viewer.user.id))).toBe('auth.role_needed');
    expect(await codeOf(env, as.viewer, (c) => removeMember(c, people.member.user.id))).toBe('auth.role_needed');
    expect(await codeOf(env, as.admin, (c) => removeMember(c, people.owner.user.id))).toBe('auth.role_over_owner');
    expect(await codeOf(env, as.admin, (c) => removeMember(c, people.admin.user.id))).toBe('auth.self_action');
    expect(await codeOf(env, as.admin, (c) => removeMember(c, 'usr_nobody'))).toBe('auth.not_member');
    expect(await count('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1', ORG)).toBe(4);
  });

  it('takes the workspace away on every device at once, and keeps the account', async () => {
    const second = adopt(new Browser(app, env), (await createTestSession(env, { email: 'mel@example.com', role: 'member' })).cookie);
    await must(env, as.admin, (c) => removeMember(c, people.member.user.id));
    expect(await roleOf(people.member.user.id)).toBeNull();
    for (const device of [as.member, second]) {
      expect(await codeOf(env, device, (c) => listMembers(c))).toBe('auth.workspace_not_found');
      expect(await must(env, device, (c) => listWorkspaces(c))).toEqual([]);
      expect((await device.get('/app')).headers.get('location')).toBe('/welcome');
    }
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', people.member.user.id)).toBe(1);
    expect(await audits('member.removed')).toBe(1);
  });

  it('moves the person to another workspace of theirs when they have one', async () => {
    await createTestSession(env, { email: 'mel@example.com', role: 'viewer', orgId: 'org_other' });
    await must(env, as.owner, (c) => removeMember(c, people.member.user.id));
    const active = await env.DB.prepare('SELECT DISTINCT "activeOrganizationId" AS org FROM "session" WHERE "userId" = ?1').bind(people.member.user.id).all<{ org: string }>();
    expect(active.results.map((r) => r.org)).toEqual(['org_other']);
  });

  it('stops the removed person’s API keys from working', async () => {
    const key = await keyFor(people.admin, 'admin');
    expect((await keyHolder(key.secret)).kind).toBe('apikey');
    await must(env, as.owner, (c) => removeMember(c, people.admin.user.id));
    expect(await keyHolder(key.secret)).toEqual({ kind: 'anon', role: null });
  });

  it('cancels the invites the removed person sent', async () => {
    await must(env, as.admin, (c) => inviteMember(c, { email: 'new@example.com', role: 'viewer' }));
    await must(env, as.owner, (c) => removeMember(c, people.admin.user.id));
    expect(await count(`SELECT COUNT(*) AS n FROM "invitation" WHERE "status" = 'pending'`)).toBe(0);
  });

  it('lets an owner remove another owner, but not the last one', async () => {
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'owner'));
    await must(env, as.admin, (c) => removeMember(c, people.owner.user.id));
    expect(await roleOf(people.owner.user.id)).toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1 AND "role" = 'owner'`, ORG)).toBe(1);
  });
});

describe('leaving a workspace', () => {
  it('lets a member leave, and revokes their keys', async () => {
    const key = await keyFor(people.member, 'member');
    await must(env, as.member, (c) => leaveWorkspace(c));
    expect(await roleOf(people.member.user.id)).toBeNull();
    expect((await keyHolder(key.secret)).kind).toBe('anon');
    expect(await audits('member.left')).toBe(1);
    expect((await as.member.get('/app')).headers.get('location')).toBe('/welcome');
  });

  it('keeps the last owner in', async () => {
    expect(await codeOf(env, as.owner, (c) => leaveWorkspace(c))).toBe('auth.last_owner');
    expect(await roleOf(people.owner.user.id)).toBe('owner');
    expect(await audits('member.left')).toBe(0);
  });

  it('lets an owner leave once there is another, and only one of two at the same moment', async () => {
    await must(env, as.owner, (c) => changeMemberRole(c, people.admin.user.id, 'owner'));
    await must(env, as.owner, (c) => leaveWorkspace(c));
    expect(await codeOf(env, as.admin, (c) => leaveWorkspace(c))).toBe('auth.last_owner');
    expect(await count(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1 AND "role" = 'owner'`, ORG)).toBe(1);
  });

  it('is not something the owner of the install can do for someone', async () => {
    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "userId" = ?2').bind(people.owner.user.id, people.member.user.id).run();
    expect(await codeOf(env, as.member, (c) => leaveWorkspace(c))).toBe('auth.impersonating');
  });
});

describe('renaming a workspace', () => {
  it('is for admins and owners', async () => {
    expect(await codeOf(env, as.member, (c) => renameWorkspace(c, { name: 'Mine now' }))).toBe('auth.role_needed');
    const renamed = await must(env, as.admin, (c) => renameWorkspace(c, { name: '  Acme Tools  ' }));
    expect(renamed).toMatchObject({ id: ORG, name: 'Acme Tools', slug: 'test', role: 'admin' });
    expect(await audits('workspace.renamed')).toBe(1);
    expect((await must(env, as.viewer, (c) => listWorkspaces(c)))[0]?.name).toBe('Acme Tools');
  });

  it('changes the short name when asked, unless another workspace has it', async () => {
    await createTestSession(env, { email: 'far@example.com', orgId: 'org_other' });
    expect(await must(env, as.owner, (c) => renameWorkspace(c, { name: 'Test Workspace', slug: 'Acme' }))).toMatchObject({ slug: 'acme' });
    expect(await codeOf(env, as.owner, (c) => renameWorkspace(c, { name: 'Test Workspace', slug: 'org-other' }))).toBe('auth.slug_taken');
    expect(await codeOf(env, as.owner, (c) => renameWorkspace(c, { name: 'Test Workspace', slug: 'no spaces' }))).toBe('validation_failed');
    expect(await codeOf(env, as.owner, (c) => renameWorkspace(c, { name: '   ' }))).toBe('validation_failed');
    expect(await codeOf(env, as.owner, (c) => renameWorkspace(c, { name: '<b>x</b>' }))).toBe('validation_failed');
  });

  it('logs nothing when nothing changed', async () => {
    await must(env, as.owner, (c) => renameWorkspace(c, { name: 'Test Workspace' }));
    expect(await audits('workspace.renamed')).toBe(0);
  });
});

describe('deleting a workspace', () => {
  it('is for owners, who must type the short name', async () => {
    expect(await codeOf(env, as.admin, (c) => deleteWorkspace(c, { confirm: 'test' }))).toBe('auth.role_needed');
    expect(await codeOf(env, as.owner, (c) => deleteWorkspace(c, { confirm: '' }))).toBe('validation_failed');
    expect(await codeOf(env, as.owner, (c) => deleteWorkspace(c, { confirm: 'Test Workspace' }))).toBe('validation_failed');
    expect(await count('SELECT COUNT(*) AS n FROM "organization"')).toBe(1);
  });

  it('removes the workspace, its people, invites, settings and log, and leaves the accounts', async () => {
    await createTestSession(env, { email: 'mel@example.com', role: 'member', orgId: 'org_other' });
    await must(env, as.admin, (c) => inviteMember(c, { email: 'new@example.com', role: 'member' }));
    await setSetting(env, ORG, 'timezone', 'Europe/Paris');
    const key = await keyFor(people.admin, 'admin');

    await must(env, as.owner, (c) => deleteWorkspace(c, { confirm: 'test' }));

    expect(await count('SELECT COUNT(*) AS n FROM "organization" WHERE "id" = ?1', ORG)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1', ORG)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "invitation" WHERE "organizationId" = ?1', ORG)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM settings WHERE scope = ?1', ORG)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?1', ORG)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "user"')).toBe(4);
    // One install-wide line says who deleted what.
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'workspace.deleted' AND org_id IS NULL AND actor_id = ?1`, people.owner.user.id)).toBe(1);

    // People who had it open move to another workspace of theirs, or to none.
    expect((await must(env, as.member, (c) => listWorkspaces(c))).map((w) => w.id)).toEqual(['org_other']);
    expect((await must(env, as.member, (c) => listMembers(c))).map((m) => m.email)).toEqual(['mel@example.com']);
    expect((await as.owner.get('/app')).headers.get('location')).toBe('/welcome');
    // A key of the deleted workspace is nobody.
    expect(await keyHolder(key.secret)).toEqual({ kind: 'anon', role: null });
  });

  it('checks the owner is still an owner right before deleting', async () => {
    const code = await codeOf(env, as.owner, async (c) => {
      await sessionFromRequest(c);
      await c.env.DB.prepare(`UPDATE "member" SET "role" = 'admin' WHERE "userId" = ?1`).bind(people.owner.user.id).run();
      return deleteWorkspace(c, { confirm: 'test' });
    });
    expect(code).toBe('auth.role_needed');
    expect(await count('SELECT COUNT(*) AS n FROM "organization"')).toBe(1);
  });

  it('is not done from a "signed in as" session', async () => {
    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind('usr_someone', people.owner.sessionId).run();
    expect(await codeOf(env, as.owner, (c) => deleteWorkspace(c, { confirm: 'test' }))).toBe('auth.impersonating');
  });
});
