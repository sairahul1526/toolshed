import { beforeEach, describe, expect, it } from 'vitest';
import { INVITE_TTL_MS } from '../../src/auth/config';
import { acceptInvite, cancelInvite, inviteMember, listInvites, listMembers, listWorkspaces, MEMBERS_CAN_CREATE_KEY, resendInvite } from '../../src/auth/service';
import { sessionFromRequest } from '../../src/auth/session';
import { devOutbox } from '../../src/core/email';
import { INSTANCE, setSetting } from '../../src/core/settings';
import type { Env, Role } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastEmail, testApp } from './browser';
import { codeOf, must } from './harness';

const app = testApp();
const ORG = 'org_test';
const NEW = 'new@example.com';

let env: Env;
let people: Record<Role, TestSession>;
let as: Record<Role, Browser>;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const statusOf = (id: string) => env.DB.prepare('SELECT "status" FROM "invitation" WHERE "id" = ?1').bind(id).first<string>('status');
const roleOf = (email: string, org = ORG) =>
  env.DB.prepare('SELECT m."role" AS role FROM "member" m JOIN "user" u ON u."id" = m."userId" WHERE m."organizationId" = ?1 AND u."email" = ?2').bind(org, email).first<string>('role');
const users = (email: string) => count('SELECT COUNT(*) AS n FROM "user" WHERE "email" = ?1', email);
const mails = async (to: string, template: string) => (await devOutbox(env, { to, limit: 20 })).filter((m) => m.template === template);
const pathOf = (link: string) => new URL(link).pathname;
const expire = (id: string) => env.DB.prepare('UPDATE "invitation" SET "expiresAt" = ?2 WHERE "id" = ?1').bind(id, new Date(Date.now() - 1000).toISOString()).run();

/** The sign-in code emailed to an address. The invite email went to the same inbox, so pick by kind. */
async function codeFor(email: string): Promise<string> {
  const code = (await mails(email, 'sign-in-code'))[0]?.text?.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`No code was emailed to ${email}`);
  return code;
}

const invite = (role: Role, email = NEW, by: Role = 'owner') => must(env, as[by], (c) => inviteMember(c, { email, role }));

/** A signed-in person with an account elsewhere, to accept invites through the service. */
async function outsider(email = NEW): Promise<{ session: TestSession; browser: Browser }> {
  const session = await createTestSession(env, { email, name: 'Nia New', orgId: 'org_home' });
  return { session, browser: adopt(new Browser(app, env), session.cookie) };
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

describe('inviting someone', () => {
  it('saves the invite, emails its link and logs it', async () => {
    const before = Date.now();
    const sent = await must(env, as.admin, (c) => inviteMember(c, { email: ' New@Example.com ', role: 'member' }));
    expect(sent).toMatchObject({ email: NEW, role: 'member', status: 'pending', invitedBy: { id: people.admin.user.id, name: 'Adam' } });
    expect(sent.id).toMatch(/^inv_[A-Za-z0-9_-]{24}$/);
    expect(sent.link).toBe(`http://localhost/invite/${sent.id}`);
    expect(sent.expiresAt - sent.createdAt).toBe(INVITE_TTL_MS);
    expect(sent.createdAt).toBeGreaterThanOrEqual(before);

    const mail = await lastEmail(env, NEW);
    expect(mail?.template).toBe('invite');
    expect(mail?.text).toContain(sent.link);
    expect(mail?.text).toContain('Adam');
    expect(mail?.text).toContain('Test Workspace');
    // The email carries no code: the link alone lets nobody in.
    expect(await count('SELECT COUNT(*) AS n FROM auth_codes')).toBe(0);

    const meta = await env.DB.prepare(`SELECT meta FROM audit_log WHERE action = 'invite.sent' AND target_id = ?1`).bind(sent.id).first<string>('meta');
    expect(JSON.parse(meta!)).toEqual({ email: NEW, role: 'member', emailStatus: sent.emailStatus });
    // No account yet: that happens when the person proves the inbox is theirs.
    expect(await users(NEW)).toBe(0);
  });

  it('is for admins and owners, and only an owner invites an owner', async () => {
    expect(await codeOf(env, as.member, (c) => inviteMember(c, { email: NEW, role: 'viewer' }))).toBe('auth.role_needed');
    expect(await codeOf(env, as.viewer, (c) => inviteMember(c, { email: NEW, role: 'viewer' }))).toBe('auth.role_needed');
    expect(await codeOf(env, as.admin, (c) => inviteMember(c, { email: NEW, role: 'owner' }))).toBe('auth.role_over_owner');
    expect(await codeOf(env, new Browser(app, env), (c) => inviteMember(c, { email: NEW, role: 'viewer' }))).toBe('unauthorized');
    expect(await count('SELECT COUNT(*) AS n FROM "invitation"')).toBe(0);
    expect(await mails(NEW, 'invite')).toEqual([]);
    expect((await invite('owner')).role).toBe('owner');
    expect((await invite('admin', 'second@example.com', 'admin')).role).toBe('admin');
  });

  it('refuses a bad address, a made-up role and someone already here', async () => {
    expect(await codeOf(env, as.owner, (c) => inviteMember(c, { email: 'not an email', role: 'member' }))).toBe('validation_failed');
    expect(await codeOf(env, as.owner, (c) => inviteMember(c, { email: NEW, role: 'root' }))).toBe('auth.role_unknown');
    expect(await codeOf(env, as.owner, (c) => inviteMember(c, { email: 'MEL@example.com', role: 'admin' }))).toBe('auth.already_member');
    expect(await count('SELECT COUNT(*) AS n FROM "invitation"')).toBe(0);
  });

  it('replaces the older invite for the same address', async () => {
    const first = await invite('viewer', NEW, 'admin');
    const second = await invite('member');
    expect(await statusOf(first.id)).toBe('canceled');
    expect(await statusOf(second.id)).toBe('pending');
    expect((await new Browser(app, env).get(pathOf(first.link))).status).toBe(404);
    expect((await new Browser(app, env).get(pathOf(second.link))).status).toBe(200);
  });

  it('does not let an admin replace an owner invite', async () => {
    const boss = await invite('owner');
    expect(await codeOf(env, as.admin, (c) => inviteMember(c, { email: NEW, role: 'viewer' }))).toBe('auth.role_over_owner');
    expect(await statusOf(boss.id)).toBe('pending');
    expect(await count('SELECT COUNT(*) AS n FROM "invitation"')).toBe(1);
  });

  it('uses the role the database holds at the moment of the invite', async () => {
    const code = await codeOf(env, as.admin, async (c) => {
      await sessionFromRequest(c);
      await c.env.DB.prepare(`UPDATE "member" SET "role" = 'viewer' WHERE "userId" = ?1`).bind(people.admin.user.id).run();
      return inviteMember(c, { email: NEW, role: 'member' });
    });
    expect(code).toBe('auth.role_needed');
    expect(await count('SELECT COUNT(*) AS n FROM "invitation"')).toBe(0);
  });

  it('stops one person sending invites without end', async () => {
    const hour = 3_600_000;
    const now = Math.floor(Date.now() / hour) * hour;
    // Both the hour we are in and the next, so a test that straddles the hour still holds.
    for (const start of [now, now + hour]) {
      await env.DB.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 50)').bind(`auth.invitePerUser:${people.admin.user.id}`, start).run();
    }
    expect(await codeOf(env, as.admin, (c) => inviteMember(c, { email: NEW, role: 'member' }))).toBe('rate_limited');
    expect(await count('SELECT COUNT(*) AS n FROM "invitation"')).toBe(0);
    // The limit is per sender.
    expect((await invite('member')).status).toBe('pending');
  });
});

describe('listing invites', () => {
  it('shows open invites of this workspace to admins, newest first, expired ones marked', async () => {
    const old = await invite('viewer', 'old@example.com');
    await env.DB.prepare('UPDATE "invitation" SET "createdAt" = ?2 WHERE "id" = ?1').bind(old.id, new Date(Date.now() - 86_400_000).toISOString()).run();
    await expire(old.id);
    const fresh = await invite('member', NEW, 'admin');
    const cancelled = await invite('member', 'gone@example.com');
    await must(env, as.owner, (c) => cancelInvite(c, cancelled.id));
    const far = await createTestSession(env, { email: 'far@example.com', orgId: 'org_other' });
    await must(env, adopt(new Browser(app, env), far.cookie), (c) => inviteMember(c, { email: 'theirs@example.com', role: 'member' }));

    const seen = await must(env, as.admin, (c) => listInvites(c));
    expect(seen.map((i) => [i.id, i.email, i.role, i.status, i.invitedBy.name])).toEqual([
      [fresh.id, NEW, 'member', 'pending', 'Adam'],
      [old.id, 'old@example.com', 'viewer', 'expired', 'Olive'],
    ]);
    expect(seen[0]?.link).toBe(fresh.link);
    expect(await codeOf(env, as.member, (c) => listInvites(c))).toBe('auth.role_needed');
    expect(await codeOf(env, as.viewer, (c) => listInvites(c))).toBe('auth.role_needed');
  });
});

describe('sending an invite again', () => {
  it('emails it again with a fresh 7 days, even after it expired', async () => {
    const sent = await invite('member');
    await expire(sent.id);
    const again = await must(env, as.admin, (c) => resendInvite(c, sent.id));
    expect(again).toMatchObject({ id: sent.id, status: 'pending', link: sent.link, invitedBy: { id: people.admin.user.id, name: 'Adam' } });
    expect(again.expiresAt).toBeGreaterThan(Date.now() + INVITE_TTL_MS - 60_000);
    expect((await mails(NEW, 'invite')).length).toBe(2);
    expect(await audits('invite.resent')).toBe(1);
    expect((await new Browser(app, env).get(pathOf(sent.link))).status).toBe(200);
  });

  it('follows the same rules as inviting', async () => {
    const boss = await invite('owner');
    const plain = await invite('member', 'second@example.com');
    expect(await codeOf(env, as.admin, (c) => resendInvite(c, boss.id))).toBe('auth.role_over_owner');
    expect(await codeOf(env, as.member, (c) => resendInvite(c, plain.id))).toBe('auth.role_needed');
    expect(await codeOf(env, as.owner, (c) => resendInvite(c, 'inv_nope'))).toBe('auth.invite_not_found');
    const far = adopt(new Browser(app, env), (await createTestSession(env, { email: 'far@example.com', orgId: 'org_other' })).cookie);
    expect(await codeOf(env, far, (c) => resendInvite(c, plain.id))).toBe('auth.invite_not_found');
    expect(await codeOf(env, far, (c) => cancelInvite(c, plain.id))).toBe('auth.invite_not_found');
    expect((await mails('second@example.com', 'invite')).length).toBe(1);
    expect(await statusOf(plain.id)).toBe('pending');
  });
});

describe('cancelling an invite', () => {
  it('stops its link at once', async () => {
    const sent = await invite('member');
    const { browser } = await outsider();
    await must(env, as.admin, (c) => cancelInvite(c, sent.id));
    expect(await statusOf(sent.id)).toBe('canceled');
    expect((await browser.get(pathOf(sent.link))).status).toBe(404);
    expect(await codeOf(env, browser, (c) => acceptInvite(c, sent.id))).toBe('auth.invite_not_found');
    expect(await codeOf(env, as.admin, (c) => cancelInvite(c, sent.id))).toBe('auth.invite_not_found');
    expect(await codeOf(env, as.admin, (c) => resendInvite(c, sent.id))).toBe('auth.invite_not_found');
    expect(await audits('invite.cancelled')).toBe(1);
  });

  it('is for admins and owners, and an owner invite is the owners’ to cancel', async () => {
    const boss = await invite('owner');
    expect(await codeOf(env, as.member, (c) => cancelInvite(c, boss.id))).toBe('auth.role_needed');
    expect(await codeOf(env, as.admin, (c) => cancelInvite(c, boss.id))).toBe('auth.role_over_owner');
    expect(await statusOf(boss.id)).toBe('pending');
    await must(env, as.owner, (c) => cancelInvite(c, boss.id));
    expect(await statusOf(boss.id)).toBe('canceled');
  });
});

describe('accepting an invite', () => {
  it('adds the invited person with the invited role and opens the workspace', async () => {
    const sent = await invite('admin');
    const { session, browser } = await outsider();
    const joined = await must(env, browser, (c) => acceptInvite(c, sent.id));
    expect(joined).toMatchObject({ id: ORG, name: 'Test Workspace', slug: 'test', role: 'admin' });
    expect(await roleOf(NEW)).toBe('admin');
    expect(await statusOf(sent.id)).toBe('accepted');
    expect(await env.DB.prepare('SELECT "activeOrganizationId" AS org FROM "session" WHERE "id" = ?1').bind(session.sessionId).first<string>('org')).toBe(ORG);
    expect((await must(env, browser, (c) => listWorkspaces(c))).map((w) => w.id).sort()).toEqual(['org_home', ORG].sort());
    expect((await must(env, browser, (c) => listMembers(c))).length).toBe(5);
    const meta = await env.DB.prepare(`SELECT meta FROM audit_log WHERE action = 'invite.accepted' AND org_id = ?1`).bind(ORG).first<string>('meta');
    expect(JSON.parse(meta!)).toEqual({ role: 'admin', invitedBy: people.owner.user.id });
  });

  it('works once', async () => {
    const sent = await invite('member');
    const { browser } = await outsider();
    await must(env, browser, (c) => acceptInvite(c, sent.id));
    expect(await codeOf(env, browser, (c) => acceptInvite(c, sent.id))).toBe('auth.invite_not_found');
    expect(await count('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1', ORG)).toBe(5);
    expect(await audits('invite.accepted')).toBe(1);
  });

  it('is only for the invited address', async () => {
    const sent = await invite('admin');
    const { browser } = await outsider('other@example.com');
    expect(await codeOf(env, browser, (c) => acceptInvite(c, sent.id))).toBe('auth.invite_wrong_account');
    // A member of the workspace cannot use someone else's invite to raise their own role.
    expect(await codeOf(env, as.member, (c) => acceptInvite(c, sent.id))).toBe('auth.invite_wrong_account');
    expect(await codeOf(env, new Browser(app, env), (c) => acceptInvite(c, sent.id))).toBe('unauthorized');
    expect(await roleOf('mel@example.com')).toBe('member');
    expect(await roleOf('other@example.com')).toBeNull();
    expect(await statusOf(sent.id)).toBe('pending');
  });

  it('refuses an expired invite, a missing one and a mangled id', async () => {
    const sent = await invite('member');
    const { browser } = await outsider();
    expect(await codeOf(env, browser, (c) => acceptInvite(c, sent.id, Date.now() + INVITE_TTL_MS + 1))).toBe('auth.invite_expired');
    await expire(sent.id);
    expect(await codeOf(env, browser, (c) => acceptInvite(c, sent.id))).toBe('auth.invite_expired');
    expect(await codeOf(env, browser, (c) => acceptInvite(c, 'inv_aaaaaaaaaaaaaaaaaaaaaaaa'))).toBe('auth.invite_not_found');
    expect(await codeOf(env, browser, (c) => acceptInvite(c, `${sent.id}' OR 1=1 --`))).toBe('auth.invite_not_found');
    expect(await roleOf(NEW)).toBeNull();
  });

  it('dies with its sender’s right to invite', async () => {
    const { browser } = await outsider();
    // Straight in the database, so the tidy-up that cancels invites on a role change has not run.
    const byAdmin = await invite('member', NEW, 'admin');
    await env.DB.prepare(`UPDATE "member" SET "role" = 'member' WHERE "userId" = ?1`).bind(people.admin.user.id).run();
    expect(await codeOf(env, browser, (c) => acceptInvite(c, byAdmin.id))).toBe('auth.invite_not_found');
    expect((await browser.get('/welcome')).status).toBe(302);

    await env.DB.prepare(`UPDATE "member" SET "role" = 'owner' WHERE "userId" = ?1`).bind(people.admin.user.id).run();
    const asOwner = await invite('owner', NEW, 'admin');
    await env.DB.prepare(`UPDATE "member" SET "role" = 'admin' WHERE "userId" = ?1`).bind(people.admin.user.id).run();
    expect(await codeOf(env, browser, (c) => acceptInvite(c, asOwner.id))).toBe('auth.invite_not_found');

    await env.DB.prepare(`DELETE FROM "member" WHERE "userId" = ?1`).bind(people.admin.user.id).run();
    expect(await codeOf(env, browser, (c) => acceptInvite(c, asOwner.id))).toBe('auth.invite_not_found');
    expect(await roleOf(NEW)).toBeNull();
  });

  it('is not done from a "signed in as" session', async () => {
    const sent = await invite('member');
    const { session, browser } = await outsider();
    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind(people.owner.user.id, session.sessionId).run();
    expect(await codeOf(env, browser, (c) => acceptInvite(c, sent.id))).toBe('auth.impersonating');
  });
});

describe('the invite page', () => {
  it('takes a new person from the link to the workspace, through a code to their inbox', async () => {
    const sent = await invite('member');
    const path = pathOf(sent.link);
    const guest = new Browser(app, env);

    // Opening the link changes nothing, however often a mail scanner does it.
    for (let i = 0; i < 3; i += 1) {
      const open = await guest.get(path);
      expect(open.status).toBe(200);
      expect(open.headers.get('referrer-policy')).toBe('same-origin');
      const html = await open.text();
      expect(html).toContain('Join Test Workspace');
      expect(html).toContain('Olive');
      expect(html).toContain(NEW);
    }
    expect(await statusOf(sent.id)).toBe('pending');
    expect(await users(NEW)).toBe(0);
    expect(await guest.signedIn()).toBe(false);
    expect(await mails(NEW, 'sign-in-code')).toEqual([]);

    const start = await guest.post(`${path}/start`);
    expect([start.status, start.headers.get('location')]).toEqual([303, '/sign-in/code']);
    expect(await users(NEW)).toBe(0);

    const entered = await guest.post('/sign-in/code', { code: await codeFor(NEW) });
    expect([entered.status, entered.headers.get('location')]).toEqual([303, path]);
    expect(await users(NEW)).toBe(1);
    expect(await audits('user.created')).toBe(1);
    // An ordinary account, never the owner of the install.
    expect(await env.DB.prepare('SELECT "role" FROM "user" WHERE "email" = ?1').bind(NEW).first<string>('role')).toBe('user');
    // Signed in, but still not a member until they press Join.
    expect(await roleOf(NEW)).toBeNull();

    const join = await guest.get(path);
    expect(join.status).toBe(200);
    expect(await join.text()).toContain('name="name"');

    const bad = await guest.post(path, { name: '<script>' });
    expect(bad.status).toBe(422);
    expect(await roleOf(NEW)).toBeNull();

    const done = await guest.post(path, { name: 'Nia New' });
    expect([done.status, done.headers.get('location')]).toEqual([303, '/app']);
    expect(await roleOf(NEW)).toBe('member');
    expect(await statusOf(sent.id)).toBe('accepted');
    expect(await env.DB.prepare('SELECT "name" FROM "user" WHERE "email" = ?1').bind(NEW).first<string>('name')).toBe('Nia New');
    expect((await must(env, guest, (c) => listWorkspaces(c))).map((w) => w.id)).toEqual([ORG]);

    // The same person opening the used link again lands in the app; anyone else sees it is gone.
    expect((await guest.get(path)).headers.get('location')).toBe('/app');
    expect((await new Browser(app, env).get(path)).status).toBe(404);
    expect((await as.member.get(path)).status).toBe(404);
  });

  it('makes no account when the invite was cancelled before the code was entered', async () => {
    const sent = await invite('member');
    const guest = new Browser(app, env);
    await guest.post(`${pathOf(sent.link)}/start`);
    const code = await codeFor(NEW);
    await must(env, as.owner, (c) => cancelInvite(c, sent.id));
    const entered = await guest.post('/sign-in/code', { code });
    expect(entered.status).toBe(400);
    expect(await users(NEW)).toBe(0);
    expect(await guest.signedIn()).toBe(false);
  });

  it('answers a sign-in try the same way for an invited address and an unknown one', async () => {
    await invite('member');
    const invited = await new Browser(app, env, '198.51.100.31').post('/sign-in', { email: NEW, intent: 'code' });
    const unknown = await new Browser(app, env, '198.51.100.32').post('/sign-in', { email: 'nobody@example.com', intent: 'code' });
    expect([invited.status, invited.headers.get('location')]).toEqual([unknown.status, unknown.headers.get('location')]);
    expect((await mails(NEW, 'sign-in-code')).length).toBe(1);
    expect(await mails('nobody@example.com', 'sign-in-code')).toEqual([]);
    expect(await users(NEW)).toBe(0);
  });

  it('lets an existing account join without asking for a name', async () => {
    const sent = await invite('viewer');
    const { browser } = await outsider();
    const open = await browser.get(pathOf(sent.link));
    expect(open.status).toBe(200);
    expect(await open.text()).not.toContain('name="name"');
    const done = await browser.post(pathOf(sent.link));
    expect(done.headers.get('location')).toBe('/app');
    expect(await roleOf(NEW)).toBe('viewer');
    expect(await env.DB.prepare('SELECT "name" FROM "user" WHERE "email" = ?1').bind(NEW).first<string>('name')).toBe('Nia New');
  });

  it('tells a person signed in as someone else, and signs them out before starting', async () => {
    const sent = await invite('admin');
    const path = pathOf(sent.link);
    const open = await as.member.get(path);
    expect(open.status).toBe(200);
    const html = await open.text();
    expect(html).toContain('This invite is for a different email');
    expect(html).toContain('mel@example.com');

    // Pressing Join anyway gets nowhere.
    expect((await as.member.post(path)).headers.get('location')).toBe(path);
    expect(await roleOf('mel@example.com')).toBe('member');
    expect(await statusOf(sent.id)).toBe('pending');

    const start = await as.member.post(`${path}/start`);
    expect(start.headers.get('location')).toBe('/sign-in/code');
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', people.member.sessionId)).toBe(0);
    expect((await mails(NEW, 'sign-in-code')).length).toBe(1);
    expect(await mails('mel@example.com', 'sign-in-code')).toEqual([]);
  });

  it('shows a plain page for an expired invite', async () => {
    const sent = await invite('member');
    await expire(sent.id);
    const guest = new Browser(app, env);
    for (const res of [await guest.get(pathOf(sent.link)), await guest.post(`${pathOf(sent.link)}/start`), await guest.post(pathOf(sent.link))]) {
      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain('This invite has expired');
      expect(html).toContain('TS-AUTH-410');
      // It says who to ask, and nothing about the workspace.
      expect(html).toContain('Olive');
      expect(html).not.toContain('Test Workspace');
    }
    expect(await mails(NEW, 'sign-in-code')).toEqual([]);
  });

  it('shows the same page for an unknown, mangled or cancelled invite', async () => {
    const sent = await invite('member');
    await must(env, as.owner, (c) => cancelInvite(c, sent.id));
    const guest = new Browser(app, env);
    const pages: string[] = [];
    for (const path of [pathOf(sent.link), '/invite/inv_aaaaaaaaaaaaaaaaaaaaaaaa', '/invite/abc', '/invite/%27%20OR%201=1']) {
      const res = await guest.get(path);
      expect(res.status).toBe(404);
      pages.push((await res.text()).replace(/nonce-[A-Za-z0-9+/=_-]+|nonce="[^"]+"/g, ''));
      expect((await guest.post(`${path}/start`)).status).toBe(404);
    }
    expect(pages[0]).toContain('TS-AUTH-404');
    expect(pages[0]).not.toContain('Test Workspace');
    expect(new Set(pages).size).toBe(1);
    expect(await mails(NEW, 'sign-in-code')).toEqual([]);
  });

  it('refuses a form sent from another site', async () => {
    const sent = await invite('member');
    const { browser } = await outsider();
    const evil = { origin: 'https://evil.example' };
    expect((await browser.post(pathOf(sent.link), {}, evil)).status).toBe(403);
    expect((await browser.post(`${pathOf(sent.link)}/start`, {}, evil)).status).toBe(403);
    expect((await browser.post('/welcome', { name: 'Sneaky' }, evil)).status).toBe(403);
    expect(await roleOf(NEW)).toBeNull();
    expect(await statusOf(sent.id)).toBe('pending');
  });
});

describe('the page for someone in no workspace', () => {
  async function loner(email = NEW): Promise<Browser> {
    const session = await createTestSession(env, { email, name: 'Nia New', orgId: 'org_gone' });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM "member" WHERE "userId" = ?1').bind(session.user.id),
      env.DB.prepare('UPDATE "session" SET "activeOrganizationId" = NULL WHERE "userId" = ?1').bind(session.user.id),
    ]);
    return adopt(new Browser(app, env), session.cookie);
  }

  it('sends signed-out people to sign in and members to the app', async () => {
    expect((await new Browser(app, env).get('/welcome')).headers.get('location')).toBe('/sign-in?next=/welcome');
    expect((await as.viewer.get('/welcome')).headers.get('location')).toBe('/app');
    expect((await new Browser(app, env).post('/welcome', { name: 'X' })).headers.get('location')).toBe('/sign-in?next=/welcome');
  });

  it('lists the invites waiting for the person, and no way to make a workspace', async () => {
    const sent = await invite('member');
    const browser = await loner();
    expect((await browser.get('/app')).headers.get('location')).toBe('/welcome');
    const res = await browser.get('/welcome');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('not in a workspace yet');
    expect(html).toContain(`href="${pathOf(sent.link)}"`);
    expect(html).toContain('Test Workspace');
    expect(html).not.toContain('name="name"');
    // A forged post does not get round the missing form.
    expect((await browser.post('/welcome', { name: 'Mine' })).status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM "organization"')).toBe(2);
  });

  it('lets them make a workspace when the owner of the install allows it', async () => {
    await setSetting(env, INSTANCE, MEMBERS_CAN_CREATE_KEY, true);
    const browser = await loner();
    expect(await (await browser.get('/welcome')).text()).toContain('name="name"');
    const empty = await browser.post('/welcome', { name: '   ' });
    expect(empty.status).toBe(422);
    const made = await browser.post('/welcome', { name: 'Side Project' });
    expect([made.status, made.headers.get('location')]).toEqual([303, '/app']);
    expect((await must(env, browser, (c) => listWorkspaces(c))).map((w) => [w.name, w.role])).toEqual([['Side Project', 'owner']]);
    expect((await browser.get('/welcome')).headers.get('location')).toBe('/app');
  });

  it('opens a workspace the person is in when their browser points at none', async () => {
    const stray = await createTestSession(env, { email: 'mel@example.com', role: 'member' });
    await env.DB.prepare('UPDATE "session" SET "activeOrganizationId" = NULL WHERE "id" = ?1').bind(stray.sessionId).run();
    const browser = adopt(new Browser(app, env), stray.cookie);
    expect((await browser.get('/welcome')).headers.get('location')).toBe('/app');
    expect(await env.DB.prepare('SELECT "activeOrganizationId" AS org FROM "session" WHERE "id" = ?1').bind(stray.sessionId).first<string>('org')).toBe(ORG);
  });
});
