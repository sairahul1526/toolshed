import { describe, expect, it } from 'vitest';
import { runSchedules } from '../../src/core/jobs';
import { cleanupNotifications, listNotifications, markAllRead, markRead, notify } from '../../src/core/notifications';
import notificationRoutes from '../../src/core/routes/notifications';
import { createTestEnv } from '../helpers/d1';
import { routeApp } from './helpers';

const ORG = 'org_test';
const OTHER = 'org_other';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('notify and list', () => {
  it('gives each person their own and shares admin ones', async () => {
    const t = createTestEnv();
    await notify(t.env, { orgId: ORG, userId: 'usr_a', title: 'For Ana', body: 'Only you', href: '/app/email' });
    await notify(t.env, { orgId: ORG, userId: 'usr_b', title: 'For Ben' });
    await notify(t.env, { orgId: ORG, title: 'For admins', kind: 'email' });
    await notify(t.env, { orgId: OTHER, title: 'Other workspace' });

    const ana = await listNotifications(t.env, { orgId: ORG, userId: 'usr_a' });
    expect(ana.unread).toBe(2);
    expect(ana.items.map((i) => i.title).sort()).toEqual(['For Ana', 'For admins']);
    expect(ana.items.find((i) => i.title === 'For Ana')).toMatchObject({ body: 'Only you', href: '/app/email', read: false });
    expect(Object.keys(ana.items.find((i) => i.title === 'For admins')!).sort()).toEqual(['at', 'id', 'read', 'title']);

    const ben = await listNotifications(t.env, { orgId: ORG, userId: 'usr_b', isAdmin: false });
    expect(ben.items.map((i) => i.title)).toEqual(['For Ben']);
    expect(ben.unread).toBe(1);

    expect((await listNotifications(t.env, { orgId: OTHER, userId: 'usr_a' })).items.map((i) => i.title)).toEqual(['Other workspace']);
  });

  it('lists newest first and honours the limit while still counting every unread', async () => {
    const t = createTestEnv();
    for (let i = 0; i < 5; i++) {
      await notify(t.env, { orgId: ORG, userId: 'usr_a', title: `n${i}` });
      await sleep(2);
    }
    const res = await listNotifications(t.env, { orgId: ORG, userId: 'usr_a', limit: 3 });
    expect(res.items.map((i) => i.title)).toEqual(['n4', 'n3', 'n2']);
    expect(res.unread).toBe(5);
  });

  it('skips repeats that share a dedupe key', async () => {
    const t = createTestEnv();
    const first = await notify(t.env, { orgId: ORG, title: 'Email needs setup', dedupeKey: 'email-setup' });
    const again = await notify(t.env, { orgId: ORG, title: 'Email needs setup', dedupeKey: 'email-setup' });
    const otherOrg = await notify(t.env, { orgId: OTHER, title: 'Email needs setup', dedupeKey: 'email-setup' });
    const noKey1 = await notify(t.env, { orgId: ORG, title: 'Plain' });
    const noKey2 = await notify(t.env, { orgId: ORG, title: 'Plain' });
    expect([first.created, again.created, otherOrg.created, noKey1.created, noKey2.created]).toEqual([true, false, true, true, true]);
    expect(again.id).toBeNull();
    expect((await listNotifications(t.env, { orgId: ORG, userId: 'usr_a' })).items).toHaveLength(3);
  });

  it('checks the input', async () => {
    const t = createTestEnv();
    await expect(notify(t.env, { orgId: ORG, title: '  ' })).rejects.toMatchObject({ code: 'validation_failed', fields: { title: expect.any(String) } });
    await expect(notify(t.env, { orgId: ORG, title: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'validation_failed' });
    for (const href of ['javascript:alert(1)', '//evil.example.com', 'http://example.com', 'data:text/html,hi', '/ok\nbad']) {
      await expect(notify(t.env, { orgId: ORG, title: 'x', href })).rejects.toMatchObject({ code: 'validation_failed', fields: { href: expect.any(String) } });
    }
    await expect(notify(t.env, { orgId: ORG, title: 'x', href: '/app/email?tab=1' })).resolves.toMatchObject({ created: true });
    await expect(notify(t.env, { orgId: ORG, title: 'x', href: 'https://example.com/a' })).resolves.toMatchObject({ created: true });
  });
});

describe('read state', () => {
  it('keeps read state per person, even for one shared admin notification', async () => {
    const t = createTestEnv();
    const { id } = await notify(t.env, { orgId: ORG, title: 'Shared' });
    await notify(t.env, { orgId: ORG, userId: 'usr_a', title: 'Private' });

    await markRead(t.env, { orgId: ORG, userId: 'usr_a', id: id! });
    const ana = await listNotifications(t.env, { orgId: ORG, userId: 'usr_a' });
    expect(ana.unread).toBe(1);
    expect(ana.items.find((i) => i.title === 'Shared')?.read).toBe(true);

    const ben = await listNotifications(t.env, { orgId: ORG, userId: 'usr_b' });
    expect(ben.unread).toBe(1);
    expect(ben.items[0]?.read).toBe(false);
  });

  it('marking twice is fine, and a stranger’s notification is not found', async () => {
    const t = createTestEnv();
    const mine = await notify(t.env, { orgId: ORG, userId: 'usr_a', title: 'Mine' });
    const theirs = await notify(t.env, { orgId: ORG, userId: 'usr_b', title: 'Theirs' });
    const elsewhere = await notify(t.env, { orgId: OTHER, userId: 'usr_a', title: 'Elsewhere' });
    await markRead(t.env, { orgId: ORG, userId: 'usr_a', id: mine.id! });
    await markRead(t.env, { orgId: ORG, userId: 'usr_a', id: mine.id! });
    await expect(markRead(t.env, { orgId: ORG, userId: 'usr_a', id: theirs.id! })).rejects.toMatchObject({ code: 'not_found' });
    await expect(markRead(t.env, { orgId: ORG, userId: 'usr_a', id: elsewhere.id! })).rejects.toMatchObject({ code: 'not_found' });
    await expect(markRead(t.env, { orgId: ORG, userId: 'usr_a', id: 'ntf_missing' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await listNotifications(t.env, { orgId: ORG, userId: 'usr_b' })).unread).toBe(1);
  });

  it('a non-admin cannot mark an admin notification', async () => {
    const t = createTestEnv();
    const { id } = await notify(t.env, { orgId: ORG, title: 'Admins only' });
    await expect(markRead(t.env, { orgId: ORG, userId: 'usr_b', isAdmin: false, id: id! })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('mark all read clears the count for that person only, and new ones count again', async () => {
    const t = createTestEnv();
    await notify(t.env, { orgId: ORG, title: 'One' });
    await notify(t.env, { orgId: ORG, title: 'Two' });
    await markAllRead(t.env, { orgId: ORG, userId: 'usr_a' });
    const a = await listNotifications(t.env, { orgId: ORG, userId: 'usr_a' });
    expect(a.unread).toBe(0);
    expect(a.items.every((i) => i.read)).toBe(true);
    expect((await listNotifications(t.env, { orgId: ORG, userId: 'usr_b' })).unread).toBe(2);
    await sleep(3);
    await notify(t.env, { orgId: ORG, title: 'Three' });
    expect((await listNotifications(t.env, { orgId: ORG, userId: 'usr_a' })).unread).toBe(1);
    await markAllRead(t.env, { orgId: ORG, userId: 'usr_a' });
    await markAllRead(t.env, { orgId: ORG, userId: 'usr_a' });
    expect((await listNotifications(t.env, { orgId: ORG, userId: 'usr_a' })).unread).toBe(0);
  });
});

describe('cleanup', () => {
  it('deletes rows older than 60 days and their read marks, keeps the rest', async () => {
    const t = createTestEnv();
    const now = Date.UTC(2026, 10, 21);
    const day = 86_400_000;
    const insert = (id: string, age: number) =>
      t.env.DB.prepare("INSERT INTO notifications (id, org_id, title, created_at) VALUES (?1, ?2, 't', ?3)").bind(id, ORG, now - age * day).run();
    await insert('ntf_old', 61);
    await insert('ntf_edge', 59);
    await insert('ntf_new', 1);
    await t.env.DB.prepare("INSERT INTO notification_reads (org_id, user_id, notification_id, read_at) VALUES (?1, 'usr_a', 'ntf_old', ?2), (?1, 'usr_a', 'ntf_new', ?3)")
      .bind(ORG, now - 60.5 * day, now)
      .run();
    expect(await cleanupNotifications(t.env, now)).toBe(1);
    const ids = (await t.env.DB.prepare('SELECT id FROM notifications ORDER BY id').all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual(['ntf_edge', 'ntf_new']);
    expect((await t.env.DB.prepare('SELECT notification_id FROM notification_reads').all<{ notification_id: string }>()).results.map((r) => r.notification_id)).toEqual(['ntf_new']);
  });

  it('frees a dedupe key once its row is cleaned up', async () => {
    const t = createTestEnv();
    const now = Date.UTC(2026, 10, 21);
    await t.env.DB.prepare("INSERT INTO notifications (id, org_id, title, dedupe_key, created_at) VALUES ('ntf_1', ?1, 't', 'k', ?2)").bind(ORG, now - 70 * 86_400_000).run();
    expect((await notify(t.env, { orgId: ORG, title: 't', dedupeKey: 'k' })).created).toBe(false);
    await cleanupNotifications(t.env, now);
    expect((await notify(t.env, { orgId: ORG, title: 't', dedupeKey: 'k' })).created).toBe(true);
  });

  it('runs every day as a core schedule', async () => {
    const t = createTestEnv();
    const at = new Date(Date.UTC(2026, 10, 22, 0, 0));
    await t.env.DB.prepare("INSERT INTO notifications (id, org_id, title, created_at) VALUES ('ntf_old', ?1, 't', ?2)").bind(ORG, at.getTime() - 90 * 86_400_000).run();
    expect((await runSchedules(t.env, at)).ran).toContain('core.notifications-cleanup');
    expect((await t.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('routes', () => {
  it('lists, marks one and marks all for the signed-in person', async () => {
    const t = createTestEnv();
    const a = await notify(t.env, { orgId: ORG, userId: 'usr_a', title: 'Mine', href: '/app' });
    await notify(t.env, { orgId: ORG, title: 'Admins' });
    await notify(t.env, { orgId: ORG, userId: 'usr_b', title: 'Not mine' });
    const api = routeApp(notificationRoutes.api, t, { userId: 'usr_a', role: 'admin' });

    const list = await api.json('/');
    expect(list.status).toBe(200);
    expect(list.body.unread).toBe(2);
    expect(list.body.items.map((i: { title: string }) => i.title).sort()).toEqual(['Admins', 'Mine']);

    expect((await api.json(`/${a.id}/read`, { method: 'POST' })).status).toBe(200);
    expect((await api.json('/')).body.unread).toBe(1);
    expect((await api.json('/ntf_nope/read', { method: 'POST' })).status).toBe(404);
    expect((await api.json('/read-all', { method: 'POST' })).status).toBe(200);
    expect((await api.json('/')).body.unread).toBe(0);
    expect((await api.json('/?limit=1')).body.items).toHaveLength(1);
    expect((await api.json('/?limit=500')).status).toBe(422);
  });

  it('hides admin notifications from members and turns API keys away', async () => {
    const t = createTestEnv();
    await notify(t.env, { orgId: ORG, title: 'Admins' });
    const member = routeApp(notificationRoutes.api, t, { userId: 'usr_m', role: 'member' });
    expect((await member.json('/')).body).toEqual({ unread: 0, items: [] });
    const key = routeApp(notificationRoutes.api, t, { kind: 'apikey' });
    const res = await key.json('/');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });
});
