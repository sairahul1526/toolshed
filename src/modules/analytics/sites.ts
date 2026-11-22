/**
 * Sites, goals and share links: the things a person sets up. No HTTP in here.
 */
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../auth/hasher';
import { newId, parseJson, randomToken, type OrgDb } from '../../core/db';
import { defineErrors, errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { enqueue } from '../../core/jobs';
import type { ModuleContext } from '../../core/module';
import type { Env } from '../../env';
import { isTimeZone } from './time';

export const analyticsErrors = defineErrors('analytics', {
  site_limit: { status: 409, message: 'This workspace already has 50 sites. Delete one you no longer use.' },
  domain_taken: { status: 409, message: 'This workspace already tracks that domain.' },
  goal_limit: { status: 409, message: 'A site can have up to 30 goals. Delete one you no longer use.' },
  share_limit: { status: 409, message: 'A site can have up to 20 share links. Delete one you no longer use.' },
  range_too_long: { status: 400, message: 'That range is too long. Pick 3 years or less.' },
  bad_range: { status: 400, message: 'Pick a start day that is not after the end day.' },
  raw_expired: { status: 400, message: 'Filters only work on days that still have full detail. Pick a more recent range, or clear the filters to see totals.' },
  too_much_data: { status: 400, message: 'That is too much data to filter at once. Pick a shorter range.' },
  wrong_password: { status: 403, message: 'That password is not right. Try again.' },
});

export const MAX_SITES = 50;
export const MAX_GOALS = 30;
export const MAX_SHARES = 20;
export const RETENTION_CHOICES = [7, 30, 90, 180, 365] as const;

export interface Site {
  id: string;
  org_id: string;
  key: string;
  name: string;
  domain: string;
  domains: string;
  timezone: string;
  retention_days: number;
  engagement: number;
  respect_dnt: number;
  daily_cap: number;
  exclude_paths: string;
  exclude_ips: string;
  pinned: number;
  weekly_report: number;
  report_emails: string;
  spike_threshold: number;
  last_spike_at: number | null;
  last_report_key: string | null;
  rolled_at: number;
  first_hit_at: number | null;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface Goal {
  id: string;
  org_id: string;
  site_id: string;
  name: string;
  kind: 'event' | 'page';
  match: string;
  emitted_day: string | null;
  emitted_count: number;
  created_at: number;
}

export interface Share {
  id: string;
  org_id: string;
  site_id: string;
  token: string;
  name: string;
  password_hash: string | null;
  expires_at: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------------------------

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `https://www.Example.com/pricing` becomes `example.com`. Returns null when it is not a host name. */
export function cleanDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  s = s.replace(/^www\./, '');
  return HOST.test(s) ? s : null;
}

/** An extra allowed host: a plain host, or `*.example.com` for every subdomain. */
function cleanPattern(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s.startsWith('*.')) {
    const rest = cleanDomain(s.slice(2));
    return rest ? `*.${rest}` : null;
  }
  return cleanDomain(s);
}

/** True when a hit from `host` belongs to the site: its domain, the `www.` form, or an extra allowed host. */
export function hostAllowed(site: Pick<Site, 'domain' | 'domains'>, rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (host === site.domain) return true;
  for (const pattern of parseJson<string[]>(site.domains, [])) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      if (host === base || host.endsWith(`.${base}`)) return true;
    } else if (host === pattern) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------------------------

const lines = (max: number, each: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(/[\n,]/)).map((s) => s.trim()).filter(Boolean))
    .refine((v) => v.length <= max, `Enter ${max} or fewer.`)
    .refine((v) => v.every((s) => s.length <= each), `Keep each one under ${each} characters.`);

const flag = z.union([z.boolean(), z.literal('on'), z.literal('1'), z.literal('0'), z.literal('')]).transform((v) => (v === true || v === 'on' || v === '1' ? 1 : 0));

const siteFields = {
  name: z.string().trim().max(80, 'Keep the name under 80 characters.').optional(),
  domain: z.string().trim().min(1, 'Enter your site’s domain, like example.com.').max(253, 'That domain is too long.'),
  timezone: z.string().trim().refine(isTimeZone, 'Pick a time zone from the list.'),
  domains: lines(20, 253),
  retention_days: z.coerce.number().refine((n) => (RETENTION_CHOICES as readonly number[]).includes(n), 'Pick one of the choices.'),
  engagement: flag,
  respect_dnt: flag,
  daily_cap: z.coerce.number().int('Enter a whole number.').min(100, 'Enter 100 or more.').max(5_000_000, 'Enter 5,000,000 or less.'),
  exclude_paths: lines(50, 200),
  exclude_ips: lines(50, 45),
  pinned: flag,
  weekly_report: flag,
  report_emails: lines(10, 254).refine((v) => v.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), 'One of those is not an email address.'),
  spike_threshold: z.coerce.number().int('Enter a whole number.').min(0, 'Enter 0 or more.').max(10_000_000, 'That is too high.'),
};

const createSchema = z.object({ name: siteFields.name, domain: siteFields.domain, timezone: siteFields.timezone.optional() });
const updateSchema = z.object(siteFields).partial();

function domainOrThrow(input: string): string {
  const domain = cleanDomain(input);
  if (!domain) throw errors.validation_failed(undefined, { domain: 'Enter a domain like example.com, without a path.' });
  return domain;
}

function patternsOrThrow(list: string[], selfDomain: string): string[] {
  const out: string[] = [];
  for (const item of list) {
    const pattern = cleanPattern(item);
    if (!pattern) throw errors.validation_failed(undefined, { domains: `“${item.slice(0, 60)}” is not a domain. Use example.com or *.example.com.` });
    if (pattern !== selfDomain && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

export async function listSites(db: OrgDb): Promise<Site[]> {
  return db.all<Site>('SELECT * FROM an_sites WHERE org_id = :org ORDER BY pinned DESC, name COLLATE NOCASE, id LIMIT 200');
}

export async function getSite(db: OrgDb, id: string): Promise<Site> {
  const site = await db.get<Site>('an_sites', id);
  if (!site) throw errors.not_found('We couldn’t find that site. It may have been deleted.');
  return site;
}

export async function createSite(ctx: ModuleContext, input: unknown, opts: { sample?: boolean; now?: number } = {}): Promise<Site> {
  const data = parse(createSchema, input);
  const domain = domainOrThrow(data.domain);
  if ((await ctx.db.count('an_sites')) >= MAX_SITES) throw analyticsErrors.site_limit();
  if (await ctx.db.findOne('an_sites', { domain })) throw analyticsErrors.domain_taken(undefined, { domain: 'This workspace already tracks that domain.' });
  const now = opts.now ?? Date.now();
  const site = await ctx.db.insert<Site>('an_sites', {
    id: newId('site', now),
    key: randomToken(9),
    name: data.name || domain,
    domain,
    timezone: data.timezone ?? 'UTC',
    sample: opts.sample ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  if (!opts.sample) await emit(ctx.env, { orgId: ctx.org.id, module: 'analytics', name: 'site.created', subject: site.id, data: { domain, name: site.name }, at: now });
  return site;
}

export async function updateSite(ctx: ModuleContext, id: string, input: unknown, now = Date.now()): Promise<Site> {
  const site = await getSite(ctx.db, id);
  const data = parse(updateSchema, input);
  const patch: Record<string, unknown> = { updated_at: now };
  let domain = site.domain;
  if (data.domain !== undefined) {
    domain = domainOrThrow(data.domain);
    if (domain !== site.domain) {
      const clash = await ctx.db.findOne<Site>('an_sites', { domain });
      if (clash && clash.id !== id) throw analyticsErrors.domain_taken(undefined, { domain: 'This workspace already tracks that domain.' });
      patch.domain = domain;
    }
  }
  if (data.name !== undefined) patch.name = data.name || domain;
  if (data.domains !== undefined) patch.domains = JSON.stringify(patternsOrThrow(data.domains, domain));
  for (const key of ['timezone', 'retention_days', 'engagement', 'respect_dnt', 'daily_cap', 'pinned', 'weekly_report', 'spike_threshold'] as const) {
    if (data[key] !== undefined) patch[key] = data[key];
  }
  for (const key of ['exclude_paths', 'exclude_ips', 'report_emails'] as const) {
    if (data[key] !== undefined) patch[key] = JSON.stringify(data[key]);
  }
  return (await ctx.db.update<Site>('an_sites', id, patch)) ?? site;
}

/** Remove a site now and its hits in the background: a busy site has too many rows for one request. */
export async function deleteSite(ctx: ModuleContext, id: string): Promise<void> {
  const site = await getSite(ctx.db, id);
  await ctx.db.d1.batch([
    ctx.db.d1.prepare('DELETE FROM an_sites WHERE org_id = ?1 AND id = ?2').bind(ctx.org.id, site.id),
    ctx.db.d1.prepare('DELETE FROM an_goals WHERE org_id = ?1 AND site_id = ?2').bind(ctx.org.id, site.id),
    ctx.db.d1.prepare('DELETE FROM an_shares WHERE org_id = ?1 AND site_id = ?2').bind(ctx.org.id, site.id),
    ctx.db.d1.prepare('DELETE FROM an_counters WHERE org_id = ?1 AND site_id = ?2').bind(ctx.org.id, site.id),
  ]);
  await enqueue(ctx.env, 'analytics.purge', { orgId: ctx.org.id, siteId: site.id });
}

/** The tag a site owner pastes into their pages. */
export function snippet(appUrl: string, site: Pick<Site, 'key'>): string {
  return `<script defer data-site="${site.key}" src="${appUrl}/m/analytics/t.js"></script>`;
}

/** The domain to show next to a site's name. A site that was never named is called by its domain, so it is not said twice. */
export function domainNote(site: Pick<Site, 'name' | 'domain'>): string | undefined {
  return site.name === site.domain ? undefined : site.domain;
}

/** The fallback for pages where scripts cannot run. */
export function pixelSnippet(appUrl: string, site: Pick<Site, 'key'>): string {
  return `<noscript><img src="${appUrl}/a/p.gif?k=${site.key}" alt="" width="1" height="1" referrerpolicy="no-referrer-when-downgrade"></noscript>`;
}

// ---------------------------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------------------------

const goalSchema = z
  .object({
    name: z.string().trim().max(80, 'Keep the name under 80 characters.').optional(),
    kind: z.enum(['event', 'page'], 'Pick what the goal counts.'),
    match: z.string().trim().min(1, 'Enter an event name or a page path.').max(200, 'Keep it under 200 characters.'),
  })
  .refine((g) => g.kind !== 'page' || g.match.startsWith('/'), { path: ['match'], message: 'A page path starts with a slash, like /thanks or /blog/*.' });

export async function listGoals(db: OrgDb, siteId: string): Promise<Goal[]> {
  return db.all<Goal>('SELECT * FROM an_goals WHERE org_id = :org AND site_id = ? ORDER BY id LIMIT 100', siteId);
}

export async function createGoal(ctx: ModuleContext, siteId: string, input: unknown, now = Date.now()): Promise<Goal> {
  const site = await getSite(ctx.db, siteId);
  const data = parse(goalSchema, input);
  if ((await ctx.db.count('an_goals', { site_id: site.id })) >= MAX_GOALS) throw analyticsErrors.goal_limit();
  if (await ctx.db.findOne('an_goals', { site_id: site.id, kind: data.kind, match: data.match })) {
    throw errors.validation_failed(undefined, { match: 'This site already has that goal.' });
  }
  const fallback = data.kind === 'page' ? `Visit ${data.match}` : data.match;
  return ctx.db.insert<Goal>('an_goals', { id: newId('goal', now), site_id: site.id, name: data.name || fallback, kind: data.kind, match: data.match, created_at: now });
}

export async function deleteGoal(ctx: ModuleContext, siteId: string, goalId: string): Promise<void> {
  const goal = await ctx.db.get<Goal>('an_goals', goalId);
  if (!goal || goal.site_id !== siteId) throw errors.not_found('We couldn’t find that goal.');
  await ctx.db.remove('an_goals', goalId);
}

// ---------------------------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------------------------

const shareSchema = z.object({
  name: z.string().trim().max(80, 'Keep the name under 80 characters.').optional(),
  password: z.string().max(256, 'Keep the password under 256 characters.').optional(),
  expires_in_days: z.union([z.literal(''), z.coerce.number().int().min(1, 'Enter 1 or more.').max(3650, 'Enter 3650 or less.')]).optional(),
});

export async function listShares(db: OrgDb, siteId: string): Promise<Share[]> {
  return db.all<Share>('SELECT * FROM an_shares WHERE org_id = :org AND site_id = ? ORDER BY id LIMIT 100', siteId);
}

export async function createShare(ctx: ModuleContext, siteId: string, input: unknown, now = Date.now()): Promise<Share> {
  const site = await getSite(ctx.db, siteId);
  const data = parse(shareSchema, input);
  if ((await ctx.db.count('an_shares', { site_id: site.id })) >= MAX_SHARES) throw analyticsErrors.share_limit();
  const days = typeof data.expires_in_days === 'number' ? data.expires_in_days : null;
  return ctx.db.insert<Share>('an_shares', {
    id: newId('shr', now),
    site_id: site.id,
    token: randomToken(18),
    name: data.name || 'Public dashboard',
    password_hash: data.password ? await hashPassword(data.password) : null,
    expires_at: days ? now + days * 86_400_000 : null,
    created_at: now,
  });
}

export async function deleteShare(ctx: ModuleContext, siteId: string, shareId: string): Promise<void> {
  const share = await ctx.db.get<Share>('an_shares', shareId);
  if (!share || share.site_id !== siteId) throw errors.not_found('We couldn’t find that share link.');
  await ctx.db.remove('an_shares', shareId);
}

/** Look a public token up across the whole install. Returns null for unknown and expired links alike. */
export async function shareByToken(env: Env, token: string, now = Date.now()): Promise<Share | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const share = await env.DB.prepare('SELECT * FROM an_shares WHERE token = ?1').bind(token).first<Share>();
  if (!share || (share.expires_at !== null && share.expires_at <= now)) return null;
  return share;
}

export async function checkSharePassword(share: Share, password: string): Promise<boolean> {
  if (!share.password_hash) return true;
  if (!password || password.length > 256) return false;
  return verifyPassword(password, share.password_hash);
}

/** A share link safe to show in the API and the export: no hash, just whether one is set. */
export function publicShare(share: Share): Omit<Share, 'password_hash'> & { has_password: boolean } {
  const { password_hash, ...rest } = share;
  return { ...rest, has_password: password_hash !== null };
}
