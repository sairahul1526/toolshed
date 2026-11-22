import { describe, expect, it } from 'vitest';
import { pruneSite, purgeSite, rollupSite } from './rollup';
import { report, resolveRange, STORED_DIMS, type Dim, type Metrics } from './stats';
import { makeKit, type Kit } from './testkit';
import { expectedRollups, generate, isEngaged, model, send, type ModelHit, type Sums } from './testmodel';
import { addDays, DAY, HOUR, localDay, MINUTE } from './time';

const START = Date.UTC(2026, 2, 9, 3, 0, 0);
const DAYS = 3;

function stored(k: Kit): Map<string, Sums> {
  const rows = k.t.sqlite.prepare('SELECT dim, day, value, visitors, visits, pageviews, events, unbounces, duration FROM an_rollups').all() as unknown as (Sums & { dim: string; day: string; value: string })[];
  return new Map(rows.map(({ dim, day, value, ...sums }) => [`${dim}|${day}|${value}`, { ...sums }]));
}

/** Compare two sets of totals, treating a missing row as zeros. */
function expectSame(actual: Map<string, Sums>, expected: Map<string, Sums>): void {
  const zero: Sums = { visitors: 0, visits: 0, pageviews: 0, events: 0, unbounces: 0, duration: 0 };
  const diffs: string[] = [];
  for (const key of new Set([...actual.keys(), ...expected.keys()])) {
    const a = actual.get(key) ?? zero;
    const e = expected.get(key) ?? zero;
    if (JSON.stringify(a) !== JSON.stringify(e)) diffs.push(`${key}: stored ${JSON.stringify(a)} expected ${JSON.stringify(e)}`);
  }
  expect(diffs.slice(0, 10)).toEqual([]);
}

function sum(hits: ModelHit[]): Metrics {
  const out: Metrics = { visitors: 0, visits: 0, pageviews: 0, events: 0, unbounces: 0, duration: 0 };
  for (const h of hits) {
    out.visitors += h.nv;
    out.visits += h.ns;
    out.pageviews += h.sent.kind === 'p' ? 1 : 0;
    out.events += h.sent.kind === 'e' ? 1 : 0;
    out.unbounces += h.ub;
    out.duration += h.dur;
  }
  return out;
}

async function loaded(timezone: string, seed: number, rollEvery = 0): Promise<{ k: Kit; m: ReturnType<typeof model>; end: number }> {
  const k = await makeKit({ timezone });
  const sent = generate(seed, START, DAYS, 30);
  let n = 0;
  for (const s of sent) {
    await send(k, s);
    // Rolling up in the middle of the traffic must give the same totals as rolling up once at the end.
    if (rollEvery && ++n % rollEvery === 0) await rollupSite(k.t.env, await k.fresh(), s.at);
  }
  const end = START + DAYS * DAY + HOUR;
  // One run only works through 48 hours of backlog; the hourly job would come back for the rest.
  while ((await rollupSite(k.t.env, await k.fresh(), end)).rolledAt < end);
  return { k, m: model(sent, timezone), end };
}

describe.each([
  ['UTC', 11],
  ['Asia/Kolkata', 12],
  ['America/Los_Angeles', 13],
])('daily totals against a plain count (%s)', (timezone, seed) => {
  it('stores exactly what the model counts, for every breakdown and day', async () => {
    const { k, m } = await loaded(timezone, seed);
    expect(m.hits.length).toBeGreaterThan(1500);
    expect(k.t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_hits').get()).toEqual({ n: m.hits.length });
    expectSame(stored(k), expectedRollups(m.hits));
  });

  it('gives the same totals when rolled up many times along the way', async () => {
    const { k, m } = await loaded(timezone, seed, 97);
    expectSame(stored(k), expectedRollups(m.hits));
  });

  it('matches counts made straight from the visits', async () => {
    const { k, m } = await loaded(timezone, seed);
    const totals = stored(k);
    const days = [...new Set(m.visits.map((v) => v.day))].sort();
    expect(days.length).toBeGreaterThanOrEqual(DAYS);
    for (const day of days) {
      const visits = m.visits.filter((v) => v.day === day);
      const total = totals.get(`total|${day}|`)!;
      expect(total.visitors).toBe(new Set(visits.map((v) => v.row)).size);
      expect(total.visits).toBe(visits.length);
      expect(total.visits - total.unbounces).toBe(visits.filter((v) => !isEngaged(v.hits)).length);
      expect(total.pageviews).toBe(visits.flatMap((v) => v.hits).filter((h) => h.sent.kind === 'p').length);

      const lastViews = visits.map((v) => v.hits.filter((h) => h.sent.kind === 'p').pop()?.sent.path).filter((p): p is string => !!p);
      for (const page of new Set(lastViews)) expect(totals.get(`exit|${day}|${page}`)?.visits).toBe(lastViews.filter((p) => p === page).length);

      const firsts = visits.map((v) => v.hits[0]!.sent.path);
      for (const page of new Set(firsts)) expect(totals.get(`entry|${day}|${page}`)?.visits).toBe(firsts.filter((p) => p === page).length);

      const viewers = new Set(visits.flatMap((v) => v.hits.filter((h) => h.sent.kind === 'p').map((h) => `${v.row}|${h.sent.path}`)));
      const pricing = [...viewers].filter((x) => x.endsWith('|/pricing')).length;
      expect(totals.get(`page|${day}|/pricing`)?.visitors ?? 0).toBe(pricing);
    }
    // The carry-over at 00:00 UTC was really exercised somewhere in the traffic.
    if (timezone !== 'UTC') expect(m.rows).toBeLessThan(new Set(m.hits.map((h) => `${h.sent.who}|${Math.floor(h.sent.at / DAY)}|${h.day}`)).size);
  });

  it('reads the same numbers from totals, from raw hits and with a filter', async () => {
    const { k, m, end } = await loaded(timezone, seed);
    const site = await k.fresh();
    const today = localDay(timezone, end);
    const range = resolveRange(site, { from: addDays(today, -5), to: today }, end);
    const dims: Dim[] = [...STORED_DIMS];

    const fromTotals = await report(k.ctx.db, site, range, {}, { dims, limit: 500, compare: true });
    expect(fromTotals.mode).toBe('totals');
    expect(fromTotals.totals).toEqual(sum(m.hits));
    expect(fromTotals.prev).toEqual({ visitors: 0, visits: 0, pageviews: 0, events: 0, unbounces: 0, duration: 0 });

    // Asking for cities forces the raw path, with no filter: every shared number must agree.
    const fromRaw = await report(k.ctx.db, site, range, {}, { dims: [...dims, 'city'], limit: 500 });
    expect(fromRaw.mode).toBe('raw');
    expect(fromRaw.totals).toEqual(fromTotals.totals);
    expect(fromRaw.series).toEqual({ ...fromTotals.series, prevVisitors: null });
    for (const dim of dims) expect(fromRaw.panels[dim], dim).toEqual(fromTotals.panels[dim]);
    expect(fromRaw.panels.city!.reduce((n, r) => n + r.visitors, 0)).toBe(sum(m.hits.filter((h) => h.sent.who % 3 !== 2)).visitors);

    const india = await report(k.ctx.db, site, range, { country: 'IN' }, { dims: ['page', 'source'], limit: 500 });
    expect(india.partial).toBe(false);
    expect(india.totals).toEqual(sum(m.hits.filter((h) => h.sent.who % 3 === 0)));

    const google = await report(k.ctx.db, site, range, { source: 'Google', device: 'mobile' }, { dims: ['entry'], limit: 500 });
    const googleHits = m.hits.filter((h) => h.visit.source === 'Google' && h.sent.who % 2 === 1);
    expect(google.totals).toEqual(sum(googleHits));
    expect(google.panels.entry!.reduce((n, r) => n + r.visits, 0)).toBe(googleHits.filter((h) => h.ns).length);

    // A page filter counts each visitor once per day, on their first view of that page.
    const pricing = await report(k.ctx.db, site, range, { page: '/pricing' }, { dims: ['country'], limit: 500 });
    const views = m.hits.filter((h) => h.sent.kind === 'p' && h.sent.path === '/pricing');
    expect(pricing.partial).toBe(true);
    expect(pricing.totals.pageviews).toBe(views.length);
    expect(pricing.totals.visitors).toBe(views.filter((h) => h.np).length);
    expect(pricing.totals.visitors).toBe(fromTotals.panels.page!.find((r) => r.value === '/pricing')!.visitors);

    const signups = await report(k.ctx.db, site, range, { event: 'Signup' }, { dims: ['page'], limit: 500 });
    const sent = m.hits.filter((h) => h.sent.kind === 'e' && h.sent.name === 'Signup');
    expect(signups.totals.events).toBe(sent.length);
    expect(signups.totals.visitors).toBe(fromTotals.panels.event!.find((r) => r.value === 'Signup')!.visitors);
  });
});

describe('rolling up twice', () => {
  it('adds nothing when run again, or with a stale cursor', async () => {
    const k = await makeKit();
    for (let i = 0; i < 20; i++) await k.hit(START + i * MINUTE, { who: i % 5, url: `https://example.com/p${i % 3}` });
    const stale = await k.fresh();
    const first = await rollupSite(k.t.env, stale, START + HOUR);
    expect(first.written).toBeGreaterThan(0);
    expect(first.rolledAt).toBe(START + HOUR);
    const before = stored(k);

    // A second worker that planned its run before the first one finished.
    const again = await rollupSite(k.t.env, stale, START + HOUR + 5);
    expect(again).toEqual({ written: 0, rolledAt: START + HOUR });
    expect(await rollupSite(k.t.env, await k.fresh(), START + 2 * HOUR)).toEqual({ written: 0, rolledAt: START + 2 * HOUR });
    expectSame(stored(k), before);
    expect((await k.fresh()).first_hit_at).toBe(START);
  });

  it('works through a backlog in steps and skips quiet stretches', async () => {
    const k = await makeKit();
    await k.hit(START);
    await k.hit(START + 10 * DAY, { who: 2 });
    for (let i = 0; i < 3 * DAY; i += 20 * MINUTE) await k.hit(START + 12 * DAY + i, { who: 3 + (i % 7) });
    const first = await rollupSite(k.t.env, await k.fresh(), START + 30 * DAY);
    expect(first.rolledAt).toBeGreaterThan(START + 13 * DAY);
    expect(first.rolledAt).toBeLessThan(START + 15 * DAY);
    const second = await rollupSite(k.t.env, await k.fresh(), START + 30 * DAY);
    expect(second.rolledAt).toBe(START + 30 * DAY);
    const totals = [...stored(k).entries()].filter(([key]) => key.startsWith('total|'));
    expect(totals).toHaveLength(6);
    expect(totals.reduce((n, [, sums]) => n + sums.pageviews, 0)).toBe(2 + 216);
  });
});

describe('pruning', () => {
  it('deletes old hits and visitor rows but keeps the totals and anything not rolled up yet', async () => {
    const k = await makeKit();
    for (let i = 0; i < 30; i++) await k.hit(START + i * MINUTE, { who: i });
    await rollupSite(k.t.env, await k.fresh(), START + HOUR);
    const before = stored(k);
    const later = START + 31 * DAY;
    await k.hit(later - 2 * DAY, { who: 100 });
    await k.hit(later - MINUTE, { who: 101 });
    // A hit older than the window that no rollup has seen yet must survive.
    k.t.sqlite.exec(`UPDATE an_hits SET at = ${START + HOUR + 1} WHERE at = ${later - 2 * DAY}`);
    k.t.sqlite.exec(`INSERT INTO an_counters (org_id, site_id, day, name, n) VALUES ('${k.t.org.id}', '${k.site.id}', '2025-11-01', 'drop.bot', 4), ('${k.t.org.id}', '${k.site.id}', '2026-04-08', 'drop.bot', 2)`);

    const res = await pruneSite(k.t.env, await k.fresh(), later);
    expect(res).toEqual({ hits: 30, sessions: 30, more: false });
    expect(k.t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_hits').get()).toEqual({ n: 2 });
    expect(k.t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_sessions').get()).toEqual({ n: 2 });
    expect(k.t.sqlite.prepare('SELECT day FROM an_counters').all()).toEqual([{ day: '2026-04-08' }]);
    expectSame(stored(k), before);

    await rollupSite(k.t.env, await k.fresh(), later);
    expect(stored(k).get('total|2026-04-07|')?.visitors).toBe(1);
  });

  it('stops after its share of work and says there is more', async () => {
    const k = await makeKit();
    const insert = k.t.sqlite.prepare(
      `INSERT INTO an_hits (org_id, site_id, at, id, day, hour, kind, path, visitor, channel, device, browser, os, nv, ns, np, ub, dur) VALUES (?, ?, ?, ?, '2026-01-01', 0, 'p', '/', 'v', 'Direct', 'desktop', 'Chrome', 'macOS', 0, 0, 0, 0, 0)`,
    );
    for (let i = 0; i < 5200; i++) insert.run(k.t.org.id, k.site.id, 1000 + i, `hit_${i}`);
    k.t.sqlite.exec(`UPDATE an_sites SET rolled_at = ${START}`);
    const first = await pruneSite(k.t.env, await k.fresh(), START + 400 * DAY, 1);
    expect(first).toMatchObject({ hits: 5000, more: true });
    expect(await pruneSite(k.t.env, await k.fresh(), START + 400 * DAY, 1)).toMatchObject({ hits: 200, more: false });
  });

  it('removes everything a deleted site left behind', async () => {
    const k = await makeKit();
    for (let i = 0; i < 12; i++) await k.hit(START + i * MINUTE, { who: i });
    await rollupSite(k.t.env, await k.fresh(), START + HOUR);
    expect(await purgeSite(k.t.env, 'org_other', k.site.id)).toBe(false);
    expect(k.t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_hits').get()).toEqual({ n: 12 });
    expect(await purgeSite(k.t.env, k.t.org.id, k.site.id)).toBe(false);
    for (const table of ['an_hits', 'an_sessions', 'an_rollups']) expect(k.t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
});
