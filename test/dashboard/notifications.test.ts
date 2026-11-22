import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { listNotifications, notify } from '../../src/core/notifications';
import notifications from '../../src/dashboard/notifications';
import overview from '../../src/dashboard/overview';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function setup() {
  const t = createTestEnv();
  const app = createApp({ screens: { overview, notifications } });
  const get = (s: TestSession, path: string) => app.request(path, { headers: s.headers }, t.env);
  const post = (s: TestSession, path: string, form: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...s.headers, ...FORM }, body: new URLSearchParams(form).toString() }, t.env);
  return { t, app, get, post };
}

/** Rows written straight to the table, for values `notify()` refuses (bad links) and for big lists. */
function insert(t: TestEnv, row: { id: string; org?: string; user?: string | null; kind?: string; title: string; body?: string | null; href?: string | null; at: number }) {
  t.sqlite
    .prepare('INSERT INTO notifications (id, org_id, user_id, kind, title, body, href, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.org ?? 'org_test', row.user ?? null, row.kind ?? 'info', row.title, row.body ?? null, row.href ?? null, row.at);
}

/** Just the list, without the bell menu the shell adds to every page. */
const listOf = (html: string) => (html.includes('class="rows note-list"') ? html.slice(html.indexOf('class="rows note-list"')).split('</ul>')[0]! : '');

const unreadOf = async (t: TestEnv, s: TestSession) =>
  (await listNotifications(t.env, { orgId: s.org.id, userId: s.user.id, isAdmin: s.org.role === 'owner' || s.org.role === 'admin' })).unread;

describe('who can open it', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const { t, app } = setup();
    const res = await app.request('/app/notifications', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fapp%2Fnotifications');
  });

  it.each(['owner', 'admin', 'member', 'viewer'] as const)('opens for a %s', async (role) => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role });
    const res = await get(s, '/app/notifications');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('You are all caught up');
  });
});

describe('what a person sees', () => {
  it('shows their own, their role and nobody else', async () => {
    const { t, get } = setup();
    const admin = await createTestSession(t.env, { role: 'admin', email: 'ana@example.com' });
    const member = await createTestSession(t.env, { role: 'member', email: 'ben@example.com' });
    const stranger = await createTestSession(t.env, { role: 'owner', orgId: 'org_other', email: 'sam@example.com' });
    await notify(t.env, { orgId: 'org_test', userId: admin.user.id, title: 'For Ana' });
    await notify(t.env, { orgId: 'org_test', userId: member.user.id, title: 'For Ben' });
    await notify(t.env, { orgId: 'org_test', title: 'For every admin' });
    await notify(t.env, { orgId: 'org_other', title: 'Other workspace secret' });

    const adminHtml = await (await get(admin, '/app/notifications')).text();
    expect(adminHtml).toContain('For Ana');
    expect(adminHtml).toContain('For every admin');
    expect(adminHtml).not.toContain('For Ben');
    expect(adminHtml).not.toContain('Other workspace secret');

    const memberHtml = await (await get(member, '/app/notifications')).text();
    expect(memberHtml).toContain('For Ben');
    expect(memberHtml).not.toContain('For Ana');
    expect(memberHtml).not.toContain('For every admin');

    const strangerHtml = await (await get(stranger, '/app/notifications')).text();
    expect(strangerHtml).toContain('Other workspace secret');
    expect(strangerHtml).not.toContain('For Ana');
    expect(strangerHtml).not.toContain('For every admin');
  });

  it('matches the core list for every role', async () => {
    const { t, get } = setup();
    const member = await createTestSession(t.env, { role: 'member' });
    const admin = await createTestSession(t.env, { role: 'admin' });
    for (let i = 0; i < 6; i++) {
      await notify(t.env, { orgId: 'org_test', userId: i % 2 ? member.user.id : admin.user.id, title: `Person ${i}` });
      await notify(t.env, { orgId: 'org_test', title: `Admins ${i}` });
    }
    for (const s of [member, admin]) {
      const html = await (await get(s, '/app/notifications')).text();
      const { items } = await listNotifications(t.env, { orgId: 'org_test', userId: s.user.id, isAdmin: s.org.role === 'admin', limit: 100 });
      const shown = [...listOf(html).matchAll(/\/app\/notifications\/(ntf_[\w-]+)\/read"/g)].map((m) => m[1]);
      expect(shown.sort()).toEqual(items.filter((i) => !i.read).map((i) => i.id).sort());
    }
  });

  it('puts the newest first and filters unread', async () => {
    const { t, get, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    insert(t, { id: 'ntf_1', user: s.user.id, title: 'Oldest', at: 1000 });
    insert(t, { id: 'ntf_2', user: s.user.id, title: 'Middle', at: 2000 });
    insert(t, { id: 'ntf_3', user: s.user.id, title: 'Newest', at: 3000 });
    await post(s, '/app/notifications/ntf_2/read');

    const all = await (await get(s, '/app/notifications')).text();
    expect(all.indexOf('Newest')).toBeLessThan(all.indexOf('Middle'));
    expect(all.indexOf('Middle')).toBeLessThan(all.indexOf('Oldest'));

    const page = await (await get(s, '/app/notifications?filter=unread')).text();
    const unread = listOf(page);
    expect(unread).toContain('Newest');
    expect(unread).toContain('Oldest');
    expect(unread).not.toContain('Middle');
    expect(page).toMatch(/Unread<span class="n">2<\/span>/);
  });

  it('says so when a filter has no results, apart from the empty state', async () => {
    const { t, get, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    insert(t, { id: 'ntf_1', user: s.user.id, title: 'Only one', at: 1000 });
    await post(s, '/app/notifications/read-all');
    const html = await (await get(s, '/app/notifications?filter=unread')).text();
    expect(html).toContain('Nothing unread');
    expect(listOf(html)).toBe('');
    expect(listOf(await (await get(s, '/app/notifications')).text())).toContain('Only one');
  });

  it('escapes stored text and survives worst-case values', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    const title = `<script>alert(1)</script>${'長い名前'.repeat(29)}`.slice(0, 120);
    await notify(t.env, { orgId: 'org_test', userId: s.user.id, title, body: `<img src=x onerror=alert(1)> ${'x'.repeat(440)} 🙂`, kind: '<b>kind</b>' });
    const res = await get(s, '/app/notifications');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('長い名前');
  });
});

describe('reading', () => {
  it('marks one read and keeps the person on the same page', async () => {
    const { t, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    insert(t, { id: 'ntf_a', user: s.user.id, title: 'A', at: 1000 });
    insert(t, { id: 'ntf_b', user: s.user.id, title: 'B', at: 2000 });
    expect(await unreadOf(t, s)).toBe(2);
    const res = await post(s, '/app/notifications/ntf_a/read', { next: '/app/notifications?filter=unread' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/notifications?filter=unread');
    expect(await unreadOf(t, s)).toBe(1);
  });

  it('marks everything read', async () => {
    const { t, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    insert(t, { id: 'ntf_a', user: s.user.id, title: 'A', at: 1000 });
    insert(t, { id: 'ntf_b', user: s.user.id, title: 'B', at: 2000 });
    const res = await post(s, '/app/notifications/read-all');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/notifications');
    expect(await unreadOf(t, s)).toBe(0);
  });

  it('keeps read marks per person', async () => {
    const { t, get, post } = setup();
    const ana = await createTestSession(t.env, { role: 'admin', email: 'ana@example.com' });
    const ben = await createTestSession(t.env, { role: 'admin', email: 'ben@example.com' });
    await notify(t.env, { orgId: 'org_test', title: 'Shared with admins' });
    const id = (await listNotifications(t.env, { orgId: 'org_test', userId: ana.user.id })).items[0]!.id;
    await post(ana, `/app/notifications/${id}/read`);
    expect(await unreadOf(t, ana)).toBe(0);
    expect(await unreadOf(t, ben)).toBe(1);
    expect(await (await get(ben, '/app/notifications?filter=unread')).text()).toContain('Shared with admins');
    await post(ben, '/app/notifications/read-all');
    expect(await unreadOf(t, ana)).toBe(0);
  });

  it('follows a same-site link after marking it read', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    await notify(t.env, { orgId: 'org_test', userId: s.user.id, title: 'Export ready', href: '/app/export?id=1' });
    const id = (await listNotifications(t.env, { orgId: 'org_test', userId: s.user.id })).items[0]!.id;
    const res = await get(s, `/app/notifications/${id}/open`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/export?id=1');
    expect(await unreadOf(t, s)).toBe(0);
  });

  it('goes back to the list when there is no link', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    await notify(t.env, { orgId: 'org_test', userId: s.user.id, title: 'No link' });
    const id = (await listNotifications(t.env, { orgId: 'org_test', userId: s.user.id })).items[0]!.id;
    const res = await get(s, `/app/notifications/${id}/open`);
    expect(res.headers.get('location')).toBe('/app/notifications');
    expect(await unreadOf(t, s)).toBe(0);
  });

  it('cannot mark or open another workspace or another person by id', async () => {
    const { t, get, post } = setup();
    const mine = await createTestSession(t.env, { role: 'member', email: 'me@example.com' });
    const other = await createTestSession(t.env, { role: 'owner', orgId: 'org_other', email: 'them@example.com' });
    const colleague = await createTestSession(t.env, { role: 'member', email: 'colleague@example.com' });
    insert(t, { id: 'ntf_theirs', org: 'org_other', title: 'Theirs', href: '/app/x', at: 1000 });
    insert(t, { id: 'ntf_colleague', user: colleague.user.id, title: 'Colleague', href: '/app/y', at: 1000 });

    expect((await post(mine, '/app/notifications/ntf_theirs/read')).status).toBe(404);
    expect((await get(mine, '/app/notifications/ntf_theirs/open')).status).toBe(404);
    expect((await post(mine, '/app/notifications/ntf_colleague/read')).status).toBe(404);
    expect((await get(mine, '/app/notifications/ntf_colleague/open')).status).toBe(404);
    expect((await post(mine, '/app/notifications/ntf_missing/read')).status).toBe(404);
    expect(await unreadOf(t, other)).toBe(1);
    expect(await unreadOf(t, colleague)).toBe(1);
  });

  it('blocks a cross-site post', async () => {
    const { t, app } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    const res = await app.request('/app/notifications/read-all', { method: 'POST', headers: { ...s.headers, ...FORM, origin: 'https://evil.example' } }, t.env);
    expect(res.status).toBe(403);
  });
});

describe('links that point off this site', () => {
  const BAD = ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', 'data:text/html,hi'];

  it.each(BAD)('does not render or follow %j', async (href) => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    insert(t, { id: 'ntf_bad', user: s.user.id, title: 'Sneaky', href, at: 1000 });

    const html = await (await get(s, '/app/notifications')).text();
    expect(html).toContain('Sneaky');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('javascript:');
    expect(listOf(html)).not.toContain('/open');

    const open = await get(s, '/app/notifications/ntf_bad/open');
    expect(open.status).toBe(303);
    expect(open.headers.get('location')).toBe('/app/notifications');
    expect(await unreadOf(t, s)).toBe(0);
  });

  it.each(BAD)('ignores a return address of %j', async (next) => {
    const { t, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    const res = await post(s, '/app/notifications/read-all', { next });
    expect(res.headers.get('location')).toBe('/app/notifications');
  });
});

describe('a long list', () => {
  it('pages through 500 without a repeat or a gap', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    for (let i = 0; i < 500; i++) {
      // Groups of ten share one timestamp, so the id has to break the ties.
      insert(t, { id: `ntf_${String(i).padStart(4, '0')}`, user: s.user.id, title: `Item ${i}`, at: 1_000_000 + Math.floor(i / 10) * 1000 });
    }
    const seen: string[] = [];
    let path: string | null = '/app/notifications';
    let pages = 0;
    while (path) {
      const html: string = await (await get(s, path)).text();
      seen.push(...[...listOf(html).matchAll(/<b>(?:<span class="sr-only">Unread: <\/span>)?(Item \d+)<\/b>/g)].map((m) => m[1]!));
      const next: RegExpMatchArray | null = html.match(/href="([^"]+)" rel="next"/);
      path = next ? next[1]!.replaceAll('&amp;', '&') : null;
      pages++;
    }
    expect(pages).toBe(20);
    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
    expect(seen[0]).toBe('Item 499');
    expect(seen[499]).toBe('Item 0');
  });

  it('keeps the unread filter while paging', async () => {
    const { t, get, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    for (let i = 0; i < 60; i++) insert(t, { id: `ntf_${String(i).padStart(3, '0')}`, user: s.user.id, title: `Item ${i}`, at: 1000 + i });
    for (let i = 0; i < 60; i += 2) await post(s, `/app/notifications/ntf_${String(i).padStart(3, '0')}/read`);
    const first = await (await get(s, '/app/notifications?filter=unread')).text();
    const next = first.match(/href="([^"]+)" rel="next"/)![1]!.replaceAll('&amp;', '&');
    expect(next).toContain('filter=unread');
    const second = listOf(await (await get(s, next)).text());
    expect(await (await get(s, next)).text()).toContain('Back to newest');
    expect(second).not.toMatch(/Item (\d*[02468])</);
  });

  it('treats a broken cursor as the start of the list', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    insert(t, { id: 'ntf_1', user: s.user.id, title: 'Present', at: 1000 });
    const res = await get(s, '/app/notifications?before=not-a-cursor');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Present');
  });
});
