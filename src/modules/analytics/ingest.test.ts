import { describe, expect, it } from 'vitest';
import { setModuleEnabled } from '../../core/registry';
import { collect, flushDrops, forgetSites, pathMatches, cleanProps } from './ingest';
import { rollupSite } from './rollup';
import { updateSite } from './sites';
import { browser, CHROME, countStatements, IPHONE, makeKit, type Kit } from './testkit';
import { HOUR, MINUTE } from './time';

const T0 = Date.UTC(2026, 2, 10, 12, 0, 0); // a Tuesday, noon UTC

interface SessionRow {
  visitor: string;
  day: string;
  visits: number;
  pageviews: number;
  events: number;
  hits: number;
  engaged: number;
  duration: number;
  entry_path: string;
  exit_path: string | null;
  source: string | null;
  channel: string;
}
interface HitRow {
  at: number;
  day: string;
  hour: number;
  kind: string;
  name: string | null;
  path: string;
  prev_path: string | null;
  visitor: string;
  source: string | null;
  channel: string;
  country: string | null;
  device: string;
  browser: string;
  os: string;
  props: string | null;
  nv: number;
  ns: number;
  np: number;
  ub: number;
  dur: number;
}

function sessions(k: Kit): SessionRow[] {
  return k.t.sqlite.prepare('SELECT * FROM an_sessions ORDER BY day, started_at').all() as unknown as SessionRow[];
}
function hits(k: Kit): HitRow[] {
  return k.t.sqlite.prepare('SELECT * FROM an_hits ORDER BY at, id').all() as unknown as HitRow[];
}
function totals(k: Kit): Record<string, { visitors: number; visits: number; pageviews: number; events: number; unbounces: number; duration: number }> {
  const rows = k.t.sqlite.prepare("SELECT * FROM an_rollups WHERE dim = 'total' ORDER BY day").all() as unknown as ({ day: string } & Record<string, number>)[];
  return Object.fromEntries(rows.map((r) => [r.day, { visitors: r.visitors!, visits: r.visits!, pageviews: r.pageviews!, events: r.events!, unbounces: r.unbounces!, duration: r.duration! }]));
}

describe('taking a hit', () => {
  it('stores a page view as two rows with what it added', async () => {
    const k = await makeKit();
    const res = await k.hit(T0, { url: 'https://example.com/pricing/?utm_source=newsletter&utm_medium=email', referrer: 'https://news.example.org/post', country: 'IN' });
    expect(res.stored).toBe(true);
    const [s] = sessions(k);
    expect(s).toMatchObject({ day: '2026-03-10', visits: 1, pageviews: 1, events: 0, hits: 1, engaged: 0, entry_path: '/pricing', exit_path: '/pricing', source: 'newsletter', channel: 'Email' });
    const [h] = hits(k);
    expect(h).toMatchObject({ at: T0, day: '2026-03-10', hour: 12, kind: 'p', path: '/pricing', prev_path: null, source: 'newsletter', channel: 'Email', country: 'IN', device: 'desktop', browser: 'Chrome', os: 'macOS', nv: 1, ns: 1, np: 1, ub: 0, dur: 0 });
    expect(h!.visitor).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never stores the IP address or the full user agent', async () => {
    const k = await makeKit();
    await k.hit(T0, { who: 7 });
    const dump = JSON.stringify([sessions(k), hits(k)]);
    expect(dump).not.toContain('203.0.0.8');
    expect(dump).not.toContain('AppleWebKit');
  });

  it('costs one batch of two statements per stored hit, and no KV write', async () => {
    const k = await makeKit();
    await k.hit(T0); // warms the site cache and today's salt
    const counts = countStatements(k.t);
    const n = 200;
    for (let i = 0; i < n; i++) {
      await k.hit(T0 + 1000 + i * 250, { who: i % 40, url: `https://example.com/page-${i % 9}`, kind: i % 5 === 4 ? 'e' : 'p', name: 'Signup' });
    }
    expect(counts.batches).toBe(n);
    expect(counts.statements).toBe(n * 2);
    expect(counts.kvReads).toBe(0);
    expect(counts.kvWrites).toBe(0);
    expect(hits(k)).toHaveLength(n + 1);
  });

  it('reads the site once a minute, not once a hit', async () => {
    const k = await makeKit();
    const counts = countStatements(k.t);
    await k.hit(T0);
    expect(counts.statements).toBe(2 + 2); // site, module state and usage, then the two writes
    counts.reset();
    await k.hit(T0 + 61_000, { who: 2 });
    expect(counts.statements).toBe(2 + 2);
    counts.reset();
    await k.hit(T0 + 62_000, { who: 3 });
    expect(counts.statements).toBe(2);
  });

  it('bumps the usage counter on one hit in sixteen, by sixteen', async () => {
    const k = await makeKit();
    let i = 0;
    for (let n = 0; n < 32; n++) {
      await collect(k.t.env, { key: k.site.key, kind: 'p', url: 'https://example.com/' }, { req: browser({ who: n }), now: T0 + n * 1000, rand: () => (i++ % 16 === 0 ? 0 : 0.99) });
    }
    const row = k.t.sqlite.prepare("SELECT n FROM an_counters WHERE name = 'hits'").get() as { n: number };
    expect(row.n).toBe(32);
  });
});

describe('visits', () => {
  it('keeps hits less than 30 minutes apart in one visit and starts a new one after that', async () => {
    const k = await makeKit();
    await k.hit(T0, { url: 'https://example.com/a', referrer: 'https://www.google.com/' });
    await k.hit(T0 + 5 * MINUTE, { url: 'https://example.com/b' });
    await k.hit(T0 + 6 * MINUTE, { url: 'https://example.com/b', kind: 'e', name: 'Signup', props: { plan: 'pro' } });
    await k.hit(T0 + 36 * MINUTE + 1, { url: 'https://example.com/c', referrer: 'https://chatgpt.com/' });
    const [s] = sessions(k);
    expect(s).toMatchObject({ visits: 2, pageviews: 3, events: 1, hits: 4, duration: 6 * MINUTE, entry_path: '/c', exit_path: '/c', source: 'ChatGPT', channel: 'AI assistants' });
    const h = hits(k);
    expect(h.map((x) => [x.nv, x.ns, x.np, x.ub, x.dur])).toEqual([
      [1, 1, 1, 0, 0],
      [0, 0, 1, 1, 5 * MINUTE],
      [0, 0, 1, 0, MINUTE],
      [0, 1, 1, 0, 0],
    ]);
    expect(h.map((x) => x.prev_path)).toEqual([null, '/a', null, null]);
    expect(h.map((x) => x.source)).toEqual(['Google', 'Google', 'Google', 'ChatGPT']);
    expect(h[2]!.props).toBe('{"plan":"pro"}');
  });

  it('a gap of exactly 30 minutes still continues the visit', async () => {
    const k = await makeKit();
    await k.hit(T0);
    await k.hit(T0 + 30 * MINUTE, { url: 'https://example.com/b' });
    expect(sessions(k)[0]).toMatchObject({ visits: 1, pageviews: 2 });
  });

  it('counts a repeat view of a page as a page view but not as a new visitor of that page', async () => {
    const k = await makeKit();
    await k.hit(T0, { url: 'https://example.com/a' });
    await k.hit(T0 + 1000, { url: 'https://example.com/a' });
    await k.hit(T0 + 2000, { url: 'https://example.com/a', kind: 'e', name: 'Play' });
    await k.hit(T0 + 3000, { url: 'https://example.com/a', kind: 'e', name: 'Play' });
    expect(hits(k).map((x) => x.np)).toEqual([1, 0, 1, 0]);
  });

  it('a single page view is a bounce until a second view, an event or ten engaged seconds', async () => {
    const k = await makeKit();
    await k.hit(T0, { who: 1 });
    await k.hit(T0, { who: 2 });
    await k.hit(T0 + 20_000, { who: 2, kind: 'g', engagedMs: 4000 }); // too short to count
    await k.hit(T0, { who: 3 });
    await k.hit(T0 + 20_000, { who: 3, kind: 'g', engagedMs: 15_000 });
    await k.hit(T0, { who: 4 });
    await k.hit(T0 + 100, { who: 4, kind: 'e', name: '404' }); // a 404 report is not engagement
    await k.hit(T0, { who: 5 });
    await k.hit(T0 + 5000, { who: 5, kind: 'e', name: 'Outbound link', props: { url: 'https://example.org/' } });
    await k.hit(T0 + 6000, { who: 5, url: 'https://example.com/b' }); // already engaged: not counted twice
    await rollupSite(k.t.env, await k.fresh(), T0 + HOUR);
    expect(totals(k)['2026-03-10']).toEqual({ visitors: 5, visits: 5, pageviews: 6, events: 2, unbounces: 2, duration: 4000 + 15_000 + 100 + 5000 + 1000 });
  });

  it('an engagement ping adds time but never starts a visit', async () => {
    const k = await makeKit();
    expect((await k.hit(T0, { kind: 'g', engagedMs: 20_000 })).stored).toBe(true); // accepted, but nothing to add to
    expect(hits(k)).toHaveLength(0);
    await k.hit(T0 + 1000);
    await k.hit(T0 + 61_000, { kind: 'g', engagedMs: 45_000 });
    await k.hit(T0 + 61_000 + 31 * MINUTE, { kind: 'g', engagedMs: 45_000 }); // the visit is over
    expect(sessions(k)[0]).toMatchObject({ visits: 1, pageviews: 1, hits: 2, engaged: 1, duration: 45_000 });
    expect(hits(k).map((x) => [x.kind, x.ub, x.dur])).toEqual([
      ['p', 0, 0],
      ['g', 1, 45_000],
    ]);
  });

  it('skips pings when the site has time on page turned off', async () => {
    const k = await makeKit();
    await updateSite(k.ctx, k.site.id, { engagement: '0' });
    forgetSites(k.t.env);
    await k.hit(T0);
    await k.hit(T0 + 20_000, { kind: 'g', engagedMs: 15_000 });
    expect(hits(k)).toHaveLength(1);
  });

  it('a visit that starts with an event has no exit page until a page is viewed', async () => {
    const k = await makeKit();
    await k.hit(T0, { url: 'https://example.com/a', kind: 'e', name: 'Signup' });
    await k.hit(T0 + 1000, { url: 'https://example.com/b' });
    expect(hits(k).map((x) => x.prev_path)).toEqual([null, null]);
    await rollupSite(k.t.env, await k.fresh(), T0 + HOUR);
    const exits = k.t.sqlite.prepare("SELECT value, visits FROM an_rollups WHERE dim = 'exit'").all();
    expect(exits).toEqual([{ value: '/b', visits: 1 }]);
  });
});

describe('days and time zones', () => {
  it('uses the day and hour of the site, not of the server', async () => {
    const k = await makeKit({ timezone: 'Asia/Kolkata' });
    await k.hit(Date.UTC(2026, 2, 10, 20, 15)); // 01:45 the next day in India
    expect(hits(k)[0]).toMatchObject({ day: '2026-03-11', hour: 1 });
  });

  it('ends a visit at midnight in the site’s time zone', async () => {
    const k = await makeKit({ timezone: 'Asia/Tokyo' });
    const midnight = Date.UTC(2026, 2, 10, 15, 0); // 00:00 on 11 March in Tokyo
    await k.hit(midnight - 2 * MINUTE, { url: 'https://example.com/a' });
    await k.hit(midnight + 2 * MINUTE, { url: 'https://example.com/b' });
    await rollupSite(k.t.env, await k.fresh(), midnight + HOUR);
    expect(totals(k)).toEqual({
      '2026-03-10': { visitors: 1, visits: 1, pageviews: 1, events: 0, unbounces: 0, duration: 0 },
      '2026-03-11': { visitors: 1, visits: 1, pageviews: 1, events: 0, unbounces: 0, duration: 0 },
    });
  });

  it('keeps one visitor and one visit across the change of the daily id at 00:00 UTC', async () => {
    const k = await makeKit({ timezone: 'America/New_York' });
    const rotation = Date.UTC(2026, 2, 11, 0, 0); // 20:00 on 10 March in New York
    await k.hit(rotation - 10 * MINUTE, { url: 'https://example.com/a' });
    await k.hit(rotation + 5 * MINUTE, { url: 'https://example.com/b' });
    await k.hit(rotation + 45 * MINUTE, { url: 'https://example.com/c' }); // past the hand-over window, same id as the hit before
    const rows = sessions(k);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-03-10', visits: 2, pageviews: 3 });
    expect(hits(k).map((x) => [x.nv, x.ns])).toEqual([
      [1, 1],
      [0, 0],
      [0, 1],
    ]);
  });

  it('counts a visitor again when they come back after the daily id has changed', async () => {
    const k = await makeKit({ timezone: 'America/New_York' });
    const rotation = Date.UTC(2026, 2, 11, 0, 0);
    await k.hit(rotation - 2 * HOUR);
    await k.hit(rotation + 2 * HOUR);
    expect(sessions(k)).toHaveLength(2);
  });

  it('puts a hit that lands behind the rollup just past it, on its own day, counted once', async () => {
    const k = await makeKit({ timezone: 'Asia/Tokyo' });
    const midnight = Date.UTC(2026, 2, 10, 15, 0);
    await k.hit(midnight - 5 * MINUTE, { who: 1 });
    await rollupSite(k.t.env, await k.fresh(), midnight + MINUTE);
    // This hit happened before midnight but is written after the rollup already passed its time.
    await k.hit(midnight - 1000, { who: 2 });
    const late = hits(k).find((h) => h.day === '2026-03-10' && h.at > midnight);
    expect(late).toMatchObject({ at: midnight + MINUTE + 1, hour: 23 });
    await rollupSite(k.t.env, await k.fresh(), midnight + 2 * MINUTE);
    await rollupSite(k.t.env, await k.fresh(), midnight + 3 * MINUTE);
    expect(totals(k)).toEqual({ '2026-03-10': { visitors: 2, visits: 2, pageviews: 2, events: 0, unbounces: 0, duration: 0 } });
  });
});

describe('what is refused', () => {
  async function reason(k: Kit, input: Parameters<Kit['hit']>[1], at = T0): Promise<string> {
    const res = await k.hit(at, input);
    return res.stored ? 'stored' : res.reason;
  }

  it('checks the site key, the page’s host and the Origin header', async () => {
    const k = await makeKit();
    await updateSite(k.ctx, k.site.id, { domains: 'shop.example.net\n*.example.org' });
    forgetSites(k.t.env);
    expect(await reason(k, { key: 'nope' })).toBe('unknown_site');
    expect(await reason(k, { url: 'https://www.example.com/' })).toBe('stored');
    expect(await reason(k, { url: 'https://shop.example.net/' })).toBe('stored');
    expect(await reason(k, { url: 'https://deep.docs.example.org/' })).toBe('stored');
    expect(await reason(k, { url: 'https://blog.example.com/' })).toBe('origin');
    expect(await reason(k, { url: 'https://example.com.evil.test/' })).toBe('origin');
    expect(await reason(k, { url: 'https://example.com/', headers: { origin: 'https://evil.example.net' } })).toBe('origin');
    expect(await reason(k, { url: 'https://example.com/', headers: { origin: 'https://www.example.com' } })).toBe('stored');
    expect(await reason(k, { url: 'not a url' })).toBe('invalid');
    expect(await reason(k, { url: 'ftp://example.com/' })).toBe('invalid');
    expect(await reason(k, { kind: 'e', name: '  ' })).toBe('invalid');
    expect(await reason(k, { kind: 'x' as 'p' })).toBe('invalid');
  });

  it('drops bots, prerenders, local pages and referrer spam', async () => {
    const k = await makeKit();
    expect(await reason(k, { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })).toBe('bot');
    expect(await reason(k, { ua: '' })).toBe('bot');
    expect(await reason(k, { headers: { 'sec-purpose': 'prefetch;prerender' } })).toBe('prerender');
    expect(await reason(k, { url: 'http://localhost:3000/' })).toBe('localhost');
    expect(await reason(k, { url: 'http://127.0.0.1/' })).toBe('localhost');
    expect(await reason(k, { referrer: 'https://free.semalt.com/crawler' })).toBe('spam');
    expect(hits(k)).toHaveLength(0);
  });

  it('honours Do Not Track only when the owner turns that on', async () => {
    const k = await makeKit();
    expect(await reason(k, { headers: { dnt: '1' } })).toBe('stored');
    await updateSite(k.ctx, k.site.id, { respect_dnt: 'on' });
    forgetSites(k.t.env);
    expect(await reason(k, { who: 2, headers: { dnt: '1' } })).toBe('dnt');
    expect(await reason(k, { who: 3, headers: { 'sec-gpc': '1' } })).toBe('dnt');
  });

  it('skips excluded paths and IP addresses', async () => {
    const k = await makeKit();
    await updateSite(k.ctx, k.site.id, { exclude_paths: '/admin/*, /preview', exclude_ips: '203.0.0.10' });
    forgetSites(k.t.env);
    expect(await reason(k, { url: 'https://example.com/admin/users' })).toBe('excluded');
    expect(await reason(k, { url: 'https://example.com/preview' })).toBe('excluded');
    expect(await reason(k, { url: 'https://example.com/previews' })).toBe('stored');
    expect(await reason(k, { who: 9 })).toBe('excluded');
  });

  it('stops at the daily limit and counts what it dropped, without failing', async () => {
    const k = await makeKit();
    await updateSite(k.ctx, k.site.id, { daily_cap: 100 });
    forgetSites(k.t.env);
    for (let i = 0; i < 100; i++) expect(await reason(k, { who: i }, T0 + i * 1000)).toBe('stored');
    expect(await reason(k, { who: 200 }, T0 + 101_000)).toBe('cap');
    expect(await reason(k, { who: 201 }, T0 + 102_000)).toBe('cap');
    // The limit is per day in the site's time zone.
    expect(await reason(k, { who: 202 }, T0 + 24 * HOUR)).toBe('stored');
    await flushDrops(k.t.env);
    const row = k.t.sqlite.prepare("SELECT day, n FROM an_counters WHERE name = 'drop.cap'").get();
    expect(row).toEqual({ day: '2026-03-10', n: 2 });
  });

  it('slows one visitor who sends too much', async () => {
    const k = await makeKit();
    const out: string[] = [];
    for (let i = 0; i < 65; i++) out.push(await reason(k, { who: 1 }, T0 + i * 100));
    expect(out.filter((r) => r === 'stored')).toHaveLength(60);
    expect(out.slice(60)).toEqual(['rate', 'rate', 'rate', 'rate', 'rate']);
    expect(await reason(k, { who: 1 }, T0 + 2 * MINUTE)).toBe('stored');
  });

  it('keeps at most 1,000 hits per visitor per day', async () => {
    const k = await makeKit();
    k.t.sqlite.exec(`UPDATE an_sites SET daily_cap = 100000`);
    for (let i = 0; i < 1003; i++) await k.hit(T0 + i * 1100);
    expect(hits(k)).toHaveLength(1000);
    expect(sessions(k)[0]!.hits).toBe(1003);
  });

  it('takes nothing while the module is off for the workspace', async () => {
    const k = await makeKit();
    await setModuleEnabled(k.t.env, k.t.org.id, 'analytics', false);
    forgetSites(k.t.env);
    expect(await reason(k, {})).toBe('module_off');
    expect(hits(k)).toHaveLength(0);
  });

  it('server-side events skip the browser checks', async () => {
    const k = await makeKit();
    const res = await k.hit(T0, { server: true, ua: 'curl/8.6.0', url: 'https://example.com/api/checkout', kind: 'e', name: 'Purchase', props: { amount: 49 } });
    expect(res.stored).toBe(true);
    expect(hits(k)[0]).toMatchObject({ kind: 'e', name: 'Purchase', device: 'other', props: '{"amount":49}' });
  });

  it('reads phones as phones', async () => {
    const k = await makeKit();
    await k.hit(T0, { ua: IPHONE });
    expect(hits(k)[0]).toMatchObject({ device: 'mobile', browser: 'Safari', os: 'iOS' });
    expect(CHROME).toContain('Chrome');
  });
});

describe('cleaning input', () => {
  it('keeps flat properties and drops the rest', () => {
    expect(cleanProps({ plan: 'pro', seats: 3, trial: false, nested: { a: 1 }, list: [1], '': 'x', nothing: null })).toBe('{"plan":"pro","seats":3,"trial":false}');
    expect(cleanProps('text')).toBeNull();
    expect(cleanProps([1, 2])).toBeNull();
    expect(cleanProps({})).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(400)]));
    const kept = JSON.parse(cleanProps(many)!) as Record<string, string>;
    expect(Object.keys(kept)).toHaveLength(30);
    expect(kept.k0).toHaveLength(300);
  });

  it('matches paths with a star', () => {
    expect(pathMatches('/blog/*', '/blog/hello')).toBe(true);
    expect(pathMatches('/blog/*', '/blog')).toBe(false);
    expect(pathMatches('/a.b', '/aXb')).toBe(false);
    expect(pathMatches('*/thanks', '/shop/thanks')).toBe(true);
    expect(pathMatches('/exact', '/exact')).toBe(true);
  });
});
