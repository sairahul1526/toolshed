/** Destination checks shared by every way a link can be written: editor, API, bulk and CSV import. */
import { AppError } from '../../core/errors';
import { assertPublicUrl } from '../../core/net';
import type { Env } from '../../env';
import { linkErrors } from './errors';

export const MAX_URL_LENGTH = 2048;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** The blocked domain a host falls under (the domain itself or any subdomain of it), or null. */
export function matchBlocked(host: string, blocked: readonly string[]): string | null {
  const h = host.toLowerCase();
  for (const d of blocked) if (h === d || h.endsWith(`.${d}`)) return d;
  return null;
}

/** Turn what a person typed ("https://Example.com/page", "*.example.com") into a bare domain, or null. */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
  s = s.split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  return s;
}

export async function blockedDomains(env: Env, orgId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT domain FROM links_blocked_domains WHERE org_id = ?1').bind(orgId).all<{ domain: string }>();
  return results.map((r) => r.domain);
}

export interface DestinationOptions {
  /** The workspace's blocked domains. Load once with `blockedDomains` when checking many. */
  blocked: readonly string[];
  /** Public base address of this install, to catch links that point at another short link here. */
  base: string;
  env: Env;
  /** Skip the "points at a short link" check (used while importing, where codes are not claimed yet). */
  skipLoopCheck?: boolean;
  field?: string;
}

/**
 * A destination must be a public http or https address with no credentials, not on the
 * workspace's blocklist, and not another short link on this install (that makes loops).
 * Returns the normalised address.
 */
export async function checkDestination(raw: string, opts: DestinationOptions): Promise<string> {
  const field = opts.field ?? 'url';
  const fail = (message: string): AppError => linkErrors.url_invalid(message, { [field]: message });
  const text = raw.trim();
  if (!text) throw fail('Enter the web address people should land on.');
  if (text.length > MAX_URL_LENGTH) throw fail('That address is too long. Keep it under 2,048 characters.');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw fail('Enter a full web address that starts with http:// or https://.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw fail('Only web addresses that start with http:// or https:// can be used.');
  if (parsed.username || parsed.password) throw fail('Remove the user name and password from the address.');
  try {
    assertPublicUrl(parsed.toString());
  } catch {
    throw fail('That address can’t be used. Enter a public website address.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const hit = matchBlocked(host, opts.blocked);
  if (hit) throw linkErrors.domain_blocked(`Links to ${hit} aren’t allowed in this workspace.`, { [field]: `Links to ${hit} aren’t allowed in this workspace.` });
  if (!opts.skipLoopCheck && hostOf(opts.base) === host && /^\/[A-Za-z0-9_-]{3,64}\/?$/.test(parsed.pathname)) {
    const code = parsed.pathname.replace(/\//g, '').toLowerCase();
    const slug = await opts.env.DB.prepare('SELECT kind FROM links_slugs WHERE code = ?1').bind(code).first<{ kind: string }>();
    if (slug?.kind === 'link') throw fail('That address is another short link on this site. Use its final destination instead.');
  }
  return parsed.toString();
}

/** Set `utm_*` values on a destination, replacing any already there. Blank values are left out. */
export function applyUtm(url: string, utm: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(utm)) {
    const value = v?.trim();
    if (value) u.searchParams.set(`utm_${k}`, value);
  }
  return u.toString();
}

/** Read `utm_*` values from a destination, for the editor's builder. */
export function readUtm(url: string): Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string> {
  const out = { source: '', medium: '', campaign: '', term: '', content: '' };
  try {
    const u = new URL(url);
    for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = u.searchParams.get(`utm_${k}`) ?? '';
  } catch {
    // leave blank
  }
  return out;
}

/** Image addresses (social preview, avatars) only need to be web addresses. */
export function checkImageUrl(raw: string, field: string): string {
  const text = raw.trim();
  if (!text) return '';
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw linkErrors.url_invalid('Enter a full image address that starts with https://.', { [field]: 'Enter a full image address that starts with https://.' });
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || text.length > MAX_URL_LENGTH || u.username || u.password) {
    throw linkErrors.url_invalid('Enter a full image address that starts with https://.', { [field]: 'Enter a full image address that starts with https://.' });
  }
  return u.toString();
}
