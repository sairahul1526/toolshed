/** Small request helpers shared by the auth routes and services. */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AppError } from '../core/errors';
import { rateLimit, type RateLimitRule } from '../core/ratelimit';
import type { AppEnv, Env } from '../env';
import { baseUrl, COOKIE_PREFIX, secureCookies } from './auth';
import { LIMITS } from './config';
import { hmac, safeEqual } from './crypto';

/** The caller's address as Cloudflare saw it. Clients cannot set this header themselves. */
export function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'local';
}

/**
 * What a per-address limit counts. An IPv6 customer is usually handed a whole /64 and can use a
 * new address from it for every request, so those are counted by their network. Anything else
 * (IPv4, IPv4 written inside IPv6, text that is not an address) is counted as it stands.
 */
export function addressBlock(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head = '', tail, more] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  if (more !== undefined || gap < 0) return ip;
  const groups = [...left, ...Array<string>(gap).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return ip;
  const n = groups.map((group) => parseInt(group, 16));
  // IPv4 written as hex inside IPv6 (::ffff:102:304) is one IPv4 address, not a shared block.
  if (n.slice(0, 5).every((v) => v === 0) && n[5] === 0xffff) {
    return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/** Copy the cookies Better Auth set on its own response onto ours. */
export function forwardCookies(c: Context<AppEnv>, cookies: string[]): void {
  for (const cookie of cookies) c.header('set-cookie', cookie, { append: true });
}

/**
 * Count one hit and say how long to wait when over the limit (0 = fine). On a developer's own
 * machine the limits are 20 times looser, so repeated test runs do not trip them.
 */
export async function hit(env: Env, name: keyof typeof LIMITS, who: string, now?: number): Promise<number> {
  const base: RateLimitRule = LIMITS[name];
  const rule = env.ENVIRONMENT === 'dev' ? { limit: base.limit * 20, windowSec: base.windowSec } : base;
  // The limits named "...PerIp" are given an address; the rest are given an account or a person.
  const key = name.endsWith('PerIp') ? addressBlock(who) : who;
  const res = await rateLimit(env, `auth.${name}:${key}`, rule, now);
  return res.ok ? 0 : Math.max(1, res.retryAfter);
}

/** `hit`, for callers that answer with an error instead of a page: throws `rate_limited` (429, Retry-After). */
export async function enforceHit(env: Env, name: keyof typeof LIMITS, who: string): Promise<void> {
  const wait = await hit(env, name, who);
  if (wait) throw new AppError('rate_limited', 429, `Too many tries. Try again in ${waitText(wait)}.`, undefined, { 'Retry-After': String(wait) });
}

/** "14 minutes", "40 seconds". */
export function waitText(seconds: number): string {
  if (seconds >= 90) return `${Math.ceil(seconds / 60)} minutes`;
  if (seconds >= 60) return '1 minute';
  return `${seconds} seconds`;
}

/* ---- Short-lived signed cookies that carry a step of a flow from one page to the next ---- */

export type FlowKind = 'sign-in' | 'password' | 'two-step' | 'limited' | 'claim' | 'setup' | 'invite' | 'email-change';

export interface Flow {
  /** The emailed code this browser asked for. */
  codeId?: string;
  email?: string;
  next?: string;
  /** Free-form extras, for example an invitation id or the seconds to wait. */
  ref?: string;
  /** When the cookie stops counting, ms. */
  exp: number;
}

const FLOW_TTL_SEC = 20 * 60;

function flowName(c: Context<AppEnv>, kind: FlowKind): string {
  return `${secureCookies(baseUrl(c.env, c.req.url)) ? '__Secure-' : ''}${COOKIE_PREFIX}.flow.${kind}`;
}

const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)));

export async function setFlow(c: Context<AppEnv>, kind: FlowKind, flow: Omit<Flow, 'exp'>, ttlSec = FLOW_TTL_SEC): Promise<void> {
  const body = encode(JSON.stringify({ ...flow, exp: Date.now() + ttlSec * 1000 }));
  const value = `${body}.${await hmac(c.env.AUTH_SECRET, `flow:${kind}:${body}`)}`;
  setCookie(c, flowName(c, kind), value, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureCookies(baseUrl(c.env, c.req.url)), maxAge: ttlSec });
}

export async function readFlow(c: Context<AppEnv>, kind: FlowKind): Promise<Flow | null> {
  const raw = getCookie(c, flowName(c, kind));
  if (!raw || raw.length > 2000) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  if (!(await safeEqual(raw.slice(dot + 1), await hmac(c.env.AUTH_SECRET, `flow:${kind}:${body}`)))) return null;
  try {
    const flow = JSON.parse(decode(body)) as Flow;
    return typeof flow.exp === 'number' && flow.exp > Date.now() ? flow : null;
  } catch {
    return null;
  }
}

export function clearFlow(c: Context<AppEnv>, kind: FlowKind): void {
  deleteCookie(c, flowName(c, kind), { path: '/', secure: secureCookies(baseUrl(c.env, c.req.url)) });
}

/**
 * For a page whose address is itself a secret (a sign-in link, an invite): never tell another
 * site where the visitor came from. `same-origin` rather than `no-referrer`, because under
 * `no-referrer` a browser sends `Origin: null` with the page's own form, and the same-origin
 * guard would turn the person away.
 */
export function keepAddressPrivate(c: Context<AppEnv>): void {
  c.header('referrer-policy', 'same-origin');
}
