import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import screen from '../../src/dashboard/members';
import type { Role } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import type { TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';

const ORG = 'org_test';
const ORG_B = 'org_other';

let t: TestEnv;
let app: ReturnType<typeof createApp>;
let me: Record<Role, TestSession>;

beforeEach(async () => {
  t = createTestEnv();
  app = createApp({ screens: { members: screen } });
  me = {
    owner: await createTestSession(t.env, { role: 'owner', email: 'olive@example.com', name: 'Olive Owner' }),
    admin: await createTestSession(t.env, { role: 'admin', email: 'adam@example.com', name: 'Adam Admin' }),
    member: await createTestSession(t.env, { role: 'member', email: 'mel@example.com', name: 'Mel Member' }),
    viewer: await createTestSession(t.env, { role: 'viewer', email: 'vic@example.com', name: 'Vic Viewer' }),
  };
});

const get = async (path: string, who: TestSession | null = me.owner) => {
  const res = await app.request(path, { headers: who?.headers ?? {} }, t.env);
  return { res, html: await res.text() };
};

const post = (path: string, form: Record<string, string>, who: TestSession = me.owner) =>
  app.request(path, { method: 'POST', headers: { ...who.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }, t.env);

/** The flash message a redirect left behind, as the next page shows it. */
async function flashOf(res: Response, who: TestSession = me.owner): Promise<string> {
  const cookie = /ts_flash=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  expect(cookie, 'a flash message was set').toBeTruthy();
  const next = await app.request(res.headers.get('location') ?? '/app/members', { headers: { ...who.headers, cookie: `${who.headers.cookie}; ts_flash=${cookie}` } }, t.env);
  await next.text();
  let raw = cookie!;
  for (let i = 0; i < 3 && !raw.startsWith('{'); i++) raw = decodeURIComponent(raw);
  return (JSON.parse(raw) as { message: string }).message;
}

const roleOf = (userId: string, org = ORG) => t.env.DB.prepare('SELECT "role" FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2').bind(org, userId).first<string>('role');
const count = async (sql: string, ...binds: unknown[]) => Number(await t.env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);

describe('who can open the screen', () => {
  it('sends a signed-out browser to sign-in', async () => {
    const { res } = await get('/app/members', null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fapp%2Fmembers');
  });

  it.each(['owner', 'admin'] as const)('shows a workspace %s the people, the invite form and the invites tab', async (role) => {
    const { res, html } = await get('/app/members', me[role]);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Olive Owner');
    expect(html).toContain('Send invite');
    expect(html).toContain('Invites');
    expect(html).toContain('Two-step');
  });

  it.each(['member', 'viewer'] as const)('shows a %s the people read-only, with a note and no way to change anyone', async (role) => {
    const { res, html } = await get('/app/members', me[role]);
    expect(res.status).toBe(200);
    expect(html).toContain('Adam Admin');
    expect(html).toContain('You can look but not change');
    expect(html).not.toContain('Send invite');
    expect(html).not.toContain('/role"');
    expect(html).not.toContain('/remove"');
    expect(html).not.toContain('Two-step');
    // Leaving is still theirs to do.
    expect(html).toContain('Leave this workspace?');
  });

  it('refuses every change from a member or a viewer', async () => {
    for (const who of [me.member, me.viewer]) {
      const role = await post(`/app/members/${me.admin.user.id}/role`, { role: 'viewer' }, who);
      expect(await flashOf(role, who)).toContain('doesn’t allow that');
      const remove = await post(`/app/members/${me.admin.user.id}/remove`, {}, who);
      expect(await flashOf(remove, who)).toContain('doesn’t allow that');
      const invite = await post('/app/members/invite', { email: 'x@example.com', role: 'viewer' }, who);
      expect(invite.status).toBe(403);
    }
    expect(await roleOf(me.admin.user.id)).toBe('admin');
  });
});

describe('the people list', () => {
  it('marks you, and offers no role change or removal on your own row', async () => {
    const { html } = await get('/app/members', me.admin);
    expect(html).toContain('(you)');
    expect(html).not.toContain(`/app/members/${me.admin.user.id}/role`);
    expect(html).toContain('/app/members/leave');
  });

  it('gives an admin no way to change an owner, and an owner every way', async () => {
    const asAdmin = (await get('/app/members', me.admin)).html;
    expect(asAdmin).not.toContain(`/app/members/${me.owner.user.id}/role`);
    expect(asAdmin).toContain(`/app/members/${me.member.user.id}/role`);
    expect((asAdmin.match(/<option value="owner"/g) ?? []).length).toBe(1); // only the role filter offers it
    const asOwner = (await get('/app/members', me.owner)).html;
    expect(asOwner).toContain(`/app/members/${me.admin.user.id}/role`);
    expect(asOwner).toMatch(/<option value="owner"/);
  });

  it('searches by name or email and filters by role, and says when nothing matches', async () => {
    const byName = (await get('/app/members?q=mel')).html;
    expect(byName).toContain('Mel Member');
    expect(byName).not.toContain('Vic Viewer');
    expect((await get('/app/members?q=VIC@example')).html).toContain('Vic Viewer');
    const byRole = (await get('/app/members?role=admin')).html;
    expect(byRole).toContain('Adam Admin');
    expect(byRole).not.toContain('Mel Member');
    const none = (await get('/app/members?q=nobody-here')).html;
    expect(none).toContain('No one matches');
    expect(none).toContain('Clear filters');
    expect((await get('/app/members?role=bogus')).res.status).toBe(200);
  });

  it('pages with a cursor, 50 at a time, and keeps the filters in the links', async () => {
    for (let i = 0; i < 60; i++) await createTestSession(t.env, { role: 'member', email: `p${String(i).padStart(2, '0')}@staff.example.com`, name: `Pat ${i}` });
    const first = (await get('/app/members?q=staff.example.com')).html;
    expect((first.match(/aria-label="Role for Pat/g) ?? []).length).toBe(50);
    const next = /<a [^>]*rel="next"[^>]*href="([^"]+)"/.exec(first)?.[1];
    expect(next).toBeTruthy();
    expect(next).toContain('q=staff.example.com');
    const second = (await get(next!.replaceAll('&amp;', '&'))).html;
    expect((second.match(/aria-label="Role for Pat/g) ?? []).length).toBe(10);
    expect(second).toContain('Back to first page');
    expect(second).not.toContain('rel="next"');
  });

  it('never shows another workspace’s people', async () => {
    await createTestSession(t.env, { role: 'owner', orgId: ORG_B, email: 'zed@other.example.com', name: 'Zed Elsewhere' });
    expect((await get('/app/members')).html).not.toContain('Zed Elsewhere');
  });

  it('escapes markup and holds up with very long names and other scripts', async () => {
    const long = 'Wolfeschlegelstein'.repeat(18);
    const loud = await createTestSession(t.env, { role: 'member', email: 'x@example.com', name: '<script>alert(1)</script>' });
    const wide = await createTestSession(t.env, { role: 'member', email: `${'a'.repeat(60)}@${'b'.repeat(60)}.example.com`, name: long });
    const other = await createTestSession(t.env, { role: 'viewer', email: 'kana@example.com', name: '山田 太郎 👩‍💻' });
    const { res, html } = await get('/app/members');
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain(long);
    expect(html).toContain('山田 太郎');
    expect([loud, wide, other].length).toBe(3);
  });
});

describe('changing a role', () => {
  it('saves it, says so and writes an audit entry', async () => {
    const res = await post(`/app/members/${me.member.user.id}/role`, { role: 'viewer' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/members');
    expect(await flashOf(res)).toBe('Mel Member is now Viewer.');
    expect(await roleOf(me.member.user.id)).toBe('viewer');
    expect(await audits('member.role_changed')).toBe(1);
  });

  it('says nothing changed when the role is the same', async () => {
    const res = await post(`/app/members/${me.member.user.id}/role`, { role: 'member' });
    expect(await flashOf(res)).toContain('nothing changed');
    expect(await audits('member.role_changed')).toBe(0);
  });

  it.each([
    ['an admin making an owner', me_ => me_.admin, 'member', 'owner', 'Only an owner can add, change or remove an owner.'],
    ['an admin changing an owner', me_ => me_.admin, 'owner', 'viewer', 'Only an owner can add, change or remove an owner.'],
    ['someone changing their own role', me_ => me_.owner, 'owner', 'admin', 'You can’t change your own role. Ask another owner.'],
    ['an unknown role', me_ => me_.owner, 'member', 'emperor', 'Pick one of these roles: owner, admin, member or viewer.'],
  ] as [string, (m: Record<Role, TestSession>) => TestSession, Role, string, string][])('shows a message when %s', async (_name, who, target, role, message) => {
    const by = who(me);
    const res = await post(`/app/members/${me[target].user.id}/role`, { role }, by);
    expect(res.status).toBe(303);
    expect(await flashOf(res, by)).toBe(message);
  });

  it('refuses to demote the last owner', async () => {
    const second = await createTestSession(t.env, { role: 'owner', email: 'second@example.com', name: 'Second Owner' });
    expect(await flashOf(await post(`/app/members/${me.owner.user.id}/role`, { role: 'admin' }, second), second)).toBe('Olive Owner is now Admin.');
    // Now `second` is the only owner and cannot change themselves; the last-owner rule also guards the service.
    expect(await roleOf(second.user.id)).toBe('owner');
  });

  it('cannot reach a person in another workspace by id', async () => {
    const stranger = await createTestSession(t.env, { role: 'member', orgId: ORG_B, email: 'stranger@example.com', name: 'Stranger' });
    const res = await post(`/app/members/${stranger.user.id}/role`, { role: 'admin' });
    expect(await flashOf(res)).toBe('That person isn’t in this workspace.');
    expect(await roleOf(stranger.user.id, ORG_B)).toBe('member');
  });
});

describe('removing and leaving', () => {
  it('refuses a removal or an invite resend while the owner is signed in as an admin', async () => {
    const install = await createTestSession(t.env, { instanceOwner: true, orgId: 'org_owner_home', email: 'install-owner@example.com' });
    await t.env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "userId" = ?2').bind(install.user.id, me.admin.user.id).run();
    const remove = await post(`/app/members/${me.viewer.user.id}/remove`, {}, me.admin);
    expect(await flashOf(remove, me.admin)).toBe('Stop signing in as someone else before you do that.');
    expect(await roleOf(me.viewer.user.id)).toBe('viewer');
    const resend = await post('/app/members/invites/inv_any/resend', {}, me.admin);
    expect(await flashOf(resend, me.admin)).toBe('Stop signing in as someone else before you do that.');
  });

  it('removes a person, keeps their account and writes an audit entry', async () => {
    const res = await post(`/app/members/${me.viewer.user.id}/remove`, {});
    expect(await flashOf(res)).toBe('Vic Viewer was removed and signed out of this workspace.');
    expect(await roleOf(me.viewer.user.id)).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', me.viewer.user.id)).toBe(1);
    expect(await audits('member.removed')).toBe(1);
    expect((await get('/app/members')).html).not.toContain('Vic Viewer');
  });

  it('refuses an admin who tries to remove an owner, and a removal of yourself', async () => {
    expect(await flashOf(await post(`/app/members/${me.owner.user.id}/remove`, {}, me.admin), me.admin)).toBe('Only an owner can add, change or remove an owner.');
    expect(await flashOf(await post(`/app/members/${me.admin.user.id}/remove`, {}, me.admin), me.admin)).toBe('You can’t do that to your own account here.');
    expect(await roleOf(me.owner.user.id)).toBe('owner');
  });

  it('lets someone leave, and sends them to the dashboard', async () => {
    const res = await post('/app/members/leave', {}, me.member);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app');
    expect(await roleOf(me.member.user.id)).toBeNull();
    expect(await audits('member.left')).toBe(1);
  });

  it('keeps the last owner in the workspace and says why', async () => {
    const res = await post('/app/members/leave', {}, me.owner);
    expect(res.headers.get('location')).toBe('/app');
    expect(await flashOf(res)).toBe('A workspace needs at least one owner. Make someone else an owner first.');
    expect(await roleOf(me.owner.user.id)).toBe('owner');
  });
});

describe('inviting', () => {
  it('makes the invite, lists it and says the email is not set up', async () => {
    const res = await post('/app/members/invite', { email: 'New.Person@Example.com', role: 'viewer' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/members?tab=invites');
    expect(await flashOf(res)).toContain('Invite sent to new.person@example.com.');
    expect(await audits('invite.sent')).toBe(1);
    const { html } = await get('/app/members?tab=invites');
    expect(html).toContain('new.person@example.com');
    expect(html).toContain('Works 7 more days');
    expect(html).toContain('/invite/');
    expect(html).toContain('Resend');
  });

  it('says in the form when email sending is not set up, and in dev points at the outbox', async () => {
    const dev = (await get('/app/members')).html;
    expect(dev).toContain('Dev mode');
    expect(dev).toContain('/dev/outbox');
    t.env.ENVIRONMENT = 'production';
    const off = await get('/app/members');
    expect(off.html).toContain('Email sending isn’t set up');
    const res = await post('/app/members/invite', { email: 'new@example.com', role: 'member' });
    expect(await flashOf(res)).toContain('email sending isn’t set up, so nothing was sent');
  });

  it('keeps what was typed and shows the error by the field', async () => {
    const res = await post('/app/members/invite', { email: 'not an email', role: 'admin' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('value="not an email"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(await audits('invite.sent')).toBe(0);
  });

  it('refuses someone who is already in, and an admin inviting an owner', async () => {
    const already = await post('/app/members/invite', { email: 'mel@example.com', role: 'member' });
    expect(already.status).toBe(409);
    expect(await already.text()).toContain('That person is already in this workspace.');
    const owner = await post('/app/members/invite', { email: 'boss@example.com', role: 'owner' }, me.admin);
    expect(owner.status).toBe(403);
    const html = await owner.text();
    expect(html).toContain('Only an owner can add, change or remove an owner.');
    expect(html).toContain('value="boss@example.com"');
  });

  it('resends and cancels, and writes audit entries', async () => {
    await post('/app/members/invite', { email: 'later@example.com', role: 'member' });
    const id = /\/app\/members\/invites\/([^/"]+)\/resend/.exec((await get('/app/members?tab=invites')).html)?.[1];
    expect(id).toBeTruthy();
    const again = await post(`/app/members/invites/${id}/resend`, {});
    expect(await flashOf(again)).toContain('Invite sent again to later@example.com.');
    expect(await audits('invite.resent')).toBe(1);
    const cancel = await post(`/app/members/invites/${id}/cancel`, {});
    expect(await flashOf(cancel)).toBe('Invite cancelled. Its link stops working now.');
    expect(await audits('invite.cancelled')).toBe(1);
    const { html } = await get('/app/members?tab=invites');
    expect(html).toContain('No invites waiting');
    // Cancelling it twice is a message, not an error page.
    expect(await flashOf(await post(`/app/members/invites/${id}/cancel`, {}))).toBe('That invite doesn’t work any more. Ask for a new one.');
  });

  it('never lets an invite of another workspace be reached by id', async () => {
    const other = await createTestSession(t.env, { role: 'owner', orgId: ORG_B, email: 'owner-b@example.com' });
    await post('/app/members/invite', { email: 'b-guest@example.com', role: 'member' }, other);
    const id = /\/app\/members\/invites\/([^/"]+)\/cancel/.exec((await get('/app/members?tab=invites', other)).html)?.[1];
    expect(id).toBeTruthy();
    expect((await get('/app/members?tab=invites')).html).not.toContain('b-guest@example.com');
    expect(await flashOf(await post(`/app/members/invites/${id}/cancel`, {}))).toBe('That invite doesn’t work any more. Ask for a new one.');
    expect(await count(`SELECT COUNT(*) AS n FROM "invitation" WHERE "status" = 'pending' AND "organizationId" = ?1`, ORG_B)).toBe(1);
  });

  it('shows an expired invite with a way to send it again, and hides owner invites from admins’ buttons', async () => {
    await post('/app/members/invite', { email: 'old@example.com', role: 'member' });
    await t.env.DB.prepare(`UPDATE "invitation" SET "expiresAt" = '2020-01-01T00:00:00.000Z'`).run();
    await post('/app/members/invite', { email: 'chief@example.com', role: 'owner' });
    const { html } = await get('/app/members?tab=invites');
    expect(html).toContain('Expired');
    expect(html).toContain('Send again');
    const asAdmin = (await get('/app/members?tab=invites', me.admin)).html;
    expect(asAdmin).toContain('Only an owner can manage this');
  });

  it('hides the invites tab from people who may not see invites', async () => {
    const { html } = await get('/app/members?tab=invites', me.member);
    expect(html).not.toContain('Pending invites');
    expect(html).toContain('People in this workspace');
  });
});
