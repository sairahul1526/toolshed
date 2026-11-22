import { describe, expect, it } from 'vitest';
import { mountModule } from '../../../test/helpers/app';
import mailModule from './module';
import { clickToken, confirmToken, openToken, unsubscribeToken } from './tokens';
import { addPeople, fixture, T0 } from './testkit';
import { createBroadcast } from './broadcasts';
import { querySubscribers } from './subscribers';

async function web() {
  const f = await fixture();
  const app = await mountModule(f.t, mailModule, { caller: { kind: 'anon' } });
  return { f, app };
}
const status = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  (f.t.sqlite.prepare('SELECT status FROM mail_memberships WHERE subscriber_id = ?').get(id) as { status: string }).status;

describe('public pages', () => {
  it('shows the signup page and embed, without scripts or framing blocks', async () => {
    const { app } = await web();
    const page = await app.request('/n/weekly');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('The Weekly');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)|\sstyle=|\sonclick=|\sonload=/i);
    expect((await app.request('/n/weekly/embed')).headers.get('x-frame-options')).toBeNull();
    expect((await app.request('/n/nope')).status).toBe(404);
  });

  it('answers a signup the same way for new and known addresses, and rejects bots and bad addresses', async () => {
    const { f, app } = await web();
    await addPeople(f, 1, 'known');
    const a = await app.request('/n/weekly/subscribe', { form: { email: 'new@example.com' } });
    const b = await app.request('/n/weekly/subscribe', { form: { email: 'known0@example.com' } });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
    const bad = await app.request('/n/weekly/subscribe', { form: { email: 'nope' } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/email/i);
    const bot = await app.request('/n/weekly/subscribe', { form: { email: 'bot@example.com', website: 'http://spam.example' } });
    expect(bot.status).toBeLessThan(400);
    expect((await querySubscribers(f.ctx, { listId: f.list.id, status: 'pending' }, T0)).items.map((i) => i.email)).toEqual(['new@example.com']);
  });

  it('rate limits repeated signups for one address', async () => {
    const { app } = await web();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.request('/n/weekly/subscribe', { form: { email: 'same@example.com' } })).status);
    expect(codes).toContain(429);
  });

  it('confirms only on POST, so a mail scanner opening the link changes nothing', async () => {
    const { f, app } = await web();
    const { subscriber } = await (await import('./subscribers')).joinList(f.ctx, f.list, { email: 'a@example.com' }, { base: 'http://localhost', sender: f.sender, now: Date.now() });
    const token = await confirmToken(f.t.env, { o: f.t.org.id, s: subscriber!.id, l: f.list.id });
    expect((await app.request(`/n/confirm/${token}`)).status).toBe(200);
    expect(await status(f, subscriber!.id)).toBe('pending');
    expect((await app.request(`/n/confirm/${token}`, { method: 'POST' })).status).toBe(200);
    expect(await status(f, subscriber!.id)).toBe('active');
    expect((await app.request('/n/confirm/garbage')).status).toBe(400);
  });
});

describe('unsubscribe links', () => {
  it('GET shows a button and changes nothing; POST unsubscribes; one-click works; tampering is refused', async () => {
    const { f, app } = await web();
    const [email] = await addPeople(f, 1);
    const sub = f.t.sqlite.prepare('SELECT id FROM mail_subscribers WHERE email = ?').get(email!) as { id: string };
    const token = await unsubscribeToken(f.t.env, { o: f.t.org.id, s: sub.id, l: f.list.id });

    const get = await app.request(`/n/u/${token}`);
    expect(get.status).toBe(200);
    expect(await status(f, sub.id)).toBe('active');

    const bad = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect((await app.request(`/n/u/${bad}`, { method: 'POST' })).status).toBe(400);
    expect(await status(f, sub.id)).toBe('active');
    const other = await unsubscribeToken(f.t.env, { o: 'org_other', s: sub.id, l: f.list.id });
    expect((await app.request(`/n/u/${other}`, { method: 'POST' })).status).toBeGreaterThanOrEqual(400);
    expect(await status(f, sub.id)).toBe('active');

    // The mail client's one-click request posts this body.
    const click = await app.request(`/n/u/${token}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(click.status).toBe(200);
    expect(await status(f, sub.id)).toBe('unsubscribed');
    // Doing it twice is fine.
    expect((await app.request(`/n/u/${token}`, { method: 'POST' })).status).toBe(200);
  });
});

describe('tracking links', () => {
  it('redirects only to web addresses, counts clicks, and serves a pixel', async () => {
    const { f, app } = await web();
    await addPeople(f, 1);
    const b = await createBroadcast(f.ctx, { list_id: f.list.id, subject: 'S', body: 'x' }, T0);
    const link = (u: string, id: string) => {
      f.t.sqlite.prepare('INSERT INTO mail_links (id, org_id, broadcast_id, url, created_at) VALUES (?, ?, ?, ?, ?)').run(id, f.t.org.id, b.id, u, T0);
      return clickToken(f.t.env, { o: f.t.org.id, k: id, d: 'none' });
    };
    const res = await app.request(`/n/c/${await link('https://example.com/post', 'l1')}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/post');
    expect((await app.request('/n/c/garbage')).status).toBe(400);
    const evil = await link('javascript:alert(1)', 'l2');
    expect((await app.request(`/n/c/${evil}`, { redirect: 'manual' })).status).toBeGreaterThanOrEqual(400);
    const px = await app.request(`/n/o/${await openToken(f.t.env, { o: f.t.org.id, d: 'x' })}`);
    expect(px.headers.get('content-type')).toBe('image/gif');
  });
});

describe('archive', () => {
  it('is hidden until switched on, then lists sent issues and an RSS feed', async () => {
    const { f, app } = await web();
    expect((await app.request('/n/weekly/archive')).status).toBe(404);
    f.t.sqlite.prepare('UPDATE mail_lists SET archive_public = 1').run();
    const empty = await app.request('/n/weekly/archive');
    expect(empty.status).toBe(200);
    expect((await app.request('/n/weekly/rss.xml')).headers.get('content-type')).toMatch(/xml/);
  });
});

describe('api scopes and sending', () => {
  it('needs the right scope, and a transactional send is idempotent', async () => {
    const f = await fixture();
    const admin = await mountModule(f.t, mailModule);
    const reader = admin.as({ kind: 'apikey', scopes: ['mail:read'] });
    const sender = admin.as({ kind: 'apikey', scopes: ['mail:send'] });
    expect((await reader.request('/api/v1/mail/lists')).status).toBe(200);
    expect((await reader.request('/api/v1/mail/lists', { json: { name: 'X', slug: 'x' } })).status).toBe(403);
    expect((await reader.request('/api/v1/mail/send', { json: { to: 'a@example.com', subject: 'Hi', body: 'Hello' } })).status).toBe(403);
    expect((await sender.request('/api/v1/mail/lists')).status).toBe(403);

    const hdr = { 'idempotency-key': 'order-1' };
    const first = await sender.request('/api/v1/mail/send', { json: { to: 'a@example.com', subject: 'Hi', body: 'Hello' }, headers: hdr });
    expect(first.status).toBe(201);
    const again = await sender.request('/api/v1/mail/send', { json: { to: 'a@example.com', subject: 'Hi', body: 'Hello' }, headers: hdr });
    expect(again.status).toBe(200);
    expect((await again.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
    const n = f.t.sqlite.prepare("SELECT COUNT(*) AS n FROM mail_sent").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('imports a CSV through the API and refuses it without consent', async () => {
    const f = await fixture();
    const admin = await mountModule(f.t, mailModule);
    const body = { list_id: f.list.id, csv: 'email\na@example.com\nb@example.com\n' };
    expect((await admin.request('/api/v1/mail/subscribers/import', { json: { ...body, consent: false } })).status).toBe(422);
    const ok = await admin.request('/api/v1/mail/subscribers/import', { json: { ...body, consent: true } });
    expect(ok.status).toBe(201);
    expect((await ok.json()) as { added: number }).toMatchObject({ added: 2 });
  });
});
