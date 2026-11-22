/**
 * Generated traffic and a plain model of what the numbers should be. Only imported by tests.
 *
 * The model does not look at the database or share code with ingest.ts. It walks each person's
 * hits in order, cuts them into visits with the documented rules, and counts. The tests then
 * compare its counts with what the module stored.
 */
import { attribute } from './channels';
import type { HitKind } from './ingest';
import { CHROME, IPHONE, seeded, type Kit } from './testkit';
import { DAY, localTime, MINUTE } from './time';

export interface Sent {
  at: number;
  who: number;
  kind: HitKind;
  path: string;
  name?: string;
  referrer?: string;
  query?: string;
  engagedMs?: number;
}

const PAGES = ['/', '/pricing', '/blog', '/blog/hello', '/docs', '/docs/start', '/about', '/thanks'];
const EVENTS = ['Signup', 'Outbound link', '404', 'Play'];
const REFERRERS = [undefined, undefined, 'https://www.google.com/', 'https://chatgpt.com/', 'https://news.example.org/story', 'https://t.co/abc'];
const COUNTRIES = ['IN', 'US', undefined] as const;

export function personOf(who: number): { ua: string; country?: string; city?: string } {
  const country = COUNTRIES[who % 3];
  return { ua: who % 2 ? IPHONE : CHROME, ...(country ? { country, city: `City ${who % 4}` } : {}) };
}

/** Traffic for `people` persons over `days` days from `start`: bursts of hits a few seconds or minutes apart, then long breaks. */
export function generate(seed: number, start: number, days: number, people: number): Sent[] {
  const rand = seeded(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const out: Sent[] = [];
  for (let who = 1; who <= people; who++) {
    let at = start + Math.floor(rand() * 20 * 60 * MINUTE);
    let page: string | null = null;
    while (at < start + days * DAY) {
      const roll = rand();
      if (roll < 0.62 || page === null) {
        page = pick(PAGES);
        const sent: Sent = { at, who, kind: 'p', path: page };
        const referrer = pick(REFERRERS);
        if (referrer) sent.referrer = referrer;
        if (rand() < 0.1) sent.query = '?utm_source=newsletter&utm_medium=email&utm_campaign=spring';
        out.push(sent);
      } else if (roll < 0.85) {
        out.push({ at, who, kind: 'e', path: page, name: pick(EVENTS) });
      } else {
        out.push({ at, who, kind: 'g', path: page, engagedMs: pick([3000, 9000, 12_000, 60_000, 400_000]) });
      }
      // Mostly short steps, sometimes a break longer than a visit, sometimes right at the limit.
      const gap = rand();
      if (gap < 0.7) at += 3000 + Math.floor(rand() * 4 * MINUTE);
      else if (gap < 0.8) at += 30 * MINUTE + (rand() < 0.5 ? 0 : 1);
      else at += 31 * MINUTE + Math.floor(rand() * 9 * 60 * MINUTE);
    }
  }
  return out.sort((a, b) => a.at - b.at || a.who - b.who);
}

export async function send(k: Kit, s: Sent): Promise<void> {
  const res = await k.hit(s.at, {
    who: s.who,
    ...personOf(s.who),
    kind: s.kind,
    url: `https://example.com${s.path}${s.query ?? ''}`,
    ...(s.name ? { name: s.name } : {}),
    ...(s.referrer ? { referrer: s.referrer } : {}),
    ...(s.engagedMs !== undefined ? { engagedMs: s.engagedMs } : {}),
  });
  if (!res.stored) throw new Error(`hit refused: ${res.reason}`);
}

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

export interface ModelHit {
  sent: Sent;
  day: string;
  hour: number;
  /** First hit of this visitor today. */
  nv: 0 | 1;
  /** First hit of a visit. */
  ns: 0 | 1;
  /** First time today this visitor viewed this page or sent this event. */
  np: 0 | 1;
  /** The hit that made the visit count as engaged. */
  ub: 0 | 1;
  dur: number;
  /** For a page view: the page viewed before it in the same visit. */
  prev: string | null;
  visit: ModelVisit;
}

export interface ModelVisit {
  /** The visitor's row for the day: one per daily id and site-local day, after the carry-over at 00:00 UTC. */
  row: number;
  day: string;
  source: string;
  channel: string;
  utm: { source: string | null; medium: string | null; campaign: string | null };
  hits: ModelHit[];
}

const GAP = 30 * MINUTE;

export function model(sent: Sent[], tz: string): { hits: ModelHit[]; visits: ModelVisit[]; rows: number } {
  interface RowState {
    id: number;
    last: number;
    seen: Set<string>;
    visit: ModelVisit;
  }
  const byPerson = new Map<number, Sent[]>();
  for (const s of sent) byPerson.set(s.who, [...(byPerson.get(s.who) ?? []), s]);
  const hits: ModelHit[] = [];
  const visits: ModelVisit[] = [];
  let rows = 0;

  for (const list of byPerson.values()) {
    const state = new Map<string, RowState>();
    for (const s of list) {
      const local = localTime(tz, s.at);
      const utcDay = Math.floor(s.at / DAY);
      const key = `${utcDay}|${local.day}`;
      // The daily id changed at 00:00 UTC. A visit still going then is carried over to the new id,
      // when the hit comes within 30 minutes of the change and the site's day did not change too.
      const since = s.at % DAY;
      if (since < GAP && localTime(tz, s.at - since - 1).day === local.day) {
        const old = state.get(`${utcDay - 1}|${local.day}`);
        if (old && old.last > s.at - GAP && !state.has(key)) {
          state.delete(`${utcDay - 1}|${local.day}`);
          state.set(key, old);
        }
      }
      let row = state.get(key);
      const going = row !== undefined && s.at - row.last <= GAP;
      if (s.kind === 'g' && !going) continue; // a ping never starts a visit
      let nv: 0 | 1 = 0;
      let ns: 0 | 1 = 0;
      if (!row || !going) {
        const params = new URLSearchParams(s.query ?? '');
        const utm = { source: params.get('utm_source'), medium: params.get('utm_medium'), campaign: params.get('utm_campaign') };
        const from = attribute(s.kind === 'p' ? s.referrer : null, { source: utm.source, medium: utm.medium, campaign: utm.campaign }, (h) => h === 'example.com');
        const visit: ModelVisit = { row: row?.id ?? ++rows, day: local.day, source: from.source ?? 'Direct / None', channel: from.channel, utm, hits: [] };
        visits.push(visit);
        ns = 1;
        if (!row) {
          nv = 1;
          row = { id: visit.row, last: s.at, seen: new Set(), visit };
          state.set(key, row);
        } else row.visit = visit;
      }
      const visit = row.visit;
      const before = visit.hits;
      const gap = ns ? 0 : s.at - row.last;
      const token = s.kind === 'p' ? `p:${s.path}` : s.kind === 'e' ? `e:${s.name}` : null;
      const np: 0 | 1 = token && !row.seen.has(token) ? 1 : 0;
      if (token) row.seen.add(token);
      const engagedBefore = isEngaged(before);
      const viewed = before.filter((h) => h.sent.kind === 'p');
      const hit: ModelHit = {
        sent: s,
        day: local.day,
        hour: local.hour,
        nv,
        ns,
        np,
        ub: 0,
        dur: s.kind === 'g' ? Math.min(gap, s.engagedMs ?? 0) : gap,
        prev: s.kind === 'p' && !ns ? (viewed[viewed.length - 1]?.sent.path ?? null) : null,
        visit,
      };
      visit.hits.push(hit);
      if (!engagedBefore && isEngaged(visit.hits)) hit.ub = 1;
      row.last = s.at;
      hits.push(hit);
    }
  }
  return { hits, visits, rows };
}

/** A visit is engaged (not a bounce) with two page views, an event other than a 404 report, or ten engaged seconds. */
export function isEngaged(hits: ModelHit[]): boolean {
  return (
    hits.filter((h) => h.sent.kind === 'p').length >= 2 ||
    hits.some((h) => h.sent.kind === 'e' && h.sent.name !== '404') ||
    hits.some((h) => h.sent.kind === 'g' && (h.sent.engagedMs ?? 0) >= 10_000)
  );
}

export type Sums = { visitors: number; visits: number; pageviews: number; events: number; unbounces: number; duration: number };
const zero = (): Sums => ({ visitors: 0, visits: 0, pageviews: 0, events: 0, unbounces: 0, duration: 0 });

/** Every daily total the module should hold, keyed `dim|day|value`. */
export function expectedRollups(hits: ModelHit[]): Map<string, Sums> {
  const out = new Map<string, Sums>();
  const bump = (dim: string, day: string, value: string | null | undefined, add: Partial<Sums>): void => {
    if (value === null || value === undefined) return;
    const key = `${dim}|${day}|${value}`;
    const sums = out.get(key) ?? zero();
    for (const [m, n] of Object.entries(add) as [keyof Sums, number][]) sums[m] += n;
    out.set(key, sums);
  };
  for (const h of hits) {
    const p = h.sent.kind === 'p';
    const e = h.sent.kind === 'e';
    const person = personOf(h.sent.who);
    const all: Sums = { visitors: h.nv, visits: h.ns, pageviews: p ? 1 : 0, events: e ? 1 : 0, unbounces: h.ub, duration: h.dur };
    const phone = person.ua === IPHONE;
    const full: [string, string | null][] = [
      ['total', ''],
      ['hour', String(h.hour).padStart(2, '0')],
      ['source', h.visit.source],
      ['channel', h.visit.channel],
      ['utm_source', h.visit.utm.source],
      ['utm_medium', h.visit.utm.medium],
      ['utm_campaign', h.visit.utm.campaign],
      ['country', person.country ?? 'Unknown'],
      ['device', phone ? 'mobile' : 'desktop'],
      ['browser', phone ? 'Safari' : 'Chrome'],
      ['os', phone ? 'iOS' : 'macOS'],
    ];
    for (const [dim, value] of full) bump(dim, h.day, value, all);
    if (p) bump('page', h.day, h.sent.path, { visitors: h.np, pageviews: 1 });
    if (h.dur > 0) bump('page', h.day, p ? h.prev : h.sent.path, { duration: h.dur });
    if (h.ns) bump('entry', h.day, h.sent.path, { visitors: h.nv, visits: 1 });
    if (h.ub) bump('entry', h.day, h.prev ?? h.sent.path, { unbounces: 1 });
    if (p) bump('exit', h.day, h.sent.path, { visits: 1 });
    if (p) bump('exit', h.day, h.prev, { visits: -1 });
    if (e) bump('event', h.day, h.sent.name, { visitors: h.np, events: 1 });
  }
  return out;
}
