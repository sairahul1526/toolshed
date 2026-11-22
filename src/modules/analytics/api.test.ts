import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import { orgDb } from '../../core/db';
import type { ModuleContext } from '../../core/module';
import { forgetSites } from './ingest';
import analytics from './module';
import { createSite } from './sites';
import { CHROME } from './testkit';
import { HOUR, MINUTE } from './time';

const API = '/api/v1/analytics';
const T0 = Date.UTC(2026, 2, 12, 9, 0, 0);

interface SiteOut {
  id: string;
  key: string;
  domain: string;
  snippet: string;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function mounted(): Promise<{ t: TestEnv; app: MountedModule; site: SiteOut }> {
  const t = createTestEnv();
  const app = await mountModule(t, analytics);
  const res = await app.request(`${API}/sites`, { json: { domain: 'https://www.Example.com/pricing', timezone: 'UTC' } });
  expect(res.status).toBe(201);
  return { t, app, site: (await res.json()) as SiteOut };
}

/** One hit sent the way the script sends it: a text body from the customer's page. */
function beacon(app: MountedModule, site: SiteOut, body: Record<string, unknown>, opts: { who?: number; origin?: string | null; ua?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': opts.ua ?? CHROME, 'cf-connecting-ip': `198.51.100.${opts.who ?? 1}` };
  if (opts.origin !== null) headers.origin = opts.origin ?? 'https://example.com';
  return app.as({ kind: 'anon' }).request('/a/e', { method: 'POST', headers, body: JSON.stringify({ k: site.key, t: 'p', u: 'https://example.com/', ...body }) });
}

function hitCount(t: TestEnv): number {
  return (t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_hits').get() as { n: number }).n;
}

describe('sites', () => {
  it('adds a site and hands back the line to paste', async () => {
    const { t, app, site } = await mounted();
    expect(site.domain).toBe('example.com');
    expect(site.snippet).toBe(`<script defer data-site="${site.key}" src="http://localhost/m/analytics/t.js"></script>`);
    const list = (await (await app.request(`${API}/sites`)).json()) as { items: SiteOut[]; nextCursor: null };
    expect(list.items.map((s) => s.id)).toEqual([site.id]);
    expect(list.nextCursor).toBeNull();
    expect(t.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'site.created'").all()).toHaveLength(1);
  });

  it('explains what is wrong with a bad site', async () => {
    const { app } = await mounted();
    const bad = await app.request(`${API}/sites`, { json: { domain: 'not a domain' } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fields: Record<string, string> }).fields.domain).toMatch(/example\.com/);
    const twice = await app.request(`${API}/sites`, { json: { domain: 'example.com' } });
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { code: string }).code).toBe('analytics.domain_taken');
    const zone = await app.request(`${API}/sites`, { json: { domain: 'example.org', timezone: 'Mars/Olympus' } });
    expect(((await zone.json()) as { fields: Record<string, string> }).fields.timezone).toBeTruthy();
  });

  it('changes settings, and the change reaches the collect endpoint at once', async () => {
    const { t, app, site } = await mounted();
    await beacon(app, site, { u: 'https://shop.example.net/' }, { origin: 'https://shop.example.net' });
    expect(hitCount(t)).toBe(0);
    const res = await app.request(`${API}/sites/${site.id}`, { method: 'PATCH', json: { domains: ['shop.example.net'], retention_days: 90, weekly_report: true, report_emails: 'team@example.com' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ domains: ['shop.example.net'], retention_days: 90, weekly_report: true, report_emails: ['team@example.com'] });
    await beacon(app, site, { u: 'https://shop.example.net/' }, { origin: 'https://shop.example.net' });
    expect(hitCount(t)).toBe(1);
    const bad = await app.request(`${API}/sites/${site.id}`, { method: 'PATCH', json: { retention_days: 12 } });
    expect(bad.status).toBe(422);
  });

  it('lets an admin delete a site and cleans up its hits in the background', async () => {
    const { t, app, site } = await mounted();
    await beacon(app, site, {});
    expect(hitCount(t)).toBe(1);
    expect((await app.as({ role: 'member' }).request(`${API}/sites/${site.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await app.request(`${API}/sites/${site.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`${API}/sites/${site.id}`)).status).toBe(404);
    await t.drainJobs();
    expect(hitCount(t)).toBe(0);
    // The old key takes nothing any more.
    await beacon(app, site, {});
    expect(hitCount(t)).toBe(0);
  });
});

describe('who may do what', () => {
  it('viewers and read keys can look but not change', async () => {
    const { app, site } = await mounted();
    for (const caller of [app.as({ role: 'viewer' }), app.as({ kind: 'apikey', scopes: ['analytics:read'] })]) {
      expect((await caller.request(`${API}/sites`)).status).toBe(200);
      expect((await caller.request(`${API}/sites/${site.id}/stats`)).status).toBe(200);
      expect((await caller.request(`${API}/sites`, { json: { domain: 'example.org' } })).status).toBe(403);
      expect((await caller.request(`${API}/sites/${site.id}`, { method: 'PATCH', json: { name: 'x' } })).status).toBe(403);
      expect((await caller.request(`${API}/sites/${site.id}/goals`, { json: { kind: 'event', match: 'Signup' } })).status).toBe(403);
      expect((await caller.request(`${API}/sites/${site.id}/shares`, { json: {} })).status).toBe(403);
      expect((await caller.request(`${API}/sites/${site.id}/events`, { json: { name: 'Paid', url: 'https://example.com/' } })).status).toBe(403);
    }
  });

  it('a write key covers reading, and a key for another module covers nothing', async () => {
    const { app, site } = await mounted();
    const writer = app.as({ kind: 'apikey', scopes: ['analytics:write'] });
    expect((await writer.request(`${API}/sites/${site.id}/stats`)).status).toBe(200);
    expect((await writer.request(`${API}/sites/${site.id}/goals`, { json: { kind: 'event', match: 'Signup' } })).status).toBe(201);
    // Deleting a site is for admins, and a key has no role above member.
    expect((await app.as({ kind: 'apikey', role: 'member', scopes: ['analytics:write'] }).request(`${API}/sites/${site.id}`, { method: 'DELETE' })).status).toBe(403);
    const other = app.as({ kind: 'apikey', scopes: ['links:write'] });
    expect((await other.request(`${API}/sites`)).status).toBe(403);
  });

  it('turns away visitors, and everyone while the module is off', async () => {
    const { app, site } = await mounted();
    expect((await app.as({ kind: 'anon' }).request(`${API}/sites`)).status).toBe(401);
    expect((await app.as({ kind: 'anon' }).request(`${API}/sites/${site.id}/stats`)).status).toBe(401);
    const t = createTestEnv();
    const off = await mountModule(t, analytics, { off: true });
    const res = await off.request(`${API}/sites`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('module_off');
  });

  it('never shows another workspace’s sites, stats, goals or hits', async () => {
    const { t, app, site } = await mounted();
    const other: ModuleContext = { env: t.env, org: { id: 'org_other', name: 'Other', slug: 'other' }, db: orgDb(t.env.DB, 'org_other') };
    const theirs = await createSite(other, { domain: 'example.org' });
    const list = (await (await app.request(`${API}/sites`)).json()) as { items: SiteOut[] };
    expect(list.items.map((s) => s.id)).toEqual([site.id]);
    for (const path of ['', '/stats', '/timeseries', '/breakdown/page', '/conversions', '/live', '/health', '/hits', '/goals', '/shares', '/events/Signup/props']) {
      expect((await app.request(`${API}/sites/${theirs.id}${path}`)).status, path).toBe(404);
    }
    expect((await app.request(`${API}/sites/${theirs.id}`, { method: 'PATCH', json: { name: 'mine now' } })).status).toBe(404);
    expect((await app.request(`${API}/sites/${theirs.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`${API}/sites/${theirs.id}/events`, { json: { name: 'x', url: 'https://example.org/' } })).status).toBe(404);
    expect((await app.request(`${API}/sites/${theirs.id}/goals`, { json: { kind: 'event', match: 'x' } })).status).toBe(404);
  });
});

describe('the collect endpoint', () => {
  it('answers 202 with no body and no cookie, and stores the hit', async () => {
    const { t, app, site } = await mounted();
    const res = await beacon(app, site, { r: 'https://www.google.com/' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(t.sqlite.prepare('SELECT kind, path, source, channel, device FROM an_hits').all()).toEqual([{ kind: 'p', path: '/', source: 'Google', channel: 'Search', device: 'desktop' }]);
    expect(t.kv.store?.size ?? 0).toBeLessThanOrEqual(1);
  });

  it('answers the same 202 to hits it refuses, and counts them for the health panel', async () => {
    const { t, app, site } = await mounted();
    const refused = [
      await beacon(app, site, { u: 'https://evil.example.net/' }, { origin: 'https://evil.example.net' }),
      await beacon(app, site, {}, { origin: 'https://evil.example.net' }),
      await beacon(app, site, { u: 'http://localhost:3000/' }, { origin: null }),
      await beacon(app, site, {}, { ua: 'Mozilla/5.0 (compatible; bingbot/2.0)' }),
      await beacon(app, site, { k: 'wrong-key' }),
      await beacon(app, site, { t: 'x' }),
      await beacon(app, site, { u: 'x'.repeat(9000) }),
      await app.as({ kind: 'anon' }).request('/a/e', { method: 'POST', body: '{not json' }),
      await app.as({ kind: 'anon' }).request('/a/e', { method: 'POST' }),
    ];
    expect(refused.map((r) => r.status)).toEqual(refused.map(() => 202));
    expect(hitCount(t)).toBe(0);
    const health = (await (await app.request(`${API}/sites/${site.id}/health`)).json()) as { dropped_last_7_days: { reason: string; n: number }[] };
    expect(health.dropped_last_7_days).toEqual([{ reason: 'origin', n: 2 }, { reason: 'bot', n: 1 }, { reason: 'localhost', n: 1 }]);
  });

  it('answers the preflight a browser sends before a JSON post', async () => {
    const { app } = await mounted();
    const res = await app.as({ kind: 'anon' }).request('/a/e', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('counts a page view from the pixel, using the address of the page that showed it', async () => {
    const { t, app, site } = await mounted();
    const res = await app.as({ kind: 'anon' }).request(`/a/p.gif?k=${site.key}`, { headers: { referer: 'https://example.com/no-script?x=1', 'user-agent': CHROME, 'cf-connecting-ip': '198.51.100.7' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 6)).toEqual(new TextEncoder().encode('GIF89a'));
    expect(t.sqlite.prepare('SELECT kind, path FROM an_hits').all()).toEqual([{ kind: 'p', path: '/no-script' }]);
    // No key, no page: still an image, nothing stored.
    expect((await app.as({ kind: 'anon' }).request('/a/p.gif')).status).toBe(200);
    expect(hitCount(t)).toBe(1);
  });
});

describe('the Stats API', () => {
  async function withTraffic(): Promise<{ t: TestEnv; app: MountedModule; site: SiteOut }> {
    const m = await mounted();
    await beacon(m.app, m.site, { r: 'https://www.google.com/' }, { who: 1 });
    vi.setSystemTime(T0 + 2 * MINUTE);
    await beacon(m.app, m.site, { u: 'https://example.com/pricing' }, { who: 1 });
    vi.setSystemTime(T0 + 2 * MINUTE + 10_000);
    await beacon(m.app, m.site, { t: 'e', n: 'Signup', u: 'https://example.com/pricing', p: { plan: 'Pro' } }, { who: 1 });
    vi.setSystemTime(T0 + 3 * MINUTE);
    await beacon(m.app, m.site, { u: 'https://example.com/pricing?utm_source=newsletter&utm_medium=email' }, { who: 2 });
    vi.setSystemTime(T0 + 4 * MINUTE);
    return m;
  }

  it('gives totals with ratios, and the period before when asked', async () => {
    const { app, site } = await withTraffic();
    const res = await app.as({ kind: 'apikey', scopes: ['analytics:read'] }).request(`${API}/sites/${site.id}/stats?period=today&compare=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      range: { period: 'today', from: '2026-03-12', to: '2026-03-12', timezone: 'UTC' },
      filters: {},
      mode: 'totals',
      partial: false,
      totals: { visitors: 2, visits: 2, pageviews: 3, events: 1, unbounces: 1, duration: 130_000, bounce_rate: 0.5, views_per_visit: 1.5, visit_seconds: 65 },
      previous: { from: '2026-03-11', to: '2026-03-11', visitors: 0, visits: 0, pageviews: 0, events: 0, unbounces: 0, duration: 0, bounce_rate: null, views_per_visit: null, visit_seconds: null },
    });
  });

  it('filters by anything in the query string', async () => {
    const { app, site } = await withTraffic();
    const email = (await (await app.request(`${API}/sites/${site.id}/stats?period=today&channel=Email`)).json()) as { mode: string; totals: { visitors: number }; filters: unknown };
    expect(email).toMatchObject({ mode: 'raw', filters: { channel: 'Email' }, totals: { visitors: 1, pageviews: 1 } });
    const page = (await (await app.request(`${API}/sites/${site.id}/stats?period=today&page=/pricing`)).json()) as { partial: boolean; totals: { visitors: number; pageviews: number } };
    expect(page).toMatchObject({ partial: true, totals: { visitors: 2, pageviews: 2 } });
  });

  it('gives a time series, breakdowns as JSON or CSV, and pages through them', async () => {
    const { app, site } = await withTraffic();
    const series = (await (await app.request(`${API}/sites/${site.id}/timeseries?period=today`)).json()) as { bucket: string; items: { label: string; visitors: number; pageviews: number }[] };
    expect(series.bucket).toBe('hour');
    expect(series.items).toHaveLength(24);
    expect(series.items[9]).toEqual({ label: '09:00', visitors: 2, pageviews: 3 });

    const first = (await (await app.request(`${API}/sites/${site.id}/breakdown/page?period=today&limit=1`)).json()) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(first.items).toEqual([expect.objectContaining({ page: '/pricing', visitors: 2, pageviews: 2 })]);
    expect(first.items[0]).not.toHaveProperty('value');
    const second = (await (await app.request(`${API}/sites/${site.id}/breakdown/page?period=today&limit=1&cursor=${first.nextCursor}`)).json()) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(second.items.map((r) => r.page)).toEqual(['/']);
    expect(second.nextCursor).toBeNull();

    const csv = await app.request(`${API}/sites/${site.id}/breakdown/source?period=today&format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="example.com-source-2026-03-12-to-2026-03-12.csv"');
    const lines = (await csv.text()).replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe('source,visitors,visits,pageviews,events,unbounces,duration,bounce_rate,views_per_visit,visit_seconds');
    expect(lines.slice(1).map((l) => l.split(',').slice(0, 2).join(','))).toEqual(['Google,1', 'newsletter,1']);

    expect((await app.request(`${API}/sites/${site.id}/breakdown/shoe-size`)).status).toBe(404);
    expect((await app.request(`${API}/sites/${site.id}/breakdown/page?cursor=zzz`)).status).toBe(400);
  });

  it('gives goals with conversion rates, event properties and who is on the site now', async () => {
    const { app, site } = await withTraffic();
    const goal = (await (await app.request(`${API}/sites/${site.id}/goals`, { json: { name: 'Signed up', kind: 'event', match: 'Signup' } })).json()) as { id: string };
    const conv = (await (await app.request(`${API}/sites/${site.id}/conversions?period=today`)).json()) as { items: unknown[] };
    expect(conv.items).toEqual([{ goal: { id: goal.id, name: 'Signed up', kind: 'event', match: 'Signup' }, visitors: 1, completions: 1, conversion_rate: 0.5 }]);
    const props = (await (await app.request(`${API}/sites/${site.id}/events/Signup/props?period=today`)).json()) as { items: unknown[] };
    expect(props.items).toEqual([{ key: 'plan', value: 'Pro', events: 1, visitors: 1 }]);
    const now = (await (await app.request(`${API}/sites/${site.id}/live`)).json()) as { visitors: number; first_hit_at: number; pages: unknown[] };
    expect(now).toEqual({ visitors: 2, first_hit_at: T0, pages: [{ value: '/pricing', visitors: 2 }, { value: '/', visitors: 1 }] });
    vi.setSystemTime(T0 + HOUR);
    expect(((await (await app.request(`${API}/sites/${site.id}/live`)).json()) as { visitors: number }).visitors).toBe(0);
  });

  it('exports raw hits as JSON pages or CSV, without anything that names a person', async () => {
    const { app, site } = await withTraffic();
    const first = (await (await app.request(`${API}/sites/${site.id}/hits?limit=3`)).json()) as { items: Record<string, unknown>[]; nextCursor: string };
    expect(first.items.map((h) => h.kind)).toEqual(['p', 'p', 'e']);
    expect(Object.keys(first.items[0]!)).not.toContain('org_id');
    expect(JSON.stringify(first.items)).not.toContain('198.51.100');
    const rest = (await (await app.request(`${API}/sites/${site.id}/hits?limit=3&cursor=${first.nextCursor}`)).json()) as { items: unknown[]; nextCursor: null };
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const csv = await app.request(`${API}/sites/${site.id}/hits?format=csv&limit=2`);
    expect(csv.headers.get('x-next-cursor')).toBeTruthy();
    expect((await csv.text()).trim().split(/\r?\n/)).toHaveLength(3);
  });

  it('refuses ranges and filters it cannot answer, with a code', async () => {
    const { app, site } = await withTraffic();
    const codes = async (query: string): Promise<[number, string]> => {
      const res = await app.request(`${API}/sites/${site.id}/stats?${query}`);
      return [res.status, ((await res.json()) as { code: string }).code];
    };
    expect(await codes('from=2026-03-10&to=2026-03-01')).toEqual([400, 'analytics.bad_range']);
    expect(await codes('from=2019-01-01&to=2026-03-01')).toEqual([400, 'analytics.range_too_long']);
    expect(await codes('from=2025-12-01&to=2026-03-12&country=IN')).toEqual([400, 'analytics.raw_expired']);
    expect((await app.request(`${API}/sites/${site.id}/stats?from=2025-12-01&to=2026-03-12`)).status).toBe(200);
  });

  it('lists today’s numbers for every site', async () => {
    const { app, site } = await withTraffic();
    await app.request(`${API}/sites/${site.id}/stats`);
    const res = (await (await app.request(`${API}/overview`)).json()) as { items: Record<string, unknown>[] };
    expect(res.items).toEqual([{ site: { id: site.id, name: 'example.com', domain: 'example.com', sample: false }, visitors_today: 2, pageviews_today: 3, visitors_yesterday: 0, visitors_last_7_days: [0, 0, 0, 0, 0, 0, 2] }]);
  });
});

describe('the Events API', () => {
  it('records an event from the owner’s server and joins it to the visitor’s visit', async () => {
    const { t, app, site } = await mounted();
    await beacon(app, site, {}, { who: 5 });
    vi.setSystemTime(T0 + MINUTE);
    const key = app.as({ kind: 'apikey', scopes: ['analytics:write'] });
    const res = await key.request(`${API}/sites/${site.id}/events`, { json: { name: 'Paid', url: 'https://example.com/checkout', props: { plan: 'Team', amount: 49 }, ip: '198.51.100.5', user_agent: CHROME } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: true });
    const rows = t.sqlite.prepare('SELECT kind, name, path, props, visitor FROM an_hits ORDER BY at').all() as { visitor: string; props: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'e', name: 'Paid', path: '/checkout', props: '{"plan":"Team","amount":49}' });
    expect(rows[1]!.visitor).toBe(rows[0]!.visitor);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_sessions').get()).toEqual({ n: 1 });
  });

  it('takes server page views from hosts the browser check would refuse, and says why a hit was not kept', async () => {
    const { t, app, site } = await mounted();
    const sent = await app.request(`${API}/sites/${site.id}/events`, { json: { type: 'pageview', url: 'http://localhost:3000/internal' } });
    expect(await sent.json()).toEqual({ stored: true });
    await app.request(`${API}/sites/${site.id}`, { method: 'PATCH', json: { exclude_paths: '/internal*' } });
    forgetSites(t.env);
    const skipped = await app.request(`${API}/sites/${site.id}/events`, { json: { type: 'pageview', url: 'https://example.com/internal/tools' } });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ stored: false, reason: 'excluded' });
  });

  it('asks for a name and a full address', async () => {
    const { app, site } = await mounted();
    const noName = await app.request(`${API}/sites/${site.id}/events`, { json: { url: 'https://example.com/' } });
    expect(noName.status).toBe(422);
    expect(((await noName.json()) as { fields: Record<string, string> }).fields.name).toBeTruthy();
    const noUrl = await app.request(`${API}/sites/${site.id}/events`, { json: { name: 'Paid', url: '/checkout' } });
    expect(((await noUrl.json()) as { fields: Record<string, string> }).fields.url).toBeTruthy();
    expect((await app.request(`${API}/sites/${site.id}/events`, { method: 'POST', body: 'nope' })).status).toBe(400);
  });
});

describe('goals and share links', () => {
  it('adds, lists and deletes goals', async () => {
    const { app, site } = await mounted();
    const made = await app.request(`${API}/sites/${site.id}/goals`, { json: { kind: 'page', match: '/thanks' } });
    expect(made.status).toBe(201);
    const goal = (await made.json()) as Record<string, unknown>;
    expect(goal).toMatchObject({ name: 'Visit /thanks', kind: 'page', match: '/thanks', site_id: site.id });
    expect(goal).not.toHaveProperty('emitted_count');
    const bad = await app.request(`${API}/sites/${site.id}/goals`, { json: { kind: 'page', match: 'thanks' } });
    expect(((await bad.json()) as { fields: Record<string, string> }).fields.match).toMatch(/slash/);
    expect(((await (await app.request(`${API}/sites/${site.id}/goals`)).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await app.request(`${API}/sites/${site.id}/goals/${goal.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`${API}/sites/${site.id}/goals/${goal.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('makes share links without ever showing the password hash', async () => {
    const { app, site } = await mounted();
    const made = await app.request(`${API}/sites/${site.id}/shares`, { json: { name: 'For the board', password: 'open sesame', expires_in_days: 7 } });
    expect(made.status).toBe(201);
    const share = (await made.json()) as { id: string; token: string; url: string; embed_url: string; has_password: boolean; expires_at: number };
    expect(share).toMatchObject({ name: 'For the board', has_password: true, expires_at: T0 + 7 * 24 * HOUR });
    expect(share.url).toBe(`http://localhost/a/share/${share.token}`);
    expect(share.embed_url).toBe(`http://localhost/a/share/${share.token}/embed`);
    const list = await (await app.request(`${API}/sites/${site.id}/shares`)).text();
    expect(list).not.toContain('password_hash');
    expect(list).not.toContain('org_id');
    expect((await app.request(`${API}/sites/${site.id}/shares/${share.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(((await (await app.request(`${API}/sites/${site.id}/shares`)).json()) as { items: unknown[] }).items).toEqual([]);
  });
});
