import { describe, expect, it, vi } from 'vitest';
import { jsx } from 'hono/jsx';
import { createApp } from '../../src/app';
import { notify } from '../../src/core/notifications';
import type { ShellData, ShellNotifications } from '../../src/core/shell-data';
import notifications from '../../src/dashboard/notifications';
import overview from '../../src/dashboard/overview';
import { AppShell } from '../../src/ui';
import { createTestSession, countQueries, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';

const NOW = Date.now();

function shell(bell?: ShellNotifications): ShellData {
  return {
    user: { id: 'usr_1', email: 'ana@example.com', name: 'Ana', image: null, isInstanceOwner: false },
    org: { id: 'org_test', name: 'Test Workspace', slug: 'test', role: 'member' },
    modules: [],
    modulesOff: 0,
    appearance: {},
    ...(bell ? { notifications: bell } : {}),
  };
}

const render = (bell?: ShellNotifications, path = '/app/links') => String(jsx(AppShell, { shell: shell(bell), path, title: 'Links' }));
const bellOf = (html: string) => html.match(/<a class="icon-btn" href="\/app\/notifications"[^>]*>/)![0];
const menuOf = (html: string) => html.slice(html.indexOf('id="menu-notes"')).split('<dialog')[0]!;

const item = (n: number, over: Partial<ShellNotifications['latest'][number]> = {}) => ({ id: `ntf_${n}`, title: `Title ${n}`, at: NOW - n * 60_000, read: false, ...over });

describe('the bell', () => {
  it('is a plain link to the list and names the unread count', () => {
    const html = render({ unread: 3, latest: [item(1)], failed: false });
    expect(bellOf(html)).toContain('href="/app/notifications"');
    expect(bellOf(html)).toContain('aria-label="Notifications, 3 new"');
    expect(bellOf(html)).toContain('data-menu="notes"');
    expect(html).toContain('class="dot"');
  });

  it('has no dot and a plain name when everything is read', () => {
    const html = render({ unread: 0, latest: [item(1, { read: true })], failed: false });
    expect(bellOf(html)).toContain('aria-label="Notifications"');
    expect(html).not.toContain('class="dot"');
    expect(menuOf(html)).not.toContain('Mark all as read');
    expect(menuOf(html)).toContain('See all');
  });

  it('shows no count when the list could not be loaded', () => {
    const html = render({ unread: 0, latest: [], failed: true });
    expect(bellOf(html)).toContain('aria-label="Notifications"');
    expect(html).not.toContain('class="dot"');
    expect(menuOf(html)).toContain('could not be loaded');
    expect(menuOf(html)).not.toContain('Mark all as read');
  });

  it('renders without notification data at all (the /dev/ui preview)', () => {
    const html = render();
    expect(bellOf(html)).toContain('aria-label="Notifications"');
    expect(menuOf(html)).toContain('You are all caught up.');
  });

  it('lists title, short body, relative time and an unread marker', () => {
    const html = render({ unread: 1, latest: [item(5, { body: 'b'.repeat(200) }), item(7, { read: true })], failed: false });
    const menu = menuOf(html);
    expect(menu).toContain('href="/app/notifications/ntf_5/open"');
    expect(menu).toContain('Title 5');
    expect(menu).toContain('5 minutes ago');
    expect(menu).toContain('Unread: ');
    expect(menu).toContain(`${'b'.repeat(89)}…`);
    expect(menu).not.toContain('b'.repeat(90));
    expect(menu.match(/class="unread-dot off"/g)).toHaveLength(1);
    expect(menu).toContain('Mark all as read');
    expect(html).toContain('action="/app/notifications/read-all"');
  });

  it('brings the person back to the page they were on', () => {
    expect(render({ unread: 1, latest: [], failed: false }, '/app/members')).toContain('name="next" value="/app/members"');
  });

  it('escapes stored text', () => {
    const html = render({ unread: 1, latest: [item(1, { title: '<script>alert(1)</script>', body: '<img src=x onerror=1>' })], failed: false });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
  });
});

describe('the bell on a real page', () => {
  function setup() {
    const t = createTestEnv();
    const app = createApp({ screens: { overview, notifications } });
    const get = (s: TestSession, path: string) => app.request(path, { headers: s.headers }, t.env);
    const post = (s: TestSession, path: string) =>
      app.request(path, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: '' }, t.env);
    return { t, get, post };
  }

  it('shows the unread count and the latest five on /app', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    for (let i = 1; i <= 7; i++) await notify(t.env, { orgId: 'org_test', userId: s.user.id, title: `Note ${i}` });
    const html = await (await get(s, '/app')).text();
    expect(bellOf(html)).toContain('aria-label="Notifications, 7 new"');
    const menu = menuOf(html);
    expect(menu.match(/class="note"/g)).toHaveLength(5);
    expect(menu).toContain('Mark all as read');
    expect(menu).toContain('href="/app/notifications"');
  });

  it('drops the count after one is read and after mark all', async () => {
    const { t, get, post } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    for (let i = 1; i <= 3; i++) await notify(t.env, { orgId: 'org_test', userId: s.user.id, title: `Note ${i}` });
    const id = (await (await get(s, '/app')).text()).match(/\/app\/notifications\/(ntf_[\w-]+)\/open/)![1]!;

    await post(s, `/app/notifications/${id}/read`);
    expect(bellOf(await (await get(s, '/app')).text())).toContain('aria-label="Notifications, 2 new"');

    await post(s, '/app/notifications/read-all');
    const html = await (await get(s, '/app')).text();
    expect(bellOf(html)).toContain('aria-label="Notifications"');
    expect(html).not.toContain('class="dot"');
  });

  it('counts per person', async () => {
    const { t, get, post } = setup();
    const ana = await createTestSession(t.env, { role: 'admin', email: 'ana@example.com' });
    const ben = await createTestSession(t.env, { role: 'admin', email: 'ben@example.com' });
    await notify(t.env, { orgId: 'org_test', title: 'For every admin' });
    await post(ana, '/app/notifications/read-all');
    expect(bellOf(await (await get(ana, '/app')).text())).toContain('aria-label="Notifications"');
    expect(bellOf(await (await get(ben, '/app')).text())).toContain('aria-label="Notifications, 1 new"');
  });

  it('keeps role and workspace rules in the bell', async () => {
    const { t, get } = setup();
    const member = await createTestSession(t.env, { role: 'member' });
    const admin = await createTestSession(t.env, { role: 'admin' });
    await notify(t.env, { orgId: 'org_test', title: 'For every admin' });
    await notify(t.env, { orgId: 'org_other', title: 'Other workspace' });
    expect(menuOf(await (await get(member, '/app')).text())).not.toContain('For every admin');
    const adminMenu = menuOf(await (await get(admin, '/app')).text());
    expect(adminMenu).toContain('For every admin');
    expect(adminMenu).not.toContain('Other workspace');
  });

  it('adds one call to the shell, not one per notification', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    const before = (await countQueries(t.env, async () => get(s, '/app'))).queries.filter((q) => q.includes('FROM notifications')).length;
    for (let i = 0; i < 20; i++) await notify(t.env, { orgId: 'org_test', userId: s.user.id, title: `Note ${i}` });
    const after = (await countQueries(t.env, async () => get(s, '/app'))).queries.filter((q) => q.includes('FROM notifications')).length;
    expect(before).toBe(2);
    expect(after).toBe(before);
  });

  it('still renders the page when the notifications query fails', async () => {
    const { t, get } = setup();
    const s = await createTestSession(t.env, { role: 'member' });
    await notify(t.env, { orgId: 'org_test', userId: s.user.id, title: 'Note' });
    const db = t.env.DB as unknown as { prepare(sql: string): unknown };
    const original = db.prepare;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.prepare = function (sql: string) {
      if (sql.includes('FROM notifications')) throw new Error('D1 is down');
      return original.call(this, sql);
    };
    try {
      const res = await get(s, '/app');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(bellOf(html)).toContain('aria-label="Notifications"');
      expect(html).not.toContain('class="dot"');
      expect(menuOf(html)).toContain('could not be loaded');
      expect(html).toContain('Overview');
    } finally {
      db.prepare = original;
      log.mockRestore();
    }
  });
});
