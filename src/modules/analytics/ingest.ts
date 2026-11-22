/**
 * Taking one hit in. This is the hot path, so it is built around a budget:
 *
 *   - Nothing here runs before the visitor's browser has its answer. The route replies 202 and
 *     hands `collect` to `waitUntil`.
 *   - Site settings come from module memory (one D1 read per site per minute per isolate) and the
 *     daily salt from module memory (one KV read per isolate per day). There is no KV write per hit.
 *   - A stored hit is ONE D1 batch of two statements that write two rows:
 *       1. an upsert of the visitor's row for the day in an_sessions,
 *       2. an insert into an_hits that copies what statement 1 worked out.
 *     Hits that are refused write nothing; their counts sit in memory and are flushed every few minutes.
 *
 * Sessions without reading first. A visit ends after 30 minutes without a hit, or at midnight in
 * the site's time zone. The upsert compares the new hit's time with `last_at` of the stored row:
 * a gap over 30 minutes starts a new visit (visits + 1, entry page and source replaced), a
 * shorter gap continues the visit (the gap is added to the visit time). Statement 1 also writes what this hit
 * changed into the d_* columns (new visitor, new visit, first view of this page today, visit
 * stopped being a bounce, seconds added), and statement 2 copies them onto the hit. Totals are
 * then plain sums over hits, which is what makes the rollup exact and safe to run twice.
 *
 * Visitor ids change at 00:00 UTC, when the salt rotates. For the first 30 minutes after that, a
 * third statement moves a still-active visitor row from yesterday's id to today's, so a person
 * browsing across the rotation stays one visitor and one visit.
 */
import { newId, parseJson } from '../../core/db';
import { clientIp, geo, isBot, parseUserAgent, visitorId } from '../../core/net';
import type { Env } from '../../env';
import { attribute } from './channels';
import { hostAllowed, type Site } from './sites';
import { HOUR, localTime, MINUTE } from './time';

export const VISIT_GAP_MS = 30 * MINUTE;
/** A ping shorter than this does not turn a bounce into an engaged visit. */
export const ENGAGED_MS = 10_000;
/** Hits kept per visitor per day. Past it the visitor row still counts them but no hit is stored. */
export const VISITOR_DAILY_HITS = 1000;
/** The usage counter is bumped by this much on one hit in this many, so it costs 1/16 of a row per hit. */
export const USAGE_SAMPLE = 16;

const SITE_TTL_MS = MINUTE;
const DROP_FLUSH_MS = 5 * MINUTE;
const PER_VISITOR_PER_MINUTE = 60;
const PER_SITE_PER_MINUTE = 3000;
const MAX_PATHS_CHARS = 700;
const MAX_PATH = 300;
const MAX_NAME = 120;
const MAX_PROPS = 30;

export const DROP_REASONS = ['bot', 'prerender', 'localhost', 'origin', 'dnt', 'excluded', 'spam', 'cap', 'rate', 'invalid'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type HitKind = 'p' | 'e' | 'g';

export interface HitInput {
  key: string;
  kind: HitKind;
  name?: string | null;
  url: string;
  referrer?: string | null;
  props?: unknown;
  engagedMs?: number;
  /** Count the part after `#` as part of the page, for sites that route with the hash. */
  hash?: boolean;
}

export interface HitMeta {
  /** Only its headers (and `cf`) are read: user agent, IP, Origin, DNT. */
  req: Request;
  now?: number;
  /** Random source for the sampled usage counter. Tests pass a fixed one. */
  rand?: () => number;
  /** Sent by the workspace's own server through the Events API: skip the browser-only checks. */
  server?: boolean;
}

export type CollectResult = { stored: true; siteId: string; visitor: string } | { stored: false; reason: DropReason | 'unknown_site' | 'module_off' };

// ---------------------------------------------------------------------------------------------
// Module memory. Keyed by the D1 binding so tests with separate databases stay apart.
// ---------------------------------------------------------------------------------------------

interface CachedSite {
  site: Site | null;
  enabled: boolean;
  /** Estimated hits stored today, from the sampled counter plus what this isolate has added since. */
  used: number;
  usedDay: string;
  at: number;
}

interface Memory {
  sites: Map<string, CachedSite>;
  drops: Map<string, { orgId: string; counts: Map<string, number>; flushedAt: number }>;
  windows: Map<string, { minute: number; n: number }>;
}

const memory = new WeakMap<D1Database, Memory>();

function mem(env: Env): Memory {
  let m = memory.get(env.DB);
  if (!m) memory.set(env.DB, (m = { sites: new Map(), drops: new Map(), windows: new Map() }));
  return m;
}

/** Forget cached sites, so a settings change shows up at once in this isolate. */
export function forgetSites(env: Env): void {
  mem(env).sites.clear();
}

async function siteByKey(env: Env, key: string, now: number): Promise<CachedSite> {
  const m = mem(env);
  const hit = m.sites.get(key);
  if (hit && now - hit.at < SITE_TTL_MS && now >= hit.at) return hit;
  // Unknown keys are remembered too, so a flood of made-up keys costs one read a minute each at most.
  if (m.sites.size > 2000) m.sites.clear();
  const site = await env.DB.prepare('SELECT * FROM an_sites WHERE key = ?1').bind(key).first<Site>();
  let enabled = false;
  let used = 0;
  let usedDay = '';
  if (site) {
    usedDay = localTime(site.timezone, now).day;
    const extra = await env.DB.prepare(
      `SELECT (SELECT enabled FROM module_state WHERE org_id = ?1 AND module_id = 'analytics') AS enabled,
              (SELECT n FROM an_counters WHERE site_id = ?2 AND day = ?3 AND name = 'hits') AS used`,
    )
      .bind(site.org_id, site.id, usedDay)
      .first<{ enabled: number | null; used: number | null }>();
    enabled = extra?.enabled === 1;
    used = Math.max(extra?.used ?? 0, hit && hit.usedDay === usedDay ? hit.used : 0);
  }
  const fresh: CachedSite = { site, enabled, used, usedDay, at: now };
  m.sites.set(key, fresh);
  return fresh;
}

/** A fixed one-minute window counted in memory. Per isolate, so it is a brake, not an exact limit. */
function overLimit(env: Env, key: string, limit: number, now: number): boolean {
  const m = mem(env);
  if (m.windows.size > 20_000) m.windows.clear();
  const minute = Math.floor(now / MINUTE);
  const w = m.windows.get(key);
  if (!w || w.minute !== minute) {
    m.windows.set(key, { minute, n: 1 });
    return false;
  }
  w.n += 1;
  return w.n > limit;
}

const COUNTER_SQL = `INSERT INTO an_counters (org_id, site_id, day, name, n) VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (site_id, day, name) DO UPDATE SET n = n + excluded.n`;

function noteDrop(env: Env, site: Site, day: string, reason: DropReason): void {
  const m = mem(env);
  let d = m.drops.get(site.id);
  if (!d) m.drops.set(site.id, (d = { orgId: site.org_id, counts: new Map(), flushedAt: 0 }));
  const k = `${day}|drop.${reason}`;
  d.counts.set(k, (d.counts.get(k) ?? 0) + 1);
}

/** Statements that write a site's pending drop counts, when it is time. Empty most of the time. */
function dropStatements(env: Env, siteId: string, now: number, force = false): D1PreparedStatement[] {
  const d = mem(env).drops.get(siteId);
  if (!d || d.counts.size === 0) return [];
  if (!force && now - d.flushedAt < DROP_FLUSH_MS && now >= d.flushedAt) return [];
  const out: D1PreparedStatement[] = [];
  for (const [k, n] of d.counts) {
    const [day, name] = k.split('|') as [string, string];
    out.push(env.DB.prepare(COUNTER_SQL).bind(d.orgId, siteId, day, name, n));
  }
  d.counts.clear();
  d.flushedAt = now;
  return out;
}

/** Write every pending drop count now. Used by tests and by the data health panel before it reads. */
export async function flushDrops(env: Env, now = Date.now()): Promise<void> {
  const stmts = [...mem(env).drops.keys()].flatMap((id) => dropStatements(env, id, now, true));
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------------------------------
// Cleaning the input
// ---------------------------------------------------------------------------------------------

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

function clip(value: string | null | undefined, max: number): string | null {
  const s = value?.trim();
  return s ? s.slice(0, max) : null;
}

function cleanPath(url: URL, hash: boolean): string {
  let path = url.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  if (hash && url.hash.length > 1) path += url.hash;
  return path.slice(0, MAX_PATH);
}

/** Up to 30 flat properties: short keys, and values that are text, numbers or true/false. */
export function cleanProps(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROPS) break;
    const key = k.trim().slice(0, 60);
    if (!key) continue;
    if (typeof v === 'string') out[key] = v.slice(0, 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else continue;
    n += 1;
  }
  return n ? JSON.stringify(out) : null;
}

/** `*` matches any run of characters. Used for excluded paths and page goals. */
export function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return pattern === path;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(path);
}

/** A short stable token for "this visitor already saw this page (or fired this event) today". */
function token(kind: HitKind, text: string): string {
  let h = 0x811c9dc5;
  const s = `${kind}:${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ` ${(h >>> 0).toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------------------------

// ?1 org  ?2 site  ?3 visitor  ?4 day  ?5 at  ?6 is page view  ?7 is event  ?8 counts as engagement
// ?9 path  ?10 source  ?11 channel  ?12-?16 utm  ?17 page token
// In DO UPDATE, bare column names are the stored row and `excluded.` is the new hit.
// exit_path is the last page VIEWED in the visit (null until there is one), so that exits can be
// counted as +1 for each page view and -1 for the page view before it.
const FRESH = `(excluded.last_at - an_sessions.last_at > ${VISIT_GAP_MS})`;
const SESSION_UPSERT = `INSERT INTO an_sessions (org_id, site_id, visitor, day, started_at, visit_at, last_at, visits, pageviews, vpv, events, hits, engaged, duration,
    entry_path, exit_path, source, channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, paths, d_at, d_nv, d_ns, d_np, d_ub, d_dur, d_prev)
  VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, 1, ?6, ?6, ?7, 1, ?8, 0, ?9, CASE WHEN ?6 = 1 THEN ?9 END, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?5, 1, 1, 1, ?8, 0, NULL)
  ON CONFLICT (site_id, visitor, day) DO UPDATE SET
    d_at = excluded.last_at,
    d_nv = 0,
    d_ns = ${FRESH},
    d_np = (instr(paths, ?17) = 0 AND length(paths) < ${MAX_PATHS_CHARS}),
    d_ub = CASE WHEN ${FRESH} THEN ?8 ELSE (engaged = 0 AND (?8 = 1 OR vpv + ?6 >= 2)) END,
    d_dur = CASE WHEN ${FRESH} THEN 0 ELSE MAX(0, excluded.last_at - last_at) END,
    d_prev = CASE WHEN ${FRESH} OR ?6 = 0 THEN NULL ELSE exit_path END,
    visit_at = CASE WHEN ${FRESH} THEN excluded.last_at ELSE visit_at END,
    last_at = MAX(last_at, excluded.last_at),
    visits = visits + ${FRESH},
    pageviews = pageviews + ?6,
    vpv = CASE WHEN ${FRESH} THEN ?6 ELSE vpv + ?6 END,
    events = events + ?7,
    hits = hits + 1,
    engaged = CASE WHEN ${FRESH} THEN ?8 ELSE (engaged = 1 OR ?8 = 1 OR vpv + ?6 >= 2) END,
    duration = duration + CASE WHEN ${FRESH} THEN 0 ELSE MAX(0, excluded.last_at - last_at) END,
    entry_path = CASE WHEN ${FRESH} THEN excluded.entry_path ELSE entry_path END,
    exit_path = CASE WHEN ${FRESH} OR ?6 = 1 THEN excluded.exit_path ELSE exit_path END,
    source = CASE WHEN ${FRESH} THEN excluded.source ELSE source END,
    channel = CASE WHEN ${FRESH} THEN excluded.channel ELSE channel END,
    utm_source = CASE WHEN ${FRESH} THEN excluded.utm_source ELSE utm_source END,
    utm_medium = CASE WHEN ${FRESH} THEN excluded.utm_medium ELSE utm_medium END,
    utm_campaign = CASE WHEN ${FRESH} THEN excluded.utm_campaign ELSE utm_campaign END,
    utm_content = CASE WHEN ${FRESH} THEN excluded.utm_content ELSE utm_content END,
    utm_term = CASE WHEN ${FRESH} THEN excluded.utm_term ELSE utm_term END,
    paths = CASE WHEN instr(paths, ?17) = 0 AND length(paths) < ${MAX_PATHS_CHARS} THEN paths || ?17 ELSE paths END`;

// An engagement ping never starts a visit: it only adds time to one that is still going.
// ?1 site  ?2 visitor  ?3 day  ?4 at  ?5 engaged ms
const SESSION_PING = `UPDATE an_sessions SET
    d_at = ?4, d_nv = 0, d_ns = 0, d_np = 0, d_prev = NULL,
    d_ub = (engaged = 0 AND ?5 >= ${ENGAGED_MS}),
    d_dur = MAX(0, MIN(?4 - last_at, ?5)),
    engaged = (engaged = 1 OR ?5 >= ${ENGAGED_MS}),
    duration = duration + MAX(0, MIN(?4 - last_at, ?5)),
    last_at = MAX(last_at, ?4),
    hits = hits + 1
  WHERE site_id = ?1 AND visitor = ?2 AND day = ?3 AND ?4 - last_at <= ${VISIT_GAP_MS}`;

// The hit is stored just after the site's rollup cursor when its own time is behind it, so a hit
// that commits late is still picked up by the next rollup. Its day and hour stay as they were.
// ?1 org  ?2 site  ?3 at  ?4 id  ?5 day  ?6 hour  ?7 kind  ?8 name  ?9 path  ?10 visitor
// ?11 country  ?12 region  ?13 city  ?14 device  ?15 browser  ?16 os  ?17 props
const HIT_INSERT = `INSERT INTO an_hits (org_id, site_id, at, id, day, hour, kind, name, path, prev_path, visitor, source, channel,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, country, region, city, device, browser, os, props, nv, ns, np, ub, dur)
  SELECT ?1, ?2, MAX(?3, COALESCE((SELECT rolled_at FROM an_sites WHERE id = ?2), 0) + 1), ?4, ?5, ?6, ?7, ?8, ?9, s.d_prev, ?10, s.source, s.channel,
    s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, ?11, ?12, ?13, ?14, ?15, ?16, ?17, s.d_nv, s.d_ns, s.d_np, s.d_ub, s.d_dur
  FROM an_sessions s
  WHERE s.site_id = ?2 AND s.visitor = ?10 AND s.day = ?5 AND s.d_at = ?3 AND s.hits <= ${VISITOR_DAILY_HITS}`;

// ?1 new visitor id  ?2 site  ?3 yesterday's visitor id  ?4 day  ?5 at
const REKEY = `UPDATE an_sessions SET visitor = ?1
  WHERE site_id = ?2 AND visitor = ?3 AND day = ?4 AND last_at > ?5 - ${VISIT_GAP_MS}
    AND NOT EXISTS (SELECT 1 FROM an_sessions WHERE site_id = ?2 AND visitor = ?1 AND day = ?4)`;

// ---------------------------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------------------------

function refuse(env: Env, site: Site, day: string, reason: DropReason): CollectResult {
  noteDrop(env, site, day, reason);
  return { stored: false, reason };
}

/** Take one hit. Never throws for bad input: a refused hit is counted and reported in the result. */
export async function collect(env: Env, input: HitInput, meta: HitMeta): Promise<CollectResult> {
  const now = meta.now ?? Date.now();
  const cached = await siteByKey(env, input.key, now);
  const site = cached.site;
  if (!site) return { stored: false, reason: 'unknown_site' };
  if (!cached.enabled) return { stored: false, reason: 'module_off' };

  const local = localTime(site.timezone, now);
  const result = await decide(env, site, cached, input, meta, now, local);
  // Refused hits write nothing themselves; their counts ride along here every few minutes.
  if (!result.stored) {
    const stmts = dropStatements(env, site.id, now);
    if (stmts.length) await env.DB.batch(stmts);
  }
  return result;
}

async function decide(
  env: Env,
  site: Site,
  cached: CachedSite,
  input: HitInput,
  meta: HitMeta,
  now: number,
  local: { day: string; hour: number },
): Promise<CollectResult> {
  const { req } = meta;
  const day = local.day;
  const ua = req.headers.get('user-agent');

  if (!meta.server) {
    if (isBot(ua)) return refuse(env, site, day, 'bot');
    const purpose = `${req.headers.get('sec-purpose') ?? ''} ${req.headers.get('purpose') ?? ''}`;
    if (/prefetch|prerender|preview/i.test(purpose)) return refuse(env, site, day, 'prerender');
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return refuse(env, site, day, 'invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refuse(env, site, day, 'invalid');
  if (input.kind !== 'p' && input.kind !== 'e' && input.kind !== 'g') return refuse(env, site, day, 'invalid');
  const name = input.kind === 'e' ? clip(input.name, MAX_NAME) : null;
  if (input.kind === 'e' && !name) return refuse(env, site, day, 'invalid');

  if (!meta.server) {
    if (isLocalHost(url.hostname)) return refuse(env, site, day, 'localhost');
    if (!hostAllowed(site, url.hostname)) return refuse(env, site, day, 'origin');
    // Browsers set Origin on cross-site posts and scripts cannot fake it, so it must agree as well.
    const origin = req.headers.get('origin');
    if (origin && origin !== 'null') {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname;
      } catch {
        return refuse(env, site, day, 'origin');
      }
      if (!hostAllowed(site, originHost)) return refuse(env, site, day, 'origin');
    }
    if (site.respect_dnt && (req.headers.get('dnt') === '1' || req.headers.get('sec-gpc') === '1')) return refuse(env, site, day, 'dnt');
    const ip = clientIp(req);
    if (ip && parseJson<string[]>(site.exclude_ips, []).includes(ip)) return refuse(env, site, day, 'excluded');
  }

  const path = cleanPath(url, !!input.hash);
  if (parseJson<string[]>(site.exclude_paths, []).some((p) => pathMatches(p, path))) return refuse(env, site, day, 'excluded');
  if (input.kind === 'g' && !site.engagement) return { stored: false, reason: 'excluded' };

  const q = url.searchParams;
  const utm = {
    source: clip(q.get('utm_source') ?? q.get('ref') ?? q.get('source'), MAX_NAME),
    medium: clip(q.get('utm_medium'), MAX_NAME),
    campaign: clip(q.get('utm_campaign'), MAX_NAME),
    content: clip(q.get('utm_content'), MAX_NAME),
    term: clip(q.get('utm_term'), MAX_NAME),
  };
  const from = attribute(input.kind === 'p' ? input.referrer : null, utm, (host) => hostAllowed(site, host));
  if (from.spam) return refuse(env, site, day, 'spam');

  if (cached.usedDay !== day) {
    cached.usedDay = day;
    cached.used = 0;
  }
  if (cached.used >= site.daily_cap) return refuse(env, site, day, 'cap');
  if (overLimit(env, `s:${site.id}`, PER_SITE_PER_MINUTE, now)) return refuse(env, site, day, 'rate');

  const visitor = await visitorId(env, site.id, req, now);
  if (overLimit(env, `v:${site.id}:${visitor}`, PER_VISITOR_PER_MINUTE, now)) return refuse(env, site, day, 'rate');

  const stmts: D1PreparedStatement[] = [];
  // Just after the salt rotates, carry a still-active visitor row over to the new id. Skipped when
  // the site's own day changed at the same moment: visits end at the site's midnight anyway.
  const sinceRotation = now % (24 * HOUR);
  if (sinceRotation < VISIT_GAP_MS && localTime(site.timezone, now - sinceRotation - 1).day === day) {
    const before = await visitorId(env, site.id, req, now - sinceRotation - 1);
    stmts.push(env.DB.prepare(REKEY).bind(visitor, site.id, before, day, now));
  }

  if (input.kind === 'g') {
    const ms = Math.max(0, Math.min(Math.round(Number(input.engagedMs) || 0), VISIT_GAP_MS));
    stmts.push(env.DB.prepare(SESSION_PING).bind(site.id, visitor, day, now, ms));
  } else {
    const pv = input.kind === 'p' ? 1 : 0;
    // A 404 report fires on page load, so unlike a click it says nothing about engagement.
    const engaging = input.kind === 'e' && name !== '404' ? 1 : 0;
    stmts.push(
      env.DB.prepare(SESSION_UPSERT).bind(
        site.org_id, site.id, visitor, day, now, pv, 1 - pv, engaging, path,
        from.source, from.channel, utm.source, utm.medium, utm.campaign, utm.content, utm.term,
        token(input.kind, pv ? path : name!),
      ),
    );
  }

  const where = geo(req);
  const agent = parseUserAgent(ua);
  stmts.push(
    env.DB.prepare(HIT_INSERT).bind(
      site.org_id, site.id, now, newId('hit', now), day, local.hour, input.kind, name, path, visitor,
      where.country ?? null, clip(where.region, 80), clip(where.city, 80),
      meta.server && agent.device === 'bot' ? 'other' : agent.device, agent.browser, agent.os,
      input.kind === 'g' ? null : cleanProps(input.props),
    ),
  );

  cached.used += 1;
  if ((meta.rand ?? Math.random)() < 1 / USAGE_SAMPLE) stmts.push(env.DB.prepare(COUNTER_SQL).bind(site.org_id, site.id, day, 'hits', USAGE_SAMPLE));
  stmts.push(...dropStatements(env, site.id, now));

  await env.DB.batch(stmts);
  writeDataPoint(env, site, input.kind, path, from.channel, where.country);
  return { stored: true, siteId: site.id, visitor };
}

/** Also send the hit to Analytics Engine when that binding exists. Nothing reads it back; it is there for owners who want to query it themselves. */
function writeDataPoint(env: Env, site: Site, kind: HitKind, path: string, channel: string, country: string | undefined): void {
  try {
    env.EVENTS?.writeDataPoint({ indexes: [site.id], blobs: [kind, path, channel, country ?? ''], doubles: [1] });
  } catch {
    // An optional extra must never cost a hit.
  }
}
