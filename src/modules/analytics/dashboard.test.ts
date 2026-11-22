import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import analytics from './module';
import { CHROME } from './testkit';

const BASE = '/app/analytics';
const T0 = Date.UTC(2026, 2, 12, 9, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(): Promise<{ t: TestEnv; app: MountedModule; viewer: MountedModule; member: MountedModule }> {
  const t = createTestEnv();
  const app = await mountModule(t, analytics);
  return { t, app, viewer: app.as({ role: 'viewer' }), member: app.as({ role: 'member' }) };
}

const html = async (res: Response): Promise<string> => res.text();
const post = (app: MountedModule, path: string, form: Record<string, string> = {}) => app.request(path, { method: 'POST', form, redirect: 'manual' });

async function addSite(app: MountedModule, domain = 'example.com'): Promise<string> {
  const res = await post(app, `${BASE}/new`, { domain, timezone: 'UTC' });
  expect(res.status).toBe(303);
  const where = res.headers.get('location') ?? '';
  expect(where).toMatch(/^\/app\/analytics\/sites\/site_[a-z0-9]+\/setup$/i);
  return where.replace(/\/setup$/, '');
}

async function addSample(app: MountedModule, t: TestEnv): Promise<string> {
  expect((await post(app, `${BASE}/sample`, { on: '1' })).status).toBe(303);
  const row = t.sqlite.prepare('SELECT id FROM an_sites WHERE sample = 1').get() as { id: string };
  return `${BASE}/sites/${row.id}`;
}

function keyOf(t: TestEnv): string {
  return (t.sqlite.prepare('SELECT key FROM an_sites WHERE sample = 0').get() as { key: string }).key;
}

function beacon(app: MountedModule, key: string, body: Record<string, unknown> = {}): Promise<Response> {
  return app.as({ kind: 'anon' }).request('/a/e', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': CHROME, 'cf-connecting-ip': '198.51.100.7', origin: 'https://example.com' },
    body: JSON.stringify({ k: key, t: 'p', u: 'https://example.com/pricing', ...body }),
  });
}

describe('all sites', () => {
  it('starts with one next step, and viewers are told who can take it', async () => {
    const { app, viewer } = await setup();
    const first = await html(await app.request(BASE));
    expect(first).toContain('No sites yet');
    expect(first).toContain(`href="${BASE}/new"`);
    expect(first).toContain('Add the sample site');
    expect(first).toContain('/m/analytics/analytics.js');

    const looking = await html(await viewer.request(BASE));
    expect(looking).toContain('Ask a member of this workspace');
    expect(looking).not.toContain(`href="${BASE}/new"`);
    expect(looking).not.toContain('Add the sample site');
  });

  it('lists every site with today’s numbers and marks the sample', async () => {
    const { t, app } = await setup();
    await addSite(app);
    await addSample(app, t);
    const page = await html(await app.request(BASE));
    expect(page).toContain('Sample site');
    expect(page).toContain('example.com');
    expect(page).toContain('Waiting for the first page view');
    expect(page).toContain('The sample site is on');
    expect(page).toContain('Visitors today');

    expect((await post(app, `${BASE}/sample`, { on: '0' })).status).toBe(303);
    const after = await html(await app.request(BASE));
    expect(after).not.toContain('Sample site');
    expect(after).toContain('example.com');
  });
});

describe('first run', () => {
  it('shows what is wrong with a domain next to the field and keeps what was typed', async () => {
    const { app } = await setup();
    const res = await post(app, `${BASE}/new`, { domain: 'not a domain', name: 'My shop', timezone: 'UTC' });
    expect(res.status).toBe(422);
    const page = await html(res);
    expect(page).toContain('id="domain-error"');
    expect(page).toContain('Enter a domain like example.com');
    expect(page).toContain('value="My shop"');

    await addSite(app);
    const twice = await post(app, `${BASE}/new`, { domain: 'https://www.example.com/', timezone: 'UTC' });
    expect(twice.status).toBe(422);
    expect(await html(twice)).toContain('already tracks that domain');
  });

  it('goes from the form to the line to paste, waits, then says it works', async () => {
    const { t, app } = await setup();
    const site = await addSite(app);
    const waiting = await html(await app.request(`${site}/setup`));
    expect(waiting).toContain('data-site=');
    expect(waiting).toContain('/m/analytics/t.js');
    expect(waiting).toContain('Waiting for the first page view');
    expect(waiting).toContain(`data-an-wait="${site}/live.json"`);
    expect(await (await app.request(`${site}/live.json`)).json()).toEqual({ visitors: 0, first_hit_at: null });

    const empty = await html(await app.request(site));
    expect(empty).toContain('Waiting for the first page view');
    expect(empty).toContain(`${site}/setup`);

    expect((await beacon(app, keyOf(t))).status).toBe(202);
    const live = (await (await app.request(`${site}/live.json`)).json()) as { visitors: number; first_hit_at: number };
    expect(live.visitors).toBe(1);
    expect(live.first_hit_at).toBeGreaterThanOrEqual(T0);
    expect(live.first_hit_at).toBeLessThan(T0 + 1000);
    expect(await html(await app.request(`${site}/setup`))).toContain('It works');

    // Seconds later, well inside the minute the totals may lag by, the dashboard already counts the visit.
    vi.setSystemTime(T0 + 5000);
    const dash = await html(await app.request(site));
    expect(dash).toContain('on the site now');
    expect(dash).toContain('/pricing');
    expect(dash).toMatch(/<dt>Visitors<\/dt><dd><b>1<\/b>/);
  });

  it('answers 404 for a site that is not there', async () => {
    const { app } = await setup();
    expect((await app.request(`${BASE}/sites/site_nope`)).status).toBe(404);
    expect((await app.request(`${BASE}/sites/site_nope/settings`)).status).toBe(404);
  });
});

describe('site dashboard', () => {
  it('draws the numbers, the chart and every list, with a filter link on each row', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const page = await html(await app.request(site));
    for (const label of ['Visitors', 'Visits', 'Page views', 'Views per visit', 'Bounce rate', 'Visit duration']) expect(page).toContain(`<dt>${label}</dt>`);
    expect(page).toContain('Visitors over time');
    for (const title of ['Top pages', 'Sources', 'Countries', 'Devices', 'Goals', 'Events']) expect(page).toContain(title);
    expect(page).toContain('Channels');
    expect(page).toContain(`href="${site}?country=US"`);
    expect(page).toContain('United States');
    expect(page).toContain('each day’s visitors added up');
    expect(page).toContain('Signed up');
    expect(page).toContain(`${site}/breakdown/page`);
  });

  it('keeps filters, tabs, the range and compare in the address', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const page = await html(await app.request(`${site}?period=7d&compare=1&country=US&v_sources=channel`));
    expect(page).toContain('Country: United States');
    expect(page).toContain('Remove filter Country: United States');
    expect(page).toContain(`href="${site}?compare=1&amp;v_sources=channel"`);
    expect(page).toContain('Period before');
    expect(page).toContain('AI assistants');
    expect(page).toMatch(/<option value="7d" selected[^>]*>Last 7 days<\/option>/);
    // A row link adds its filter to the ones already set.
    expect(page).toMatch(/href="[^"]*compare=1&amp;channel=[^"]*country=US[^"]*"/);

    // The month before is past the 30 days of detail kept for filters: the numbers stay, the comparison goes, and the page says so.
    const older = await html(await app.request(`${site}?period=30d&compare=1&country=US`));
    expect(older).toContain('<dt>Visitors</dt>');
    expect(older).not.toContain('Period before');
    expect(older).toContain('nothing to compare with');
  });

  it('falls back to the default range and says why when the dates make no sense', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const res = await app.request(`${site}?from=2026-03-10&to=2026-03-01`);
    expect(res.status).toBe(200);
    const page = await html(res);
    expect(page).toContain('Pick a start day that is not after the end day.');
    expect(page).toMatch(/<details class="an-custom" open/);
  });

  it('says so when a filtered range is older than the detail that is kept', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const page = await html(await app.request(`${site}?from=2025-01-01&to=2025-01-31&country=US`));
    expect(page).toContain('an-blocked');
    expect(page).toContain('Clear filters');
  });

  it('opens a full list, pages through it and downloads it', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const list = await html(await app.request(`${site}/breakdown/page?period=30d`));
    expect(list).toContain('Page list');
    expect(list).toContain('/pricing');
    expect(list).toContain('Download CSV');
    expect((await app.request(`${site}/breakdown/nonsense`)).status).toBe(404);

    const csv = await app.request(`${site}/breakdown/country?period=30d&format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = (await csv.text()).trim().split('\n');
    expect(lines[0]).toContain('country,visitors');
    expect(lines.some((l) => l.startsWith('US,'))).toBe(true);

    const series = await app.request(`${site}/timeseries.csv?period=7d`);
    expect(series.headers.get('content-type')).toContain('text/csv');
    expect((await series.text()).trim().split('\n')).toHaveLength(8);
  });

  it('shows the properties sent with an event', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const page = await html(await app.request(`${site}/events/Signup?period=30d`));
    expect(page).toContain('plan');
    expect(page).toContain('Free');
  });

  it('exports reports and every hit in parts', async () => {
    const { t, app } = await setup();
    const site = await addSample(app, t);
    const page = await html(await app.request(`${site}/export`));
    expect(page).toContain('Reports as CSV');
    expect(page).toContain('Download part 1');
    expect(page).toContain(`${site}/hits.csv`);
    const hits = await app.request(`${site}/hits.csv`);
    expect(hits.headers.get('content-type')).toContain('text/csv');
    const rows = (await hits.text()).trim().split('\n');
    expect(rows[0]).toContain('at,id,day');
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.length).toBeLessThanOrEqual(5001);
  });
});

describe('goals', () => {
  it('starts empty, refuses a path without a slash, then counts the goal', async () => {
    const { t, app } = await setup();
    const site = await addSite(app);
    await beacon(app, keyOf(t));
    const empty = await html(await app.request(`${site}/goals`));
    expect(empty).toContain('No goals yet');
    expect(empty).toContain('Add a goal');

    const bad = await post(app, `${site}/goals`, { kind: 'page', match: 'pricing' });
    expect(bad.status).toBe(422);
    const again = await html(bad);
    expect(again).toContain('id="match-error"');
    expect(again).toContain('value="pricing"');

    const ok = await post(app, `${site}/goals`, { kind: 'page', match: '/pricing', name: 'Saw pricing' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`${site}/goals`);
    const listed = await html(await app.request(`${site}/goals`));
    expect(listed).toContain('Saw pricing');
    expect(listed).toContain('100%');

    const goal = t.sqlite.prepare('SELECT id FROM an_goals').get() as { id: string };
    expect((await post(app, `${site}/goals/${goal.id}/delete`)).status).toBe(303);
    expect(await html(await app.request(`${site}/goals`))).toContain('No goals yet');
  });

  it('lets a viewer look and nothing else', async () => {
    const { t, app, viewer } = await setup();
    const site = await addSample(app, t);
    const page = await html(await viewer.request(`${site}/goals`));
    expect(page).toContain('Signed up');
    expect(page).not.toContain('Add a goal');
    expect(page).not.toContain('Delete this goal?');
    expect((await post(viewer, `${site}/goals`, { kind: 'event', match: 'Signup2' })).status).toBe(403);
    expect((await post(viewer, `${BASE}/new`, { domain: 'other.example.com' })).status).toBe(403);
    expect((await post(viewer, `${BASE}/sample`, { on: '0' })).status).toBe(403);
  });
});

describe('share links', () => {
  it('makes a link, shows how to embed it, and deletes it', async () => {
    const { t, app, viewer } = await setup();
    const site = await addSite(app);
    expect(await html(await app.request(`${site}/share`))).toContain('No share links yet');

    expect((await post(app, `${site}/shares`, { name: 'For the team' })).status).toBe(303);
    expect((await post(app, `${site}/shares`, { name: 'Locked', password: 'correct horse', expires_in_days: '7' })).status).toBe(303);
    const page = await html(await app.request(`${site}/share`));
    expect(page).toContain('For the team');
    expect(page).toContain('http://localhost/a/share/');
    expect(page).toContain('/embed');
    expect(page).toContain('Locked');
    expect(page).toContain('cannot be shown inside another page');
    expect(page).not.toContain('correct horse');

    const looking = await html(await viewer.request(`${site}/share`));
    expect(looking).toContain('For the team');
    expect(looking).not.toContain('Make a share link');
    expect(looking).not.toContain('Delete this share link?');

    const bad = await post(app, `${site}/shares`, { expires_in_days: '0' });
    expect(bad.status).toBe(422);
    expect(await html(bad)).toContain('id="expires_in_days-error"');

    const rows = t.sqlite.prepare('SELECT id FROM an_shares').all() as { id: string }[];
    expect(rows).toHaveLength(2);
    expect((await post(app, `${site}/shares/${rows[0]?.id}/delete`)).status).toBe(303);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_shares').get()).toEqual({ n: 1 });
  });
});

describe('settings', () => {
  it('shows data health and saves every field, with unticked boxes turned off', async () => {
    const { t, app } = await setup();
    const site = await addSite(app);
    await beacon(app, keyOf(t));
    await beacon(app, keyOf(t), { u: 'http://localhost:3000/' });
    const page = await html(await app.request(`${site}/settings`));
    expect(page).toContain('Data health');
    expect(page).toContain('Stored today');
    expect(page).toContain('20,000 hits');
    expect(page).toContain('Visits from localhost');
    expect(page).toContain('Delete this site');

    const res = await post(app, `${site}/settings`, {
      name: 'Shop', domain: 'example.com', domains: '*.example.org\nshop.example.net', timezone: 'Asia/Kolkata', retention_days: '90',
      engagement: '0', respect_dnt: '1', daily_cap: '5000', exclude_paths: '/admin/*', exclude_ips: '203.0.113.9', pinned: '1', weekly_report: '1',
      report_emails: 'owner@example.com', spike_threshold: '50',
    });
    expect(res.status).toBe(303);
    const row = t.sqlite.prepare('SELECT * FROM an_sites').get() as Record<string, unknown>;
    expect(row).toMatchObject({ name: 'Shop', timezone: 'Asia/Kolkata', retention_days: 90, engagement: 0, respect_dnt: 1, daily_cap: 5000, pinned: 1, weekly_report: 1, spike_threshold: 50 });
    expect(JSON.parse(String(row.domains))).toEqual(['*.example.org', 'shop.example.net']);
    const saved = await html(await app.request(`${site}/settings`));
    expect(saved).toContain('owner@example.com');
    expect(saved).toContain('/admin/*');
  });

  it('puts a mistake next to its field and keeps the rest', async () => {
    const { app } = await setup();
    const site = await addSite(app);
    const res = await post(app, `${site}/settings`, { name: 'Shop', domain: 'example.com', timezone: 'UTC', daily_cap: '5', report_emails: 'nope' });
    expect(res.status).toBe(422);
    const page = await html(res);
    expect(page).toContain('id="daily_cap-error"');
    expect(page).toContain('Enter 100 or more.');
    expect(page).toContain('value="Shop"');
  });

  it('says when email cannot be sent yet', async () => {
    const t = createTestEnv({ ENVIRONMENT: 'production' });
    const app = await mountModule(t, analytics);
    const site = await addSite(app);
    const page = await html(await app.request(`${site}/settings`));
    expect(page).toContain('Email is not set up');
    expect(page).toContain('href="/app/email"');
  });

  it('keeps changes for members and deleting for admins', async () => {
    const { t, app, viewer, member } = await setup();
    const site = await addSite(app);
    const looking = await html(await viewer.request(`${site}/settings`));
    expect(looking).toContain('You can look, not change');
    expect(looking).not.toContain('Save settings');
    expect(looking).not.toContain('Delete this site');
    expect((await post(viewer, `${site}/settings`, { name: 'x' })).status).toBe(403);

    const working = await html(await member.request(`${site}/settings`));
    expect(working).toContain('Save settings');
    expect(working).not.toContain('Delete this site');
    expect((await post(member, `${site}/delete`)).status).toBe(403);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_sites').get()).toEqual({ n: 1 });

    const gone = await post(app, `${site}/delete`);
    expect(gone.status).toBe(303);
    expect(gone.headers.get('location')).toBe(BASE);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_sites').get()).toEqual({ n: 0 });
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.deleted'").get()).toEqual({ n: 1 });
  });
});
