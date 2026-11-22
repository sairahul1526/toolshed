import { describe, expect, it } from 'vitest';
import { flushDrops } from './ingest';
import { rollupSite } from './rollup';
import { createGoal, updateSite } from './sites';
import { breakdown, derive, eventProps, health, live, rawHits, readFilters, report, resolveRange, siteCards } from './stats';
import { makeKit, type Kit } from './testkit';
import { HOUR, MINUTE } from './time';

const D1 = Date.UTC(2026, 2, 11);
const D2 = Date.UTC(2026, 2, 12);
const NOW = D2 + 12 * HOUR;

/**
 * Two days of hand-written traffic:
 *   11 Mar  visitor 1 from Google: /, /pricing, a Signup event.  visitor 2: / (a bounce).
 *   12 Mar  visitor 3: /docs/install (a bounce).  visitor 1 again: / (a bounce).
 */
async function seededSite(timezone = 'UTC'): Promise<Kit> {
  const k = await makeKit({ timezone }, D1);
  await k.hit(D1 + 10 * HOUR, { who: 1, url: 'https://example.com/', referrer: 'https://www.google.com/' });
  await k.hit(D1 + 10 * HOUR + 5 * MINUTE, { who: 1, url: 'https://example.com/pricing' });
  await k.hit(D1 + 10 * HOUR + 6 * MINUTE, { who: 1, kind: 'e', name: 'Signup', url: 'https://example.com/pricing', props: { plan: 'Pro' } });
  await k.hit(D1 + 11 * HOUR, { who: 2, url: 'https://example.com/' });
  await k.hit(D2 + 9 * HOUR, { who: 3, url: 'https://example.com/docs/install' });
  await k.hit(D2 + 9 * HOUR + 30 * MINUTE, { who: 1, url: 'https://example.com/' });
  await rollupSite(k.t.env, await k.fresh(), NOW);
  return k;
}

describe('date ranges', () => {
  const site = { timezone: 'UTC' };

  it('turns a named period into days of the site', () => {
    expect(resolveRange(site, {}, NOW)).toMatchObject({ period: '7d', from: '2026-03-06', to: '2026-03-12', prevFrom: '2026-02-27', prevTo: '2026-03-05', bucket: 'day' });
    expect(resolveRange(site, { period: 'today' }, NOW)).toMatchObject({ from: '2026-03-12', to: '2026-03-12', prevFrom: '2026-03-11', bucket: 'hour' });
    expect(resolveRange(site, { period: 'yesterday' }, NOW)).toMatchObject({ from: '2026-03-11', to: '2026-03-11' });
    expect(resolveRange(site, { period: 'month' }, NOW)).toMatchObject({ from: '2026-03-01', to: '2026-03-12' });
    expect(resolveRange(site, { period: 'lastmonth' }, NOW)).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveRange(site, { period: '12mo' }, NOW)).toMatchObject({ from: '2025-04-01', to: '2026-03-12', bucket: 'month' });
    expect(resolveRange(site, { period: 'year' }, NOW)).toMatchObject({ from: '2026-01-01', bucket: 'day' });
  });

  it('uses the site’s own today, which may not be the server’s', () => {
    // 12:00 UTC on the 12th is already 02:00 on the 13th in Kiritimati, and 03:00 UTC on the 12th is still the evening of the 11th in Los Angeles.
    expect(resolveRange({ timezone: 'Pacific/Kiritimati' }, { period: 'today' }, NOW).from).toBe('2026-03-13');
    expect(resolveRange({ timezone: 'America/Los_Angeles' }, { period: 'today' }, D2 + 3 * HOUR).from).toBe('2026-03-11');
  });

  it('takes a custom range and refuses one that makes no sense', () => {
    expect(resolveRange(site, { from: '2026-01-05', to: '2026-01-20' }, NOW)).toMatchObject({ period: 'custom', from: '2026-01-05', to: '2026-01-20', prevFrom: '2025-12-20', prevTo: '2026-01-04', label: '5 Jan 2026 to 20 Jan 2026' });
    expect(() => resolveRange(site, { from: '2026-02-01', to: '2026-01-01' }, NOW)).toThrowError(/not after the end day/i);
    expect(() => resolveRange(site, { from: '2020-01-01', to: '2026-01-01' }, NOW)).toThrowError(/long|years/i);
    // Nonsense falls back to the default instead of failing the page.
    expect(resolveRange(site, { period: 'custom', from: 'soon', to: 'later' }, NOW).period).toBe('7d');
  });

  it('keeps only known filters, trimmed and capped', () => {
    const q: Record<string, string> = { page: ' /pricing ', country: 'IN', nope: 'x', source: '', device: 'a'.repeat(400) };
    const filters = readFilters((key) => q[key]);
    expect(filters).toEqual({ page: '/pricing', country: 'IN', device: 'a'.repeat(300) });
  });
});

describe('the report', () => {
  it('adds up daily totals and works out the ratios', async () => {
    const k = await seededSite();
    const site = await k.fresh();
    const res = await report(k.ctx.db, site, resolveRange(site, {}, NOW), {}, { dims: ['page', 'source', 'channel', 'entry', 'exit', 'event'] });
    expect(res.mode).toBe('totals');
    // Visitor 1 came on both days and counts on both: a range is the sum of its days.
    expect(res.totals).toMatchObject({ visitors: 4, visits: 4, pageviews: 5, events: 1, unbounces: 1 });
    expect(res.totals.duration).toBe(6 * MINUTE);
    expect(derive(res.totals)).toEqual({ bounceRate: 0.75, viewsPerVisit: 1.25, visitSeconds: 90 });
    expect(res.panels.page!.map((r) => [r.value, r.visitors, r.pageviews])).toEqual([['/', 3, 3], ['/docs/install', 1, 1], ['/pricing', 1, 1]]);
    expect(res.panels.source!.map((r) => [r.value, r.visitors])).toEqual([['Direct / None', 3], ['Google', 1]]);
    expect(res.panels.channel!.map((r) => r.value)).toEqual(['Direct', 'Search']);
    expect(res.panels.entry!.map((r) => [r.value, r.visits])).toEqual([['/', 3], ['/docs/install', 1]]);
    expect(res.panels.exit!.map((r) => [r.value, r.visits])).toEqual([['/', 2], ['/docs/install', 1], ['/pricing', 1]]);
    expect(res.panels.event!.map((r) => [r.value, r.events, r.visitors])).toEqual([['Signup', 1, 1]]);
    expect(res.series.labels).toHaveLength(7);
    expect(res.series.visitors.slice(-2)).toEqual([2, 2]);
    expect(res.series.pageviews.slice(-2)).toEqual([3, 2]);
  });

  it('shows a single day by the hour and compares it with the day before', async () => {
    const k = await seededSite();
    const site = await k.fresh();
    const res = await report(k.ctx.db, site, resolveRange(site, { period: 'today' }, NOW), {}, { dims: [], compare: true });
    expect(res.totals.visitors).toBe(2);
    expect(res.prev).toMatchObject({ visitors: 2, pageviews: 3, events: 1 });
    expect(res.series.labels).toHaveLength(24);
    expect(res.series.labels[9]).toBe('09:00');
    expect(res.series.pageviews[9]).toBe(2);
    expect(res.series.prevVisitors![10]).toBe(1);
    expect(res.series.prevVisitors![11]).toBe(1);
  });

  it('puts hits on the day and hour of the site’s time zone', async () => {
    // India is five and a half hours ahead: 10:00 UTC on 11 March is 15:30 there, still the 11th.
    const k = await seededSite('Asia/Kolkata');
    const site = await k.fresh();
    const res = await report(k.ctx.db, site, resolveRange(site, { period: 'yesterday' }, NOW), {}, { dims: [] });
    expect(res.range.from).toBe('2026-03-11');
    expect(res.totals.pageviews).toBe(3);
    expect(res.series.pageviews[15]).toBe(2);
    expect(res.series.pageviews[16]).toBe(1);
  });

  it('counts goals from the totals, with a conversion rate', async () => {
    const k = await seededSite();
    const signup = await createGoal(k.ctx, k.site.id, { kind: 'event', match: 'Signup' });
    const docs = await createGoal(k.ctx, k.site.id, { name: 'Read the docs', kind: 'page', match: '/docs*' });
    const never = await createGoal(k.ctx, k.site.id, { kind: 'page', match: '/thanks' });
    const site = await k.fresh();
    const range = resolveRange(site, {}, NOW);
    const res = await report(k.ctx.db, site, range, {}, { dims: [], goals: [signup, docs, never] });
    expect(res.goals.map((g) => [g.goal.name, g.uniques, g.total, g.rate])).toEqual([['Signup', 1, 1, 0.25], ['Read the docs', 1, 1, 0.25], ['Visit /thanks', 0, 0, 0]]);

    // The same goals counted from raw hits, for visitors from one source.
    const google = await report(k.ctx.db, site, range, { source: 'Google' }, { dims: [], goals: [signup, docs] });
    expect(google.mode).toBe('raw');
    expect(google.goals.map((g) => [g.uniques, g.rate])).toEqual([[1, 1], [0, 0]]);

    // Filtering by a goal is filtering by what it counts.
    const byGoal = await report(k.ctx.db, site, range, { goal: docs.id }, { dims: ['page'], goals: [signup, docs] });
    expect(byGoal.partial).toBe(true);
    expect(byGoal.totals).toMatchObject({ visitors: 1, pageviews: 1 });
    expect(byGoal.panels.page!.map((r) => r.value)).toEqual(['/docs/install']);
  });

  it('says so when a filtered view reaches past the raw hits that are kept', async () => {
    const k = await seededSite();
    await updateSite(k.ctx, k.site.id, { retention_days: 7 });
    const site = await k.fresh();
    const old = resolveRange(site, { from: '2026-02-01', to: '2026-03-12' }, NOW);
    expect((await report(k.ctx.db, site, old, { country: 'IN' }, { dims: [] })).blocked).toBe('expired');
    expect((await breakdown(k.ctx.db, site, old, {}, 'city')).blocked).toBe('expired');
    expect((await eventProps(k.ctx.db, site, old, 'Signup')).blocked).toBe('expired');
    // Totals have no such limit.
    const totals = await report(k.ctx.db, site, old, {}, { dims: [] });
    expect(totals.blocked).toBeNull();
    expect(totals.totals.visitors).toBe(4);
    // Comparing with a period that is too old drops the comparison, not the view.
    const week = await report(k.ctx.db, site, resolveRange(site, {}, NOW), { source: 'Google' }, { dims: [], compare: true });
    expect(week.blocked).toBeNull();
    expect(week.prev).toBeNull();
    expect(week.totals.visitors).toBe(1);
  });
});

describe('breakdowns, a page at a time', () => {
  it('pages through a stored breakdown and a raw one the same way', async () => {
    const k = await seededSite();
    const site = await k.fresh();
    const range = resolveRange(site, {}, NOW);
    for (const filters of [{}, { device: 'desktop' }]) {
      const first = await breakdown(k.ctx.db, site, range, filters, 'page', { limit: 2 });
      expect(first.items.map((r) => r.value)).toEqual(['/', '/docs/install']);
      expect(first.nextCursor).toBeTruthy();
      const second = await breakdown(k.ctx.db, site, range, filters, 'page', { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((r) => r.value)).toEqual(['/pricing']);
      expect(second.nextCursor).toBeNull();
      expect(first.mode).toBe(Object.keys(filters).length ? 'raw' : 'totals');
    }
    await expect(breakdown(k.ctx.db, site, range, {}, 'page', { cursor: 'not-a-marker' })).rejects.toThrowError(/page marker/);
  });

  it('lists the properties sent with an event', async () => {
    const k = await seededSite();
    const site = await k.fresh();
    await k.hit(D2 + 10 * HOUR, { who: 3, kind: 'e', name: 'Signup', url: 'https://example.com/pricing', props: { plan: 'Free', seats: 3 } });
    await k.hit(D2 + 10 * HOUR + MINUTE, { who: 4, kind: 'e', name: 'Signup', url: 'https://example.com/pricing', props: { plan: 'Pro' } });
    const res = await eventProps(k.ctx.db, site, resolveRange(site, {}, NOW), 'Signup');
    expect(res.items).toEqual([
      { key: 'plan', value: 'Pro', events: 2, visitors: 2 },
      { key: 'plan', value: 'Free', events: 1, visitors: 1 },
      { key: 'seats', value: '3', events: 1, visitors: 1 },
    ]);
  });

  it('hands out raw hits oldest first with a marker for the next page', async () => {
    const k = await seededSite();
    const site = await k.fresh();
    const first = await rawHits(k.ctx.db, site, { limit: 4 });
    expect(first.items.map((h) => h.path)).toEqual(['/', '/pricing', '/pricing', '/']);
    expect(first.items[2]).toMatchObject({ kind: 'e', name: 'Signup', props: '{"plan":"Pro"}', source: 'Google' });
    expect(first.items[0]).toMatchObject({ source: 'Google', channel: 'Search' });
    const second = await rawHits(k.ctx.db, site, { limit: 4, cursor: first.nextCursor });
    expect(second.items.map((h) => h.path)).toEqual(['/docs/install', '/']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('live, health and the site cards', () => {
  it('counts visitors of the last five minutes and remembers the first hit', async () => {
    const k = await makeKit({}, D1);
    expect(await live(k.ctx.db, await k.fresh(), D1)).toEqual({ visitors: 0, firstHitAt: null, pages: [] });
    await k.hit(D1 + HOUR, { who: 1, url: 'https://example.com/a' });
    await k.hit(D1 + HOUR + 4 * MINUTE, { who: 2, url: 'https://example.com/b' });
    await k.hit(D1 + HOUR + 5 * MINUTE, { who: 3, url: 'https://example.com/b' });
    const res = await live(k.ctx.db, await k.fresh(), D1 + HOUR + 6 * MINUTE, true);
    expect(res.visitors).toBe(2);
    expect(res.firstHitAt).toBe(D1 + HOUR);
    expect(res.pages).toEqual([{ value: '/b', visitors: 2 }]);
  });

  it('reports refused hits by reason', async () => {
    const k = await makeKit({}, D1);
    await k.hit(D1 + HOUR, { ua: 'Googlebot/2.1' });
    await k.hit(D1 + HOUR, { ua: 'Googlebot/2.1' });
    await k.hit(D1 + HOUR, { url: 'https://elsewhere.example.net/' });
    await flushDrops(k.t.env, D1 + HOUR);
    const res = await health(k.ctx.db, await k.fresh(), D1 + 2 * HOUR);
    expect(res.dropped).toEqual([{ reason: 'bot', n: 2 }, { reason: 'origin', n: 1 }]);
    expect(res.dailyCap).toBe(20000);
  });

  it('gives each site today, yesterday and a week of history in one batch', async () => {
    const k = await seededSite();
    const [card] = await siteCards(k.ctx.db, [await k.fresh()], NOW);
    expect(card).toMatchObject({ visitorsToday: 2, pageviewsToday: 2, visitorsYesterday: 2, spark: [0, 0, 0, 0, 0, 2, 2] });
    expect(await siteCards(k.ctx.db, [], NOW)).toEqual([]);
  });
});
