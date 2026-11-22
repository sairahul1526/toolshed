import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import account from '../../src/dashboard/account';
import screen from '../../src/dashboard/users';
import { ImpersonationBanner } from '../../src/ui/layout';
import type { Env, Role } from '../../src/env';
import { adopt, Browser } from '../auth/browser';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';

const BASE = '/app/users';
const html = { accept: 'text/html' };

let env: Env;
let app: ReturnType<typeof createApp>;
let owner: TestSession;
let asOwner: Browser;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const body = (r: Response) => r.text();
const flashOf = (r: Response) => {
  let v = r.headers.getSetCookie().find((l) => l.startsWith('ts_flash='))?.split(';')[0]?.slice(9) ?? '';
  for (let i = 0; i < 2 && v.includes('%'); i++) v = decodeURIComponent(v);
  return v;
};

async function person(opts: { email: string; name?: string; role?: Role; orgId?: string }): Promise<TestSession> {
  return createTestSession(env, { role: opts.role ?? 'member', ...opts });
}

beforeEach(async () => {
  env = createTestEnv().env;
  app = createApp({ screens: { users: screen, account } });
  owner = await createTestSession(env, { email: 'olive@example.com', name: 'Olive Owner', role: 'owner', instanceOwner: true });
  asOwner = adopt(new Browser(app, env), owner.cookie);
});

describe('who can open it', () => {
  it('shows the list to the owner of the install', async () => {
    const res = await asOwner.get(BASE);
    expect(res.status).toBe(200);
    const text = await body(res);
    expect(text).toContain('Users');
    expect(text).toContain('olive@example.com');
    expect(text).toContain('You, owner');
  });

  it('shows everyone else the forbidden page, workspace owners included', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      const s = await person({ email: `${role}@example.com`, role });
      const res = await app.request(BASE, { headers: { ...s.headers, ...html } }, env);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Only the owner of this install can open that.');
    }
  });

  it('refuses every action from a workspace owner, and changes nothing', async () => {
    const boss = await person({ email: 'boss@example.com', role: 'owner' });
    const mel = await person({ email: 'mel@example.com' });
    const asBoss = adopt(new Browser(app, env), boss.cookie);
    const target = `${BASE}/${mel.user.id}`;
    for (const path of [`${target}/ban`, `${target}/unban`, `${target}/delete`, `${target}/sign-in-as`, `${BASE}/workspaces/org_test/rename`, `${BASE}/workspaces/org_test/delete`]) {
      expect((await asBoss.post(path, { confirm: 'mel@example.com', name: 'Mine', slug: 'mine' }, html)).status).toBe(403);
    }
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "banned" = 1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', mel.user.id)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM audit_log')).toBe(0);
  });

  it('sends a signed-out browser to sign-in', async () => {
    const res = await app.request(`${BASE}?q=x`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/sign-in?next=${encodeURIComponent(`${BASE}?q=x`)}`);
  });
});

describe('the list', () => {
  it('lists people with status and workspace counts, and escapes what they typed', async () => {
    const evil = await person({ email: 'evil@example.com', name: '<script>alert(1)</script>' });
    await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?1').bind(evil.user.id).run();
    const text = await body(await asOwner.get(BASE));
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text).toContain('Banned');
    expect(text).toContain('1 workspace');
  });

  it('searches by name or email and tells a search with no match from an empty list', async () => {
    await person({ email: 'priya@example.com', name: 'Priya Shah' });
    const hit = await body(await asOwner.get(`${BASE}?q=priya`));
    expect(hit).toContain('priya@example.com');
    expect(hit).not.toContain(`href="${BASE}/${owner.user.id}"`);
    const miss = await body(await asOwner.get(`${BASE}?q=nobody-by-that-name`));
    expect(miss).toContain('No one matches that');
    expect(miss).toContain('Clear search');
  });

  it('pages with a cursor and links back to the first page', async () => {
    for (let i = 0; i < 52; i++) {
      await env.DB.prepare(
        'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "banned") VALUES (?1, ?2, ?3, 1, ?4, ?4, \'user\', 0)',
      )
        .bind(`usr_p${String(i).padStart(3, '0')}`, `Person ${i}`, `p${i}@example.com`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString())
        .run();
    }
    const first = await body(await asOwner.get(BASE));
    const next = first.match(/href="([^"]*after=[^"]*)"/)?.[1]?.replaceAll('&amp;', '&');
    expect(next).toBeTruthy();
    const second = await body(await asOwner.get(next!));
    expect(second).toContain('Back to first page');
    expect(second).not.toContain('p51@example.com');
  });

  it('refuses a page marker that was made up', async () => {
    const res = await asOwner.get(`${BASE}?after=nonsense`, html);
    expect(res.status).toBe(400);
  });

  it('lists every workspace with its owners and member count, with its own empty-search state', async () => {
    await person({ email: 'second@example.com', role: 'owner', orgId: 'org_other' });
    const text = await body(await asOwner.get(`${BASE}?tab=workspaces`));
    expect(text).toContain('Test Workspace');
    expect(text).toContain('Workspace org_other');
    expect(text).toContain('olive@example.com');
    expect(await body(await asOwner.get(`${BASE}?tab=workspaces&q=zzzz`))).toContain('No workspace matches that');
  });

  it('holds up with 300-character names', async () => {
    const long = 'Ж'.repeat(300);
    await person({ email: `${'a'.repeat(60)}@example.com`, name: long });
    const res = await asOwner.get(BASE);
    expect(res.status).toBe(200);
    expect(await body(res)).toContain('…');
  });
});

describe('one person', () => {
  it('shows their details and the actions', async () => {
    const mel = await person({ email: 'mel@example.com', name: 'Mel' });
    const text = await body(await asOwner.get(`${BASE}/${mel.user.id}`));
    expect(text).toContain('mel@example.com');
    expect(text).toContain('Test Workspace');
    expect(text).toContain('Sign in as');
    expect(text).toContain('Delete account');
  });

  it('shows no actions for yourself or for another owner of the install', async () => {
    const text = await body(await asOwner.get(`${BASE}/${owner.user.id}`));
    expect(text).toContain('This is your account');
    expect(text).not.toContain('Delete account');
    const second = await createTestSession(env, { email: 'second-owner@example.com', role: 'owner', orgId: 'org_second', instanceOwner: true });
    expect(await body(await asOwner.get(`${BASE}/${second.user.id}`))).toContain('This account owns this Toolshed');
  });

  it('answers 404 for someone who does not exist', async () => {
    expect((await asOwner.get(`${BASE}/usr_nobody`, html)).status).toBe(404);
  });
});

describe('ban and unban', () => {
  it('bans with a reason and a length, signs them out, writes the audit line and shows it', async () => {
    const mel = await person({ email: 'mel@example.com', name: 'Mel' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/ban`, { reason: 'Posting spam', days: '7' });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('Mel is banned');
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?1', mel.user.id)).toBe(0);
    expect(await audits('user.banned')).toBe(1);
    const page = await body(await asOwner.get(`${BASE}/${mel.user.id}`));
    expect(page).toContain('Posting spam');
    expect(page).toContain('Lift ban');
    expect(await body(await asOwner.get(BASE))).toContain('Banned');
  });

  it('keeps what was typed and shows the error by the field when the reason is too long', async () => {
    const mel = await person({ email: 'mel@example.com' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/ban`, { reason: 'x'.repeat(201), days: '30' });
    expect(res.status).toBe(422);
    const text = await body(res);
    expect(text).toContain('Keep the reason under 200 characters.');
    expect(text).toContain('aria-invalid="true"');
    expect(await audits('user.banned')).toBe(0);
  });

  it('refuses a length that is not offered', async () => {
    const mel = await person({ email: 'mel@example.com' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/ban`, { days: '3' });
    expect(res.status).toBe(422);
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "banned" = 1')).toBe(0);
  });

  it('lifts a ban', async () => {
    const mel = await person({ email: 'mel@example.com' });
    await asOwner.post(`${BASE}/${mel.user.id}/ban`, { days: '' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/unban`);
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('The ban is lifted');
    expect(await audits('user.unbanned')).toBe(1);
    expect(await body(await asOwner.get(`${BASE}/${mel.user.id}`))).not.toContain('Lift ban');
  });

  it('says why when you try to ban yourself or the owner', async () => {
    const res = await asOwner.post(`${BASE}/${owner.user.id}/ban`, { days: '' });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('You can’t do that to your own account here.');
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "banned" = 1')).toBe(0);
  });
});

describe('delete a person', () => {
  it('needs their email typed out', async () => {
    const mel = await person({ email: 'mel@example.com', role: 'member' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/delete`, { confirm: 'mell@example.com' });
    expect(res.status).toBe(422);
    expect(await body(res)).toContain('Type mel@example.com to confirm.');
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', mel.user.id)).toBe(1);
  });

  it('deletes them, records it and goes back to the list', async () => {
    const mel = await person({ email: 'mel@example.com', role: 'member' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/delete`, { confirm: ' MEL@example.com ' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(BASE);
    expect(flashOf(res)).toContain('Deleted the account of mel@example.com');
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', mel.user.id)).toBe(0);
    expect(await audits('user.deleted')).toBe(1);
  });

  it('explains why the only owner of a workspace cannot be deleted', async () => {
    const adam = await person({ email: 'adam@example.com', role: 'owner', orgId: 'org_adam' });
    const res = await asOwner.post(`${BASE}/${adam.user.id}/delete`, { confirm: 'adam@example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/${adam.user.id}`);
    expect(flashOf(res)).toContain('only owner of a workspace');
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', adam.user.id)).toBe(1);
  });

  it('asks for a recent sign-in', async () => {
    const mel = await person({ email: 'mel@example.com' });
    await env.DB.prepare('UPDATE "session" SET "createdAt" = ?1 WHERE "id" = ?2').bind(new Date(Date.now() - 2 * 3600_000).toISOString(), owner.sessionId).run();
    const res = await asOwner.post(`${BASE}/${mel.user.id}/delete`, { confirm: 'mel@example.com' });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('Sign in again');
    expect(await count('SELECT COUNT(*) AS n FROM "user" WHERE "id" = ?1', mel.user.id)).toBe(1);
  });
});

describe('sign in as', () => {
  it('signs this browser in as them, blocks the owner screens, and stop goes back', async () => {
    const mel = await person({ email: 'mel@example.com', name: 'Mel Member' });
    const start = await asOwner.post(`${BASE}/${mel.user.id}/sign-in-as`);
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe('/app');
    expect(flashOf(start)).toContain('You’re signed in as Mel Member');
    expect(await audits('impersonation.started')).toBe(1);

    // The browser is now Mel's: the owner's screens are closed to it.
    expect((await asOwner.get(BASE, html)).status).toBe(403);
    // Every page in the shell shows the strip with Stop while this lasts.
    const during = await body(await asOwner.get('/app/account', html));
    expect(during).toContain('You’re signed in as <b>Mel Member</b>');
    expect(during).toContain('action="/app/users/impersonation/stop"');

    const stop = await asOwner.post(`${BASE}/impersonation/stop`);
    expect(stop.status).toBe(303);
    expect(stop.headers.get('location')).toBe(BASE);
    expect(await audits('impersonation.stopped')).toBe(1);
    expect((await asOwner.get(BASE)).status).toBe(200);
    expect(await body(await asOwner.get('/app/account', html))).not.toContain('impersonation/stop');
  });

  it('refuses to sign in as a banned account and says so', async () => {
    const mel = await person({ email: 'mel@example.com' });
    await asOwner.post(`${BASE}/${mel.user.id}/ban`, { days: '' });
    const res = await asOwner.post(`${BASE}/${mel.user.id}/sign-in-as`);
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('suspended');
    expect(await audits('impersonation.started')).toBe(0);
  });

  it('answers a stop with nothing to stop as an error message, not a crash', async () => {
    const res = await asOwner.post(`${BASE}/impersonation/stop`, {}, html);
    expect(res.status).toBe(409);
    expect(await body(res)).toContain('You aren’t signed in as someone else.');
  });

  it('draws the banner with a Stop button', () => {
    const view = String(
      ImpersonationBanner({ session: { name: '<b>Mel</b>', expiresAt: Date.UTC(2026, 10, 22, 10, 0) } }),
    );
    expect(view).toContain('/app/users/impersonation/stop');
    expect(view).toContain('Stop');
    expect(view).not.toContain('<b>Mel</b>');
  });
});

describe('workspaces', () => {
  it('opens a workspace page and answers 404 for one that is gone', async () => {
    expect(await body(await asOwner.get(`${BASE}/workspaces/org_test`))).toContain('Rename');
    expect((await asOwner.get(`${BASE}/workspaces/org_nowhere`, html)).status).toBe(404);
  });

  it('renames a workspace and its short name', async () => {
    const res = await asOwner.post(`${BASE}/workspaces/org_test/rename`, { name: 'Renamed Shed', slug: 'renamed-shed' });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('Renamed Shed');
    expect(await env.DB.prepare('SELECT "name", "slug" FROM "organization" WHERE "id" = ?1').bind('org_test').first()).toEqual({ name: 'Renamed Shed', slug: 'renamed-shed' });
    expect(await audits('workspace.renamed')).toBe(1);
  });

  it('shows errors by the field and keeps what was typed', async () => {
    const empty = await asOwner.post(`${BASE}/workspaces/org_test/rename`, { name: '  ', slug: 'test' });
    expect(empty.status).toBe(422);
    expect(await body(empty)).toContain('Enter a name for the workspace.');
    const bad = await asOwner.post(`${BASE}/workspaces/org_test/rename`, { name: 'Fine', slug: 'No Spaces!' });
    expect(bad.status).toBe(422);
    const text = await body(bad);
    expect(text).toContain('Use 1 to 40 letters, numbers and dashes.');
    expect(text).toContain('value="No Spaces!"');
  });

  it('says when the short name is taken', async () => {
    await person({ email: 'other@example.com', role: 'owner', orgId: 'org_other' });
    const res = await asOwner.post(`${BASE}/workspaces/org_test/rename`, { name: 'Test Workspace', slug: 'org-other' });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('That short name is taken');
  });

  it('deletes only when the short name is typed, then goes back to the list', async () => {
    await person({ email: 'other@example.com', role: 'owner', orgId: 'org_other' });
    const wrong = await asOwner.post(`${BASE}/workspaces/org_other/delete`, { confirm: 'nope' });
    expect(wrong.status).toBe(422);
    expect(await body(wrong)).toContain('Type org-other to confirm.');
    expect(await count('SELECT COUNT(*) AS n FROM "organization" WHERE "id" = ?1', 'org_other')).toBe(1);

    const ok = await asOwner.post(`${BASE}/workspaces/org_other/delete`, { confirm: 'ORG-OTHER' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`${BASE}?tab=workspaces`);
    expect(await count('SELECT COUNT(*) AS n FROM "organization" WHERE "id" = ?1', 'org_other')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "organization" WHERE "id" = ?1', 'org_test')).toBe(1);
    expect(await audits('workspace.deleted')).toBe(1);
  });

  it('escapes a workspace name with markup', async () => {
    await env.DB.prepare('UPDATE "organization" SET "name" = ?1 WHERE "id" = ?2').bind('<img src=x onerror=alert(1)>', 'org_test').run();
    for (const path of [`${BASE}?tab=workspaces`, `${BASE}/workspaces/org_test`]) {
      const text = await body(await asOwner.get(path));
      expect(text).not.toContain('<img src=x');
    }
  });
});
