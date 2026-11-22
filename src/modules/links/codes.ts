/**
 * Short codes and bio slugs share one namespace. A code may never shadow a real route, so the
 * reserved set is the core's names, every module id and public path, and a few well-known files.
 */
import { RESERVED_IDS } from '../../core/module';
import { allModules } from '../../core/registry';
import { linkErrors } from './errors';

export const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/** Letters and digits with the look-alikes (0 o 1 l i) removed, all lowercase. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const FIXED = [
  'l', 'robots.txt', 'robots', 'favicon', 'favicon.ico', 'sitemap', 'sitemap.xml', 'humans.txt', 'manifest', 'manifest.json',
  'admin', 'login', 'logout', 'signin', 'signup', 'sign-in', 'sign-up', 'register', 'dashboard', 'www', 'static', 'public',
  'support', 'help', 'about', 'privacy', 'terms', 'security', 'status', 'blog', 'docs', 'pricing', 'contact', 'index',
  'bulk', 'actions', 'stats', 'tags', 'folders', 'bios', 'blocks', 'blocklist', 'reports', 'null', 'undefined', 'wp-admin', 'wp-login', 'well-known', 'ads.txt', 'health', 'ping', 'webhook', 'webhooks', 'callback',
];

/** Every code that must not be handed out: core names, other modules' ids and public paths, and fixed words. */
export function reservedCodes(): Set<string> {
  const out = new Set<string>([...RESERVED_IDS, ...FIXED]);
  for (const m of allModules()) {
    out.add(m.id);
    for (const p of m.publicPrefixes ?? []) out.add(p.replace(/^\//, '').toLowerCase());
  }
  return out;
}

export function isReserved(code: string): boolean {
  return reservedCodes().has(code.toLowerCase());
}

/** Lowercase, trim and check a code a person typed. Throws a field-level error. */
export function normalizeCode(raw: string): string {
  const code = raw.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) throw linkErrors.code_invalid(undefined, { code: linkErrors.code_invalid().message });
  if (isReserved(code)) throw linkErrors.code_reserved(undefined, { code: linkErrors.code_reserved().message });
  return code;
}

export function randomCode(length = 7): string {
  const n = Math.min(Math.max(Math.floor(length), 5), 16);
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]!;
  return isReserved(out) ? randomCode(length) : out;
}
