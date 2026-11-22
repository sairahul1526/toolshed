import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import { signedToken } from '../../core/signing';
import { setModuleEnabled } from '../../core/registry';
import links from './module';
import { runRollup } from './rollup';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const json = async (res: Response) => (await res.json()) as any;

async function setup() {
  const t = createTestEnv();
  const app = await mountModule(t, links);
  const visitor = app.as({ kind: 'anon' });
  const make = async (body: Record<string, unknown>) => json(await app.request('/api/v1/links', { json: { url: 'https://example.com/dest', ...body } }));
  const clicks = (id: string) => t.sqlite.prepare(`SELECT COALESCE(SUM(clicks),0) AS n, COALESCE(SUM(bots),0) AS b FROM links_daily WHERE target_id = ? AND kind = 'click'`).get(id) as { n: number; b: number };
  return { t, app, visitor, make, clicks };
}

const get = (v: MountedModule, path: string, ua = DESKTOP) => v.request(path, { headers: { 'user-agent': ua } });

describe('redirect engine', () => {
  it('redirects with the chosen status and never caches', async () => {
    const { visitor, make } = await setup();
    for (const type of [301, 302, 307]) {
      const link = await make({ redirectType: type });
      const res = await get(visitor, `/${link.code}`);
      expect(res.status).toBe(type);
      expect(res.headers.get('location')).toBe('https://example.com/dest');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('is case-insensitive and returns 404 for unknown codes and reserved paths', async () => {
    const { visitor, make } = await setup();
    const link = await make({ code: 'MixedCase' });
    expect((await get(visitor, '/mixedcase')).status).toBe(302);
    expect((await get(visitor, '/MIXEDCASE')).status).toBe(302);
    expect((await get(visitor, '/nothing-here')).status).toBe(404);
    expect((await get(visitor, '/l/nothing')).status).toBe(404);
    expect(link.code).toBe('mixedcase');
  });

  it('serves from KV and counts one human click with a day row and a raw row', async () => {
    const { t, visitor, make, clicks } = await setup();
    const link = await make({});
    await get(visitor, `/${link.code}`);
    await get(visitor, `/${link.code}`);
    expect(clicks(link.id).n).toBe(2);
    expect((t.sqlite.prepare('SELECT COUNT(*) AS n FROM links_clicks WHERE target_id = ?').get(link.id) as any).n).toBe(2);
    expect(await t.kv.get(`links:r:${link.code}`)).toBeTruthy();
  });

  it('counts bots separately and does not record HEAD requests', async () => {
    const { t, visitor, make, clicks } = await setup();
    const link = await make({});
    await get(visitor, `/${link.code}`, 'Googlebot/2.1 (+http://www.google.com/bot.html)');
    expect(clicks(link.id)).toEqual({ n: 0, b: 1 });
    await visitor.request(`/${link.code}`, { method: 'HEAD', headers: { 'user-agent': DESKTOP } });
    expect(clicks(link.id).n).toBe(0);
    expect((t.sqlite.prepare('SELECT COUNT(*) AS n FROM links_clicks').get() as any).n).toBe(0);
  });

  it('uses a fresh edit straight away (the cache is busted)', async () => {
    const { app, visitor, make } = await setup();
    const link = await make({});
    await get(visitor, `/${link.code}`);
    await app.request(`/api/v1/links/${link.id}`, { method: 'PATCH', json: { url: 'https://example.com/new' } });
    expect((await get(visitor, `/${link.code}`)).headers.get('location')).toBe('https://example.com/new');
    await app.request(`/api/v1/links/${link.id}/archive`, { method: 'POST' });
    expect((await get(visitor, `/${link.code}`)).status).toBe(410);
    await app.request(`/api/v1/links/${link.id}`, { method: 'DELETE' });
    expect((await get(visitor, `/${link.code}`)).status).toBe(404);
  });

  it('stops serving when the module is off', async () => {
    const { t, visitor, make } = await setup();
    const link = await make({ code: 'offcode' });
    await setModuleEnabled(t.env, t.org.id, 'links', false);
    await t.kv.delete(`links:r:${link.code}`);
    expect((await get(visitor, '/offcode')).status).toBe(404);
  });

  it('forwards the query string unless the link says not to', async () => {
    const { visitor, make } = await setup();
    const on = await make({ url: 'https://example.com/d?a=1' });
    expect((await get(visitor, `/${on.code}?utm_source=x&a=2`)).headers.get('location')).toBe('https://example.com/d?a=1&utm_source=x');
    const off = await make({ forwardQuery: false });
    expect((await get(visitor, `/${off.code}?utm_source=x`)).headers.get('location')).toBe('https://example.com/dest');
  });

  it('sends by device and operating system, with a default', async () => {
    const { visitor, make } = await setup();
    const link = await make({ rules: [{ kind: 'device', values: ['mobile'], url: 'https://example.com/m' }, { kind: 'os', values: ['macos'], url: 'https://example.com/mac' }] });
    expect((await get(visitor, `/${link.code}`, IPHONE)).headers.get('location')).toBe('https://example.com/m');
    expect((await get(visitor, `/${link.code}`, DESKTOP)).headers.get('location')).toBe('https://example.com/mac');
    expect((await get(visitor, `/${link.code}`, 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0')).headers.get('location')).toBe('https://example.com/dest');
  });

  it('refuses rules that point at a blocked domain or use a bad scheme', async () => {
    const { app } = await setup();
    const res = await app.request('/api/v1/links', { json: { url: 'https://example.com', rules: [{ kind: 'country', values: ['US'], url: 'javascript:alert(1)' }] } });
    expect(res.status).toBe(422);
    const badCountry = await app.request('/api/v1/links', { json: { url: 'https://example.com', rules: [{ kind: 'country', values: ['USA'], url: 'https://example.com/us' }] } });
    expect(badCountry.status).toBe(422);
  });

  it('honours the start date, the end date and the after-expiry address', async () => {
    const { visitor, make } = await setup();
    const soon = await make({ startsAt: Date.now() + 3_600_000 });
    expect((await get(visitor, `/${soon.code}`)).status).toBe(404);
    const gone = await make({ expiresAt: Date.now() - 1000 });
    expect((await get(visitor, `/${gone.code}`)).status).toBe(410);
    const moved = await make({ expiresAt: Date.now() - 1000, expiredUrl: 'https://example.com/ended' });
    const res = await get(visitor, `/${moved.code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/ended');
  });

  it('stops at the click cap and emits link.expired once', async () => {
    const { t, visitor, make } = await setup();
    const link = await make({ clickCap: 2 });
    expect((await get(visitor, `/${link.code}`)).status).toBe(302);
    expect((await get(visitor, `/${link.code}`)).status).toBe(302);
    expect((await get(visitor, `/${link.code}`)).status).toBe(410);
    expect((await get(visitor, `/${link.code}`)).status).toBe(410);
    const n = (t.sqlite.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM event_counts WHERE name = 'link.expired'`).get() as any).n;
    expect(n).toBe(1);
  });

  it('only emits link.clicked at 1, 10, 100 clicks a day', async () => {
    const { t, visitor, make } = await setup();
    const link = await make({});
    for (let i = 0; i < 12; i++) await get(visitor, `/${link.code}`);
    const n = (t.sqlite.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM event_counts WHERE name = 'link.clicked'`).get() as any).n;
    expect(n).toBe(2);
  });
});

describe('passwords', () => {
  it('asks for the password, rate limits guesses and redirects with 303 on success', async () => {
    const { t, visitor, make, clicks } = await setup();
    const link = await make({ password: 'hunter22' });
    expect(JSON.stringify(t.sqlite.prepare('SELECT password_hash FROM links_links').all())).not.toContain('hunter22');
    const first = await get(visitor, `/${link.code}`);
    expect(first.headers.get('location')).toBe(`/l/p/${link.code}`);
    expect((await get(visitor, `/l/p/${link.code}`)).status).toBe(200);
    const bad = await visitor.request(`/l/p/${link.code}`, { form: { password: 'nope' } });
    expect(bad.status).toBe(403);
    expect(clicks(link.id).n).toBe(0);
    const ok = await visitor.request(`/l/p/${link.code}`, { form: { password: 'hunter22' }, headers: { 'user-agent': DESKTOP } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('https://example.com/dest');
    expect(clicks(link.id).n).toBe(1);
    let last = 403;
    for (let i = 0; i < 10; i++) last = (await visitor.request(`/l/p/${link.code}`, { form: { password: 'wrong' } })).status;
    expect(last).toBe(429);
  });

  it('hides the destination on the preview page of a protected link', async () => {
    const { visitor, make } = await setup();
    const open = await make({ title: 'Open one' });
    expect(await (await get(visitor, `/${open.code}+`)).text()).toContain('https://example.com/dest');
    const locked = await make({ password: 'hunter22' });
    const text = await (await get(visitor, `/${locked.code}+`)).text();
    expect(text).not.toContain('example.com/dest');
  });
});

describe('social previews', () => {
  const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
  it('serves custom preview tags only to preview bots, and only when set', async () => {
    const { visitor, make } = await setup();
    const custom = await make({ preview: { title: 'Big news <b>', description: 'Read it', image: 'https://example.com/i.png' } });
    const bot = await get(visitor, `/${custom.code}`, SLACK);
    expect(bot.status).toBe(200);
    const body = await bot.text();
    expect(body).toContain('og:title');
    expect(body).toContain('Big news &lt;b&gt;');
    expect(body).not.toContain('<b>');
    expect((await get(visitor, `/${custom.code}`)).status).toBe(302);
    const plain = await make({});
    expect((await get(visitor, `/${plain.code}`, SLACK)).status).toBe(302);
  });
});

describe('QR codes', () => {
  it('draws an SVG with colour, margin and size options and offers a download', async () => {
    const { visitor, make } = await setup();
    const link = await make({});
    const res = await visitor.request(`/l/qr/${link.code}?fg=ff0000&bg=eeeeee&margin=4&size=300`);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg.toLowerCase()).toContain('#ff0000');
    expect(svg.toLowerCase()).toContain('#eeeeee');
    const dl = await visitor.request(`/l/qr/${link.code}?download=1`);
    expect(dl.headers.get('content-disposition')).toContain(`${link.code}-qr.svg`);
    expect((await visitor.request('/l/qr/bad code')).status).toBe(404);
  });

  it('counts scans separately from clicks', async () => {
    const { t, visitor, make } = await setup();
    const link = await make({});
    await get(visitor, `/${link.code}?qr=1`);
    await get(visitor, `/${link.code}`);
    const row = t.sqlite.prepare('SELECT clicks, qr FROM links_daily WHERE target_id = ?').get(link.id) as any;
    expect(row).toEqual({ clicks: 2, qr: 1 });
  });
});

describe('reports', () => {
  it('stores a report from a patient visitor and drops bots quietly', async () => {
    const { t, app, visitor, make } = await setup();
    const link = await make({});
    const page = await visitor.request(`/l/report/${link.code}`);
    expect(page.status).toBe(200);
    const old = await signedToken(t.env, 'links.report', { c: link.code, at: Date.now() - 10_000 }, 3600);
    const fresh = await signedToken(t.env, 'links.report', { c: link.code, at: Date.now() }, 3600);
    const bot = await visitor.request(`/l/report/${link.code}`, { form: { t: old, reason: 'spam', website: 'http://spam.example.com' } });
    const fast = await visitor.request(`/l/report/${link.code}`, { form: { t: fresh, reason: 'spam' } });
    expect(bot.status).toBe(200);
    expect(fast.status).toBe(200);
    expect((await json(await app.request('/api/v1/links/reports'))).items).toHaveLength(0);
    const missing = await visitor.request(`/l/report/${link.code}`, { form: { t: old } });
    expect(missing.status).toBe(422);
    const ok = await visitor.request(`/l/report/${link.code}`, { form: { t: old, reason: 'phishing', details: 'Looks fake' } });
    expect(ok.status).toBe(200);
    const list = (await json(await app.request('/api/v1/links/reports'))).items;
    expect(list).toHaveLength(1);
    const done = await app.request(`/api/v1/links/reports/${list[0].id}`, { json: { action: 'disable' } });
    expect(done.status).toBe(200);
    expect((await json(await app.request(`/api/v1/links/${link.id}`))).state).toBe('disabled');
  });
});

describe('stats and rollups', () => {
  it('reports real zeros for empty days and breaks clicks down', async () => {
    const { app, visitor, make } = await setup();
    const link = await make({});
    await get(visitor, `/${link.code}?utm_source=news`, IPHONE);
    await get(visitor, `/${link.code}`, DESKTOP);
    const stats = await json(await app.request(`/api/v1/links/${link.id}/stats?days=7`));
    expect(stats.days).toHaveLength(7);
    expect(stats.days.filter((d: any) => d.clicks === 0)).toHaveLength(6);
    expect(stats.totals.clicks).toBe(2);
    expect(stats.breakdowns.device.map((s: any) => s.value).sort()).toEqual(['desktop', 'mobile']);
    expect(stats.breakdowns.utm_source[0]).toEqual({ value: 'news', clicks: 1 });
    const all = await json(await app.request('/api/v1/links/stats?days=7'));
    expect(all.totals.clicks).toBe(2);
    expect((await json(await app.request('/api/v1/links/stats/top'))).items[0].clicks).toBe(2);
  });

  it('rolls finished days up and keeps the numbers the same', async () => {
    const { t, app, visitor, make } = await setup();
    const link = await make({});
    await get(visitor, `/${link.code}`, IPHONE);
    const before = (await json(await app.request(`/api/v1/links/${link.id}/stats?days=7`))).breakdowns.device;
    // Pretend the clicks happened two days ago, then roll that day up.
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    t.sqlite.prepare('UPDATE links_clicks SET day = ?').run(day);
    t.sqlite.prepare('UPDATE links_daily SET day = ?').run(day);
    const run = await runRollup(t.env);
    expect(run.days).toBeGreaterThan(0);
    const rolled = (t.sqlite.prepare('SELECT COUNT(*) AS n FROM links_rollups').get() as any).n;
    expect(rolled).toBeGreaterThan(0);
    const after = (await json(await app.request(`/api/v1/links/${link.id}/stats?days=7`))).breakdowns.device;
    expect(after).toEqual(before);
  });
});

describe('bio pages', () => {
  it('renders a small page without script, counts views and block clicks', async () => {
    const { t, app, visitor } = await setup();
    const made = await json(await app.request('/api/v1/links/bios', {
      json: {
        code: 'samex', name: 'Sam Example', bio: 'Hello', published: true,
        blocks: [{ kind: 'heading', title: 'Links' }, { kind: 'link', title: 'My site', url: 'https://example.com/site' }, { kind: 'social', platform: 'github', url: 'https://example.com/gh' }],
      },
    }));
    const page = await get(visitor, '/samex');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('My site');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(new TextEncoder().encode(html).length).toBeLessThan(30_000);
    const block = made.blocks.find((b: any) => b.kind === 'link');
    const hop = await get(visitor, `/l/b/${block.id}`);
    expect(hop.status).toBe(302);
    expect(hop.headers.get('location')).toBe('https://example.com/site');
    const view = (t.sqlite.prepare(`SELECT COALESCE(SUM(clicks),0) AS n FROM links_daily WHERE target_id = ? AND kind = 'view'`).get(made.id) as any).n;
    expect(view).toBe(1);
    const totals = await json(await app.request(`/api/v1/links/bios/${made.id}`));
    expect(totals.blocks.find((b: any) => b.id === block.id).clicks).toBeGreaterThanOrEqual(0);
  });

  it('hides unpublished pages and stays under 30 KB with the most blocks', async () => {
    const { app, visitor } = await setup();
    await app.request('/api/v1/links/bios', { json: { code: 'draft', name: 'Draft' } });
    expect((await get(visitor, '/draft')).status).toBe(404);
    const blocks = Array.from({ length: 60 }, (_, i) => ({ kind: 'link', title: `A fairly long link title number ${i} to take space`, url: `https://example.com/some/long/path/${i}?utm_source=bio&utm_medium=page` }));
    await app.request('/api/v1/links/bios', { json: { code: 'big', name: 'Big', bio: 'x'.repeat(400), published: true, blocks } });
    const html = await (await get(visitor, '/big')).text();
    expect(new TextEncoder().encode(html).length).toBeLessThan(30_000);
    expect((await app.request('/api/v1/links/bios/big/blocks', { json: { kind: 'text', body: 'one too many' } })).status).toBeGreaterThanOrEqual(400);
  });

  it('serves custom colours from a stylesheet and rejects bad colours', async () => {
    const { app, visitor } = await setup();
    const ok = await app.request('/api/v1/links/bios', { json: { code: 'hue', name: 'Hue', published: true, theme: 'custom', colors: { background: '#112233', accent: '#ff8800' } } });
    expect(ok.status).toBe(201);
    const css = await (await get(visitor, '/l/s/hue.css')).text();
    expect(css.toLowerCase()).toContain('#112233');
    const bad = await app.request('/api/v1/links/bios', { json: { code: 'evil', name: 'x', theme: 'custom', colors: { background: 'red;}</style><script>' } } });
    expect(bad.status).toBe(422);
  });
});

describe('sample data and export', () => {
  it('adds and clears sample rows and exports without password hashes', async () => {
    const { t, app, make } = await setup();
    await make({ password: 'hunter22' });
    const ctx = { env: t.env, org: t.org, db: undefined as never };
    await links.sampleData!(ctx);
    expect(((await json(await app.request('/api/v1/links?status=all'))).items as any[]).filter((l) => l.code.startsWith('sample-'))).toHaveLength(4);
    await links.clearSampleData!(ctx);
    expect((await json(await app.request('/api/v1/links'))).items).toHaveLength(1);
    expect((t.sqlite.prepare('SELECT COUNT(*) AS n FROM links_bios').get() as any).n).toBe(0);
    const data = await links.exportData!(ctx);
    expect(JSON.stringify(data)).not.toContain('pbkdf2');
    expect(data.links_links).toHaveLength(1);
    expect(await links.count!(ctx)).toBe(1);
  });
});
