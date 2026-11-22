/**
 * Sample data: one made-up site with a month of believable traffic, so every panel has something
 * to show before a real snippet is installed. Every row hangs off a site marked `sample = 1`.
 *
 * Cost: about 2,500 hit rows plus about 3,000 daily totals, written once. That is around 5% of a
 * day's free-plan writes, which is why the traffic is kept this small.
 */
import type { ModuleContext } from '../../core/module';
import { getSetting } from '../../core/settings';
import { forgetSites } from './ingest';
import { rollupSite } from './rollup';
import { createGoal, createSite, type Site } from './sites';
import { addDays, dayStart, HOUR, isTimeZone, localDay, MINUTE } from './time';

const SAMPLE_DOMAIN = 'sample.example.com';
const DAYS = 30;
const CHUNK = 600;

/** Small repeatable generator, so the sample looks the same in every workspace. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Weighted<T> = [number, T][];

const PAGES: Weighted<string> = [
  [30, '/'], [14, '/pricing'], [10, '/features'], [9, '/blog'], [8, '/blog/cookieless-analytics'], [6, '/blog/launch-week'],
  [8, '/docs'], [6, '/docs/install'], [4, '/about'], [3, '/contact'], [2, '/changelog'],
];

interface From {
  source: string | null;
  channel: string;
  utm?: [string, string, string];
}
const SOURCES: Weighted<From> = [
  [34, { source: null, channel: 'Direct' }],
  [24, { source: 'Google', channel: 'Search' }],
  [5, { source: 'DuckDuckGo', channel: 'Search' }],
  [3, { source: 'Bing', channel: 'Search' }],
  [7, { source: 'ChatGPT', channel: 'AI assistants' }],
  [3, { source: 'Perplexity', channel: 'AI assistants' }],
  [2, { source: 'Claude', channel: 'AI assistants' }],
  [6, { source: 'Hacker News', channel: 'Social' }],
  [4, { source: 'X', channel: 'Social' }],
  [3, { source: 'LinkedIn', channel: 'Social' }],
  [5, { source: 'newsletter', channel: 'Email', utm: ['newsletter', 'email', 'spring-update'] }],
  [2, { source: 'Google', channel: 'Paid search', utm: ['google', 'cpc', 'brand'] }],
  [2, { source: 'blog.example.org', channel: 'Referral' }],
];

const PLACES: Weighted<[string, string, string]> = [
  [22, ['US', 'California', 'San Francisco']], [8, ['US', 'New York', 'New York']], [14, ['IN', 'Karnataka', 'Bengaluru']],
  [6, ['IN', 'Maharashtra', 'Mumbai']], [10, ['GB', 'England', 'London']], [9, ['DE', 'Berlin', 'Berlin']], [6, ['FR', 'Île-de-France', 'Paris']],
  [5, ['BR', 'São Paulo', 'São Paulo']], [5, ['CA', 'Ontario', 'Toronto']], [4, ['AU', 'New South Wales', 'Sydney']], [4, ['JP', 'Tokyo', 'Tokyo']],
  [3, ['NL', 'North Holland', 'Amsterdam']], [2, ['NG', 'Lagos', 'Lagos']],
];

const AGENTS: Weighted<[string, string, string]> = [
  [26, ['desktop', 'Chrome', 'Windows']], [20, ['desktop', 'Chrome', 'macOS']], [10, ['desktop', 'Safari', 'macOS']], [6, ['desktop', 'Firefox', 'Linux']],
  [5, ['desktop', 'Edge', 'Windows']], [16, ['mobile', 'Safari', 'iOS']], [13, ['mobile', 'Chrome', 'Android']], [4, ['tablet', 'Safari', 'iOS']],
];

/** What an hour of the day is worth: quiet nights, a busy afternoon. */
const HOURS: Weighted<number> = [3, 2, 2, 2, 2, 3, 5, 8, 12, 16, 18, 19, 18, 19, 20, 19, 17, 15, 14, 13, 11, 9, 6, 4].map((w, h) => [w, h]);

function chooser(rand: () => number): <T>(list: Weighted<T>) => T {
  return function pick<T>(list: Weighted<T>): T {
    let roll = rand() * list.reduce((n, [w]) => n + w, 0);
    for (const [w, item] of list) {
      roll -= w;
      if (roll < 0) return item;
    }
    return list[list.length - 1]![1];
  };
}

// The columns each generated hit fills, in the order the insert below reads them.
type HitRow = [
  at: number, id: string, day: string, hour: number, kind: string, name: string | null, path: string, prev: string | null, visitor: string,
  source: string | null, channel: string, utmSource: string | null, utmMedium: string | null, utmCampaign: string | null,
  country: string, region: string, city: string, device: string, browser: string, os: string, props: string | null,
  nv: number, ns: number, np: number, ub: number, dur: number,
];

/** A month of visits ending at `now`, with the same per-hit flags the collect endpoint would have stored. */
export function sampleHits(tz: string, now: number): HitRow[] {
  const rand = seeded(20_260_101);
  const pick = chooser(rand);
  const today = localDay(tz, now);
  const rows: HitRow[] = [];
  let people = 0;

  const visit = (day: string, dayBegin: number, dayEnd: number, begin: number, who: string, seen: Set<string>, first: boolean): number => {
    const from = pick(SOURCES);
    const [country, region, city] = pick(PLACES);
    const [device, browser, os] = pick(AGENTS);
    let at = begin;
    let last = begin;
    let engaged = false;
    let views = 0;
    let stored = 0;
    let page: string | null = null;
    const add = (kind: 'p' | 'e' | 'g', name: string | null, path: string, props: Record<string, string> | null, engagedMs = 0): void => {
      if (at >= dayEnd || at > now) return;
      const ns = stored++ === 0 ? 1 : 0;
      const token = kind === 'g' ? null : `${kind}:${kind === 'p' ? path : name}`;
      const np = token && !seen.has(token) ? 1 : 0;
      if (token) seen.add(token);
      if (kind === 'p') views++;
      const nowEngaged = engaged || views >= 2 || (kind === 'e' && name !== '404') || (kind === 'g' && engagedMs >= 10_000);
      const gap = at - last;
      rows.push([
        at, `smp${rows.length.toString(36)}`, day, Math.min(23, Math.floor((at - dayBegin) / HOUR)), kind, name, path,
        kind === 'p' && ns === 0 ? page : null, who, from.source, from.channel, from.utm?.[0] ?? null, from.utm?.[1] ?? null, from.utm?.[2] ?? null,
        country, region, city, device, browser, os, props ? JSON.stringify(props) : null,
        first && ns === 1 ? 1 : 0, ns, np, nowEngaged && !engaged ? 1 : 0, kind === 'g' ? Math.min(gap, engagedMs) : gap,
      ]);
      engaged = nowEngaged;
      last = at;
      if (kind === 'p') page = path;
    };

    const depth = rand() < 0.42 ? 1 : 2 + Math.floor(rand() * 3);
    for (let i = 0; i < depth; i++) {
      const path = i === 0 && rand() < 0.02 ? '/old-pricing' : pick(PAGES);
      add('p', null, path, null);
      if (path === '/old-pricing') add('e', '404', path, { path });
      at += 8000 + Math.floor(rand() * 3 * MINUTE);
      const roll = rand();
      if (roll < 0.05) add('e', 'Outbound link', path, { url: rand() < 0.5 ? 'https://github.com/example/app' : 'https://status.example.com/' });
      else if (roll < 0.08) add('e', 'File download', path, { url: `https://${SAMPLE_DOMAIN}/files/${rand() < 0.6 ? 'guide.pdf' : 'pricing.xlsx'}` });
      else if (roll < 0.2 && path === '/pricing') {
        add('e', 'Signup', path, { plan: pick([[6, 'Free'], [3, 'Pro'], [1, 'Team']]), method: rand() < 0.7 ? 'email' : 'google' });
        at += 4000;
        add('p', null, '/thanks', null);
      }
    }
    // The page's own "still reading" ping, sent when the tab is hidden.
    if (rand() < 0.45) {
      const read = 5000 + Math.floor(rand() * 4 * MINUTE);
      at = last + read;
      add('g', null, page ?? '/', null, read);
    }
    return last;
  };

  for (let back = DAYS - 1; back >= 0; back--) {
    const day = addDays(today, -back);
    const begin = dayStart(tz, day);
    const end = dayStart(tz, addDays(day, 1));
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const quiet = weekday === 0 || weekday === 6 ? 0.6 : 1;
    // A slow climb over the month, and one busy day a week ago when a post did well.
    const visits = Math.round((22 + (DAYS - back) * 0.45) * quiet * (0.85 + rand() * 0.3) * (back === 8 ? 2.4 : 1));
    for (let v = 0; v < visits; v++) {
      const who = `sample${(++people).toString(36)}`;
      const seen = new Set<string>();
      const startAt = begin + pick(HOURS) * HOUR + Math.floor(rand() * HOUR);
      if (startAt >= end || startAt > now) continue;
      const last = visit(day, begin, end, startAt, who, seen, true);
      // One in eight comes back later the same day.
      if (rand() < 0.125) visit(day, begin, end, last + 45 * MINUTE + Math.floor(rand() * 3 * HOUR), who, seen, false);
    }
  }
  // A few people on the site right now, so the live count is not zero on first look.
  const begin = dayStart(tz, today);
  const end = dayStart(tz, addDays(today, 1));
  for (let i = 0; i < 4; i++) visit(today, begin, end, now - (i + 1) * 50_000, `sample${(++people).toString(36)}`, new Set(), true);
  return rows.sort((a, b) => a[0] - b[0]);
}

const COLUMNS = `at, id, day, hour, kind, name, path, prev_path, visitor, source, channel, utm_source, utm_medium, utm_campaign,
  country, region, city, device, browser, os, props, nv, ns, np, ub, dur`;
const INSERT = `INSERT INTO an_hits (org_id, site_id, ${COLUMNS})
  SELECT ?1, ?2, ${Array.from({ length: 26 }, (_, i) => `json_extract(j.value, '$[${i}]')`).join(', ')} FROM json_each(?3) j`;

export async function sampleData(ctx: ModuleContext, now = Date.now()): Promise<void> {
  if (await ctx.db.findOne<Site>('an_sites', { sample: 1 })) return;
  const zone = await getSetting(ctx.env, ctx.org.id, 'timezone', 'UTC');
  const timezone = typeof zone === 'string' && isTimeZone(zone) ? zone : 'UTC';
  const site = await createSite(ctx, { name: 'Sample site', domain: SAMPLE_DOMAIN, timezone }, { sample: true, now });
  const rows = sampleHits(timezone, now);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) stmts.push(ctx.env.DB.prepare(INSERT).bind(ctx.org.id, site.id, JSON.stringify(rows.slice(i, i + CHUNK))));
  const today = localDay(timezone, now);
  const counter = (day: string, name: string, n: number): D1PreparedStatement =>
    ctx.env.DB.prepare('INSERT INTO an_counters (org_id, site_id, day, name, n) VALUES (?1, ?2, ?3, ?4, ?5)').bind(ctx.org.id, site.id, day, name, n);
  stmts.push(
    counter(today, 'hits', rows.filter((r) => r[2] === today).length),
    counter(today, 'drop.bot', 41),
    counter(addDays(today, -1), 'drop.bot', 58),
    counter(addDays(today, -1), 'drop.spam', 6),
    counter(addDays(today, -2), 'drop.origin', 3),
  );
  await ctx.env.DB.batch(stmts);
  // One wide step: the whole month is a few thousand rows.
  await rollupSite(ctx.env, site, now, Number.MAX_SAFE_INTEGER);
  await createGoal(ctx, site.id, { name: 'Signed up', kind: 'event', match: 'Signup' }, now);
  await createGoal(ctx, site.id, { name: 'Read the docs', kind: 'page', match: '/docs*' }, now + 1);
}

export async function clearSampleData(ctx: ModuleContext): Promise<void> {
  const sites = await ctx.db.all<Pick<Site, 'id'>>('SELECT id FROM an_sites WHERE org_id = :org AND sample = 1 LIMIT 20');
  if (!sites.length) return;
  const stmts: D1PreparedStatement[] = [];
  for (const { id } of sites) {
    for (const table of ['an_hits', 'an_sessions', 'an_rollups', 'an_counters', 'an_goals', 'an_shares']) {
      stmts.push(ctx.env.DB.prepare(`DELETE FROM ${table} WHERE org_id = ?1 AND site_id = ?2`).bind(ctx.org.id, id));
    }
    stmts.push(ctx.env.DB.prepare('DELETE FROM an_sites WHERE org_id = ?1 AND id = ?2').bind(ctx.org.id, id));
  }
  await ctx.env.DB.batch(stmts);
  forgetSites(ctx.env);
}
