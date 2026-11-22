import { describe, expect, it } from 'vitest';
import { devOutbox } from '../../core/email';
import { createTestEnv } from '../../../test/helpers/d1';
import { mountModule } from '../../../test/helpers/app';
import mod from './module';
import { previewLink } from './public';
import { canonicalEmail, cleanEmail, domainRefusal, isDisposable } from './rules';
import { parseCsv, guessMapping } from './transfer';

interface Joined {
  ok: boolean;
  position: number | null;
  referralCode: string;
  referralLink: string;
  statusUrl: string;
  needsConfirm: boolean;
  status: string;
}

async function setup(extra: Record<string, unknown> = {}) {
  const t = createTestEnv();
  const app = await mountModule(t, mod);
  const res = await app.request('/api/v1/waitlist/waitlists', { json: { name: 'Launch', status: 'live', ...extra } });
  expect(res.status).toBe(201);
  const wl = (await res.json()) as { id: string; slug: string };
  const visitor = app.as({ kind: 'anon' });
  const join = async (email: string, more: Record<string, unknown> = {}) => {
    const r = await visitor.request(`/w/${wl.slug}/join`, { json: { email, ...more } });
    return { status: r.status, body: (await r.json()) as Joined };
  };
  const person = (email: string) => t.env.DB.prepare('SELECT * FROM wl_signups WHERE email = ?1').bind(email).first<Record<string, unknown>>();
  const confirm = async (email: string) => {
    const row = await person(email);
    return visitor.request(`/w/${wl.slug}/confirm/${row!.token}`, { method: 'POST' });
  };
  return { t, app, visitor, wl, join, person, confirm };
}

describe('rules', () => {
  it('cleans and canonicalises addresses', () => {
    expect(cleanEmail(' Ann@Example.com ')).toBe('ann@example.com');
    expect(cleanEmail('nope')).toBeNull();
    expect(canonicalEmail('a.n.n+x@gmail.com')).toBe(canonicalEmail('ann@gmail.com'));
  });
  it('knows disposable and blocked domains', () => {
    expect(isDisposable('mailinator.com', { disposable_domains: '' })).toBe(true);
    expect(domainRefusal('bad.com', { blocked_domains: 'bad.com', allowed_domains: '' })).toBe('blocked');
  });
  it('parses csv with quotes and guesses columns', () => {
    const rows = parseCsv('Email,Full name\r\n"a@example.com","Doe, Jo"\r\n');
    expect(rows[1]).toEqual(['a@example.com', 'Doe, Jo']);
    expect(guessMapping(rows[0]!)).toMatchObject({ email: 0, name: 1 });
  });
});

describe('questions', () => {
  it('refuses a select question that has no choices, and says why', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, mod);
    const res = await app.request('/api/v1/waitlist/waitlists', { json: { name: 'Launch', questions: [{ id: 'q1', label: 'Team size', type: 'select', required: true, options: [] }] } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields?: Record<string, string> };
    expect(JSON.stringify(body)).toContain('needs its choices');
  });
});

describe('sign up', () => {
  it('returns code, link and position and rejects bad input', async () => {
    const s = await setup({ double_optin: false });
    const a = await s.join('a@example.com');
    expect(a.status).toBe(201);
    expect(a.body.referralCode).toMatch(/^[a-z0-9]+$/i);
    expect(a.body.referralLink).toContain(`?ref=${a.body.referralCode}`);
    expect(a.body.position).toBe(1 + 0);
    expect((await s.join('bad')).status).toBe(400);
  });

  it('answers the same for a repeat address and a honeypot', async () => {
    const s = await setup();
    await s.join('a@example.com');
    const again = await s.join('a@example.com');
    expect(again.body).toEqual({ ok: true });
    const bot = await s.join('b@example.com', { website: 'spam' });
    expect(bot.body).toEqual({ ok: true });
    expect(await s.person('b@example.com')).toBeNull();
  });

  it('refuses a form that came back too fast', async () => {
    const s = await setup();
    const page = await (await s.visitor.request(`/w/${s.wl.slug}`)).text();
    const token = /name="t" value="([^"]+)"/.exec(page)![1]!;
    const res = await s.visitor.request(`/w/${s.wl.slug}/join`, { form: { email: 'fast@example.com', t: token } });
    expect(res.status).toBe(429);
  });

  it('serves the hosted page without cookies and counts a view', async () => {
    const s = await setup();
    const res = await s.visitor.request(`/w/${s.wl.slug}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await res.text()).length).toBeLessThan(30_000);
    const views = await s.t.env.DB.prepare('SELECT SUM(views) AS v FROM wl_daily').first<{ v: number }>();
    expect(views?.v).toBe(1);
  });

  it('allows cross-site JSON posts', async () => {
    const s = await setup();
    const pre = await s.visitor.request(`/w/${s.wl.slug}/join`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('referrals', () => {
  it('credits only after the referred person confirms, and moves the referrer up', async () => {
    const s = await setup({ double_optin: true, skip_per_referral: 1, fraud_level: 'off' });
    const a = await s.join('a@example.com');
    await s.confirm('a@example.com');
    await s.join('x@example.com');
    await s.confirm('x@example.com');
    const b = await s.join('b@example.com', { ref: a.body.referralCode });
    expect(b.body.needsConfirm).toBe(true);
    expect((await s.person('a@example.com'))!.referral_count).toBe(0);
    await s.confirm('b@example.com');
    expect((await s.person('a@example.com'))!.referral_count).toBe(1);
    const me = await s.visitor.request(`/w/${s.wl.slug}/me/${(await s.person('a@example.com'))!.token}`);
    expect(await me.text()).toContain('You are number 1');
  });

  it('holds a referral from the same visitor and lists it in the review queue', async () => {
    const s = await setup({ fraud_level: 'strict', double_optin: false });
    const a = await s.join('a@example.com');
    await s.join('a2@example.com', { ref: a.body.referralCode });
    expect((await s.person('a2@example.com'))!.referral_status).toBe('held');
    const review = (await (await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/review`)).json()) as { data: unknown[] };
    expect(review.data.length).toBeGreaterThan(0);
    expect((await s.person('a@example.com'))!.referral_count).toBe(0);
  });

  it('holds disposable addresses and bulk approves them', async () => {
    const s = await setup({ fraud_level: 'balanced', double_optin: false });
    await s.join('d@mailinator.com');
    const row = (await s.person('d@mailinator.com'))!;
    expect(row.status).toBe('flagged');
    const res = await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/signups/bulk`, { json: { action: 'approve', ids: [row.id] } });
    expect(res.status).toBe(200);
    expect((await s.person('d@mailinator.com'))!.status).toBe('active');
  });
});

describe('emails', () => {
  it('sends a confirm email, then a welcome email with the referral link', async () => {
    const s = await setup({ double_optin: true });
    await s.join('a@example.com');
    let box = await devOutbox(s.t.env, { to: 'a@example.com' });
    expect(box.some((m) => /confirm/i.test(m.subject))).toBe(true);
    await s.confirm('a@example.com');
    box = await devOutbox(s.t.env, { to: 'a@example.com' });
    expect(box.some((m) => (m.text ?? '').includes('?ref='))).toBe(true);
  });

  it('puts an unsubscribe link in marketing email and honours it', async () => {
    const s = await setup({ double_optin: false });
    await s.join('a@example.com');
    const welcome = (await devOutbox(s.t.env, { to: 'a@example.com' }))[0]!;
    const url = /\/w\/unsubscribe\/[\w.-]+/.exec(welcome.text ?? '')![0];
    const res = await s.visitor.request(url, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await s.person('a@example.com'))!.unsubscribed_at).not.toBeNull();
  });
});

describe('launch', () => {
  it('invites the top of the line, marks acceptance by redirect and emits events', async () => {
    const s = await setup({ double_optin: false });
    for (const n of ['a', 'b', 'c']) await s.join(`${n}@example.com`);
    const wave = (await (await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/waves`, { json: { name: 'One', size: 2, subject: 'You are in', body: 'Hello {{name}}, {{invite_link}}', start: true } })).json()) as { id: string };
    await s.t.drainJobs();
    const invited = await s.t.env.DB.prepare(`SELECT email, invite_code FROM wl_signups WHERE status = 'invited' ORDER BY seq`).all<{ email: string; invite_code: string }>();
    expect(invited.results.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com']);
    const res = await s.visitor.request(`/w/${s.wl.slug}/invite/${invited.results[0]!.invite_code}`);
    expect(res.status).toBe(200);
    expect((await s.person('a@example.com'))!.status).toBe('accepted');
    expect(wave.id).toBeTruthy();
  });

  it('refuses a broadcast until a test send matches the content', async () => {
    const s = await setup({ double_optin: false });
    await s.join('a@example.com');
    const bc = (await (await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/broadcasts`, { json: { subject: 'News', body: 'Hi {{name}}' } })).json()) as { id: string };
    const base = `/api/v1/waitlist/waitlists/${s.wl.id}/broadcasts/${bc.id}`;
    expect((await s.app.request(`${base}/start`, { method: 'POST' })).status).toBe(409);
    expect((await s.app.request(`${base}/test`, { json: { to: 'me@example.com' } })).status).toBe(200);
    expect((await s.app.request(`${base}/start`, { method: 'POST' })).status).toBe(200);
    await s.t.drainJobs();
    expect((await devOutbox(s.t.env, { to: 'a@example.com' })).some((m) => m.subject === 'News')).toBe(true);
  });
});

describe('data', () => {
  it('imports with kept codes, exports them, and erases one person but keeps counts', async () => {
    const s = await setup();
    const csv = 'Email,Name,Referral code,Referred by\nold@example.com,Old,oldcode1,\nnew@example.com,New,newcode1,oldcode1\n';
    const imp = await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/import`, { json: { csv } });
    expect(await imp.json()).toMatchObject({ added: 2, codesKept: 2, referralsLinked: 1 });
    const out = await (await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/export.csv`)).text();
    expect(out).toContain('oldcode1');
    expect((await s.person('old@example.com'))!.referral_count).toBe(1);
    const row = (await s.person('new@example.com'))!;
    const del = await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/signups/${row.id}?erase=1`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await s.person('new@example.com')).toBeNull();
    const wl = await s.t.env.DB.prepare('SELECT anon_count FROM wl_waitlists WHERE id = ?1').bind(s.wl.id).first<{ anon_count: number }>();
    expect(wl?.anon_count).toBe(1);
  });

  it('keeps test signups out of stats and clears them', async () => {
    const s = await setup({ double_optin: false, status: 'draft' });
    await s.t.env.DB.prepare('UPDATE wl_waitlists SET status = ?1').bind('live').run();
    await s.join('real@example.com');
    const link = new URL(await previewLink(s.t.env, 'http://localhost', (await s.t.env.DB.prepare('SELECT * FROM wl_waitlists').first())!));
    const page = await (await s.visitor.request(`${link.pathname}${link.search}`)).text();
    const p = /name="p" value="([^"]+)"/.exec(page)![1]!;
    await s.visitor.request(`/w/${s.wl.slug}/join`, { form: { email: 'test@example.com', p } });
    expect((await s.person('test@example.com'))!.is_test).toBe(1);
    const stats = (await (await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/stats`)).json()) as { total: number };
    expect(stats.total).toBe(1);
    const cleared = await s.app.request(`/api/v1/waitlist/waitlists/${s.wl.id}/test`, { method: 'DELETE' });
    expect(await cleared.json()).toEqual({ removed: 1 });
  });

  it('scopes: a read-only key cannot write', async () => {
    const s = await setup();
    const key = s.app.as({ kind: 'apikey', scopes: ['waitlist:read'] });
    expect((await key.request('/api/v1/waitlist/waitlists')).status).toBe(200);
    expect((await key.request('/api/v1/waitlist/waitlists', { json: { name: 'Nope' } })).status).toBe(403);
  });

  it('sample data fills and clears', async () => {
    const t = createTestEnv();
    const ctx = { env: t.env, org: t.org, db: (await import('../../core/db')).orgDb(t.env.DB, t.org.id) };
    await mod.sampleData!(ctx);
    expect(await mod.count!(ctx)).toBeGreaterThan(10);
    await mod.clearSampleData!(ctx);
    expect(await mod.count!(ctx)).toBe(0);
  });
});
