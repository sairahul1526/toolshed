import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import { setModuleEnabled } from '../../core/registry';
import analytics from './module';
import { countStatements } from './testkit';

const T0 = Date.UTC(2026, 2, 12, 9, 0, 0);
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

interface World {
  t: TestEnv;
  app: MountedModule;
  anon: MountedModule;
  site: string;
  link(form?: Record<string, string>): Promise<string>;
}

/** A workspace with the sample site, and a way to make share links for it the way a member would. */
async function setup(): Promise<World> {
  const t = createTestEnv();
  const app = await mountModule(t, analytics);
  await app.request('/app/analytics/sample', { method: 'POST', form: { on: '1' }, redirect: 'manual' });
  const row = t.sqlite.prepare('SELECT id FROM an_sites WHERE sample = 1').get() as { id: string };
  const site = `/app/analytics/sites/${row.id}`;
  return {
    t,
    app,
    anon: app.as({ kind: 'anon' }),
    site,
    async link(form = {}) {
      const res = await app.request(`${site}/shares`, { method: 'POST', form, redirect: 'manual' });
      expect(res.status).toBe(303);
      const made = t.sqlite.prepare('SELECT token FROM an_shares ORDER BY rowid DESC LIMIT 1').get() as { token: string };
      return `/a/share/${made.token}`;
    },
  };
}

const from = (ip: string) => ({ 'cf-connecting-ip': ip });

describe('a public dashboard', () => {
  it('shows the numbers to anyone with the link and offers nothing to change', async () => {
    const w = await setup();
    const link = await w.link({ name: 'For everyone' });
    const res = await w.anon.request(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const page = await res.text();
    expect(page).toContain('<title>Sample site visitors');
    expect(page).toContain('on the site now');
    for (const label of ['Visitors', 'Page views', 'Bounce rate']) expect(page).toContain(`<dt>${label}</dt>`);
    expect(page).toContain('Visitors over time');
    expect(page).toContain('United States');
    expect(page).toContain('noindex');
    // Nothing leads back into the workspace, nothing filters, and no script of ours is loaded.
    expect(page).not.toContain('/app/');
    expect(page).not.toContain('country=US');
    expect(page).not.toContain('Custom range');
    expect(page).not.toContain('/m/analytics/analytics.js');
    expect(page).not.toContain('/assets/app.js');
    expect(page).not.toContain('See all');
  });

  it('keeps the range and the open tabs in the address, and ignores filters', async () => {
    const w = await setup();
    const link = await w.link();
    const page = await (await w.anon.request(`${link}?period=30d&compare=1&v_sources=channel&country=IN&from=2020-01-01&to=2020-01-02`)).text();
    expect(page).toMatch(/<option value="30d" selected[^>]*>Last 30 days<\/option>/);
    expect(page).toContain('Period before');
    expect(page).toContain('AI assistants');
    expect(page).toContain(`${link}?period=30d&amp;compare=1`);
    expect(page).not.toContain('Country: India');
    expect(page).not.toContain('Remove filter');
  });

  it('stays light enough to load anywhere', async () => {
    const w = await setup();
    const link = await w.link();
    const page = await (await w.anon.request(`${link}?period=30d&compare=1`)).text();
    expect(new TextEncoder().encode(page).length).toBeLessThan(30_000);
    // With its three stylesheets the page is past 30 KB before compression (a third of the HTML is the kit's icon sprite), so hold the line on what crosses the wire.
    const css = ['public/assets/public.css', 'public/m/analytics/report.css', 'public/m/analytics/share.css'].map((f) => readFileSync(f, 'utf8')).join('');
    expect(gzipSync(page + css).length).toBeLessThan(12_000);
  });

  it('can sit inside a page on another site', async () => {
    const w = await setup();
    const link = await w.link();
    const res = await w.anon.request(`${link}/embed?theme=dark`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(res.headers.get('x-frame-options')).toBeNull();
    const page = await res.text();
    expect(page).toContain('an-framed');
    expect(page).toContain('data-theme="dark"');
    expect(page).toContain(`action="${link}/embed"`);
  });

  it('answers a second look from memory, then again from the database a minute later', async () => {
    const w = await setup();
    const link = await w.link();
    const first = await (await w.anon.request(link, { headers: from('198.51.100.1') })).text();
    const counts = countStatements(w.t);
    const again = await w.anon.request(link, { headers: from('198.51.100.2') });
    expect(await again.text()).toBe(first);
    // The link, the workspace switch and the site: the report itself is not worked out again.
    expect(counts.statements).toBeLessThanOrEqual(4);
    const cheap = counts.statements;

    vi.setSystemTime(T0 + MINUTE + 1);
    counts.reset();
    expect((await w.anon.request(link, { headers: from('198.51.100.2') })).status).toBe(200);
    expect(counts.statements).toBeGreaterThan(cheap);
  });

  it('slows down someone asking for many different pages', async () => {
    const w = await setup();
    const link = await w.link();
    // A public page takes no custom range, so vary what it does take: period, compare and tabs.
    const paths: string[] = [];
    for (const period of ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth', '12mo', 'year']) for (const compare of ['', '&compare=1']) for (const tab of ['page', 'entry', 'exit']) paths.push(`${link}?period=${period}${compare}&v_pages=${tab}`);
    expect(paths.length).toBeGreaterThan(31);
    let last = 200;
    for (const path of paths.slice(0, 30)) last = (await w.anon.request(path, { headers: from('198.51.100.9') })).status;
    expect(last).toBe(200);
    const blocked = await w.anon.request(paths[30] ?? link, { headers: from('198.51.100.9') });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.text()).toContain('Too many page loads');
    // Pages already worked out are still served, and other visitors are not held back.
    expect((await w.anon.request(paths[0] ?? link, { headers: from('198.51.100.9') })).status).toBe(200);
    expect((await w.anon.request(paths[30] ?? link, { headers: from('198.51.100.10') })).status).toBe(200);
  });
});

describe('a link that stops working', () => {
  it('answers 404 for a link that never existed, was deleted, or has expired', async () => {
    const w = await setup();
    expect((await w.anon.request('/a/share/nope')).status).toBe(404);
    const missing = await w.anon.request('/a/share/AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('This dashboard is not available');

    const short = await w.link({ expires_in_days: '7' });
    expect((await w.anon.request(short)).status).toBe(200);
    vi.setSystemTime(T0 + 7 * 86_400_000);
    expect((await w.anon.request(short)).status).toBe(404);
    expect((await w.anon.request(`${short}/embed`)).status).toBe(404);

    vi.setSystemTime(T0);
    const link = await w.link();
    expect((await w.anon.request(link)).status).toBe(200);
    const row = w.t.sqlite.prepare('SELECT id FROM an_shares WHERE token = ?').get(link.split('/').pop() ?? '') as { id: string };
    await w.app.request(`${w.site}/shares/${row.id}/delete`, { method: 'POST', redirect: 'manual' });
    // The page was in memory a moment ago; deleting the link still stops it at once.
    expect((await w.anon.request(link)).status).toBe(404);
  });

  it('goes dark when the workspace switches Analytics off or deletes the site', async () => {
    const w = await setup();
    const link = await w.link();
    expect((await w.anon.request(link)).status).toBe(200);
    await setModuleEnabled(w.t.env, w.t.org.id, 'analytics', false);
    expect((await w.anon.request(link)).status).toBe(404);
    expect((await w.anon.request(link, { method: 'POST', form: { password: 'x' }, redirect: 'manual' })).status).toBe(404);
    await setModuleEnabled(w.t.env, w.t.org.id, 'analytics', true);
    expect((await w.anon.request(link)).status).toBe(200);

    await w.app.request(`${w.site}/delete`, { method: 'POST', redirect: 'manual' });
    expect((await w.anon.request(link)).status).toBe(404);
  });
});

describe('a link with a password', () => {
  const unlock = (w: World, link: string, password: string, ip = '198.51.100.20') =>
    w.anon.request(link, { method: 'POST', form: { password }, headers: from(ip), redirect: 'manual' });
  const cookieOf = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  it('asks first, turns a wrong password away, and remembers the right one', async () => {
    const w = await setup();
    const link = await w.link({ name: 'Board', password: 'correct horse' });
    const ask = await w.anon.request(link);
    expect(ask.status).toBe(401);
    const form = await ask.text();
    expect(form).toContain('This dashboard needs a password');
    expect(form).toContain(`action="${link}"`);
    expect(form).not.toContain('Sample site');
    expect(form).not.toContain('<dt>Visitors</dt>');

    const wrong = await unlock(w, link, 'battery staple');
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const told = await wrong.text();
    expect(told).toContain('id="password-error"');
    expect(told).toContain('That password is not right.');
    expect(told).not.toContain('battery staple');

    const right = await unlock(w, link, 'correct horse');
    expect(right.status).toBe(303);
    expect(right.headers.get('location')).toBe(link);
    const set = right.headers.get('set-cookie') ?? '';
    expect(set).toContain('an_share=');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain(`Path=${link}`);

    const open = await w.anon.request(link, { headers: { cookie: cookieOf(right) } });
    expect(open.status).toBe(200);
    expect(await open.text()).toContain('<dt>Visitors</dt>');
  });

  it('does not let one link’s cookie, a forged one, or an old one open it', async () => {
    const w = await setup();
    const one = await w.link({ password: 'first password' });
    const two = await w.link({ password: 'second password' });
    const cookie = cookieOf(await unlock(w, one, 'first password'));
    expect((await w.anon.request(two, { headers: { cookie } })).status).toBe(401);
    expect((await w.anon.request(one, { headers: { cookie: `${cookie}x` } })).status).toBe(401);
    expect((await w.anon.request(one, { headers: { cookie: 'an_share=whatever' } })).status).toBe(401);
    expect((await w.anon.request(one, { headers: { cookie } })).status).toBe(200);
    vi.setSystemTime(T0 + 8 * 86_400_000);
    expect((await w.anon.request(one, { headers: { cookie } })).status).toBe(401);
  });

  it('never shows numbers inside another page without the password', async () => {
    const w = await setup();
    const link = await w.link({ password: 'correct horse' });
    const res = await w.anon.request(`${link}/embed`);
    expect(res.status).toBe(401);
    const page = await res.text();
    expect(page).toContain('It cannot be opened inside another page.');
    expect(page).toContain(`href="${link}"`);
    expect(page).not.toContain('<dt>Visitors</dt>');
  });

  it('stops a guesser after a few tries without locking everyone else out', async () => {
    const w = await setup();
    const link = await w.link({ password: 'correct horse' });
    for (let i = 0; i < 8; i++) expect((await unlock(w, link, `guess ${i}`)).status).toBe(403);
    const stopped = await unlock(w, link, 'correct horse');
    expect(stopped.status).toBe(429);
    expect(stopped.headers.get('set-cookie')).toBeNull();
    expect(await stopped.text()).toContain('Too many tries.');
    expect((await unlock(w, link, 'correct horse', '198.51.100.21')).status).toBe(303);
  });

  it('sends a posted form back to a link that has no password', async () => {
    const w = await setup();
    const link = await w.link();
    const res = await w.anon.request(link, { method: 'POST', form: { password: 'x' }, redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(link);
  });
});
