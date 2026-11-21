/**
 * Request and network helpers shared by every module: where a request came from, what device it
 * was, a privacy-friendly visitor id, and a fetch that is safe to point at a user-supplied URL.
 */
import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { AppError, defineErrors } from './errors';

export const netErrors = defineErrors('', {
  url_not_allowed: { status: 400, message: 'That address can’t be used. Enter a public web address that starts with http:// or https://.' },
  fetch_failed: { status: 502, message: 'We couldn’t reach that address. Check it and try again.' },
  fetch_timeout: { status: 504, message: 'That address took too long to answer. Try again in a moment.' },
  fetch_too_large: { status: 502, message: 'The page at that address is too large to read.' },
  too_many_redirects: { status: 502, message: 'That address sends visitors around in circles. Check where it redirects to.' },
});

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

/** The public address of this install: `APP_URL` when set, else the origin the request came in on. No trailing slash. */
export function baseUrl(c: Context<AppEnv>): string {
  const configured = c.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(c.req.url).origin;
}

/** The visitor's IP address. Never store or log it: hash it with `visitorId`, or use it only for rate limits. */
export function clientIp(req: Request): string | null {
  const direct = req.headers.get('cf-connecting-ip')?.trim();
  if (direct) return direct;
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || null;
}

export interface Geo {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

/** Where Cloudflare says the request came from. Empty when `request.cf` is missing, as it is in tests. */
export function geo(req: Request): Geo {
  const cf = (req as { cf?: Record<string, unknown> }).cf;
  const out: Geo = {};
  if (!cf) return out;
  for (const key of ['country', 'region', 'city', 'timezone'] as const) {
    const value = cf[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// User agents
// ---------------------------------------------------------------------------------------------

/** Link-preview fetchers. Modules serve Open Graph tags to these. */
const PREVIEW_BOTS =
  /slackbot|slack-imgproxy|twitterbot|facebookexternalhit|facebot|whatsapp|discordbot|linkedinbot|telegrambot|skypeuripreview|pinterestbot|redditbot|embedly|iframely|mastodon|cardyb/i;

/** Everything else that is not a person: crawlers, monitors, headless browsers, scripts and AI crawlers. */
const OTHER_BOTS = new RegExp(
  [
    'bot\\b', // Googlebot, bingbot, GPTBot, ClaudeBot, PerplexityBot, Amazonbot, YandexBot, ...
    'crawl', 'spider', 'slurp', 'scrape', 'fetcher', 'monitor', 'checker', 'validator',
    'bytespider', 'ccbot', 'applebot', 'anthropic-ai', 'claude-web', 'chatgpt-user', 'oai-searchbot',
    'google-extended', 'cohere-ai', 'diffbot', 'imagesift', 'youbot', 'meta-external',
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'lighthouse', 'pagespeed',
    'gtmetrix', 'pingdom', 'uptimerobot', 'statuscake', 'site24x7', 'datadog', 'newrelic', 'checkly',
    'betteruptime', 'hetrixtools', 'zabbix', 'nagios',
    'curl/', 'wget', 'python-requests', 'python-urllib', 'python/', 'aiohttp', 'httpx', 'go-http-client',
    'java/', 'libwww', 'perl', 'ruby', 'node-fetch', 'node/', 'axios', 'undici', 'okhttp',
    'postmanruntime', 'insomnia', 'httpie', 'apache-httpclient', 'scrapy', 'http_request2', 'guzzle',
  ].join('|'),
  'i',
);

/** True for crawlers, link-preview fetchers, monitors, headless browsers, scripts, AI crawlers and empty user agents. */
export function isBot(ua: string | null): boolean {
  const s = ua?.trim();
  if (!s) return true;
  return PREVIEW_BOTS.test(s) || OTHER_BOTS.test(s);
}

/** True only for link-preview fetchers (Slack, X, Facebook, WhatsApp, Discord, LinkedIn, Telegram and similar). */
export function isPreviewBot(ua: string | null): boolean {
  return !!ua && PREVIEW_BOTS.test(ua);
}

export interface UserAgentInfo {
  device: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'other';
  browser: string;
  os: string;
}

// In-app browsers come first: they also say "Chrome" or "Safari" somewhere in the string.
const BROWSERS: [RegExp, string][] = [
  [/instagram/i, 'Instagram'],
  [/FBAN|FBAV|FB_IAB|FBIOS/, 'Facebook'],
  [/musical_ly|bytedancewebview|tiktok/i, 'TikTok'],
  [/linkedinapp/i, 'LinkedIn'],
  [/edg(?:e|a|ios)?\//i, 'Edge'],
  [/opr\/|opera|opt\//i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox\/|fxios\//i, 'Firefox'],
  [/chrome\/|crios\//i, 'Chrome'],
  [/safari\//i, 'Safari'],
];

function detectOs(ua: string): string {
  if (/iPhone|iPod/.test(ua)) return 'iOS';
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return 'Other';
}

function detectDevice(ua: string, os: string): UserAgentInfo['device'] {
  if (os === 'iPadOS' || /Tablet|Silk\//i.test(ua)) return 'tablet';
  // Android phones say "Mobile"; Android tablets do not.
  if (os === 'Android') return /Mobile/i.test(ua) ? 'mobile' : 'tablet';
  if (os === 'iOS' || /Mobile|Windows Phone|BlackBerry/i.test(ua)) return 'mobile';
  if (os === 'Windows' || os === 'macOS' || os === 'Linux' || os === 'ChromeOS') return 'desktop';
  return 'other';
}

/**
 * A small hand-written user agent parser. Unknown browsers and systems come back as `'Other'`.
 * iPadOS Safari sends a Mac user agent by default, so an iPad in desktop mode reads as a Mac.
 */
export function parseUserAgent(ua: string | null): UserAgentInfo {
  const s = ua?.trim() ?? '';
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] ?? 'Other';
  const os = s ? detectOs(s) : 'Other';
  if (isBot(s)) return { device: 'bot', browser, os };
  return { device: detectDevice(s, os), browser, os };
}

// ---------------------------------------------------------------------------------------------
// Visitor ids
// ---------------------------------------------------------------------------------------------

const SALT_TTL_SEC = 48 * 60 * 60;

/** One KV read per isolate per day, and one write per day. Keyed by binding so tests with separate KVs stay apart. */
const saltCache = new WeakMap<KVNamespace, Map<string, Promise<string>>>();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function dailySalt(env: Env, day: string): Promise<string> {
  let days = saltCache.get(env.KV);
  if (!days) saltCache.set(env.KV, (days = new Map()));
  const cached = days.get(day);
  if (cached) return cached;
  for (const old of days.keys()) if (old !== day) days.delete(old);
  const pending = (async () => {
    const key = `salt:${day}`;
    const stored = await env.KV.get(key);
    if (stored) return stored;
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await env.KV.put(key, salt, { expirationTtl: SALT_TTL_SEC });
    return salt;
  })();
  days.set(day, pending);
  // A failed KV call must not poison the day: the next visitor tries again.
  pending.catch(() => days.delete(day));
  return pending;
}

/**
 * A 16 character id for "the same visitor today in this scope", without storing who they are.
 * It is a SHA-256 of a random daily salt, the scope (for example a link or form id), the IP and
 * the user agent. The salt is thrown away after 48 hours, so ids cannot be linked across days and
 * the IP address is never stored or logged.
 */
export async function visitorId(env: Env, scope: string, req: Request, now: number = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  const salt = await dailySalt(env, day);
  const input = [salt, scope, clientIp(req) ?? '', req.headers.get('user-agent') ?? ''].join('\0');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(digest)).slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Safe outbound fetch
// ---------------------------------------------------------------------------------------------

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** Eight 16-bit groups from the text between the brackets of an IPv6 URL host, or null when it is malformed. */
function parseIPv6(text: string): number[] | null {
  let body = text;
  // A dotted IPv4 tail ("::ffff:1.2.3.4"). The URL parser rewrites these to hex, but be safe.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (tail) {
    const v4 = parseIPv4(tail[1]!);
    if (!v4) return null;
    body = body.slice(0, -tail[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

function privateIPv6(g: number[]): boolean {
  const first = g[0]!;
  const embedded = (hi: number, lo: number) => privateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // unique local, fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link local, fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // site local, fec0::/10 (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (zeros(0, 5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // IPv4-mapped ::ffff:a.b.c.d
  if (zeros(0, 6)) return embedded(g[6]!, g[7]!); // IPv4-compatible ::a.b.c.d (deprecated)
  if (first === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((n) => n === 0) ? embedded(g[6]!, g[7]!) : true; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (first === 0x2002) return embedded(g[1]!, g[2]!); // 6to4 2002:a.b.c.d::/48
  return false;
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Parse a user-supplied address and refuse anything that is not a public web address: other
 * schemes, credentials in the URL, local and private hostnames, and private IP ranges in every
 * spelling the URL parser normalises (decimal, hex, octal, IPv4-mapped IPv6 and so on).
 *
 * A Worker cannot resolve DNS, so a public name that points at a private address is not caught
 * here. Workers cannot reach private networks anyway, which is what makes this check enough.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw netErrors.url_not_allowed();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw netErrors.url_not_allowed();
  if (url.username || url.password) throw netErrors.url_not_allowed();

  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) throw netErrors.url_not_allowed();

  if (host.startsWith('[')) {
    const groups = parseIPv6(host.slice(1, -1));
    if (!groups || privateIPv6(groups)) throw netErrors.url_not_allowed();
    return url;
  }

  const v4 = parseIPv4(host);
  if (v4) {
    if (privateIPv4(v4)) throw netErrors.url_not_allowed();
    return url;
  }
  // A last label that is all digits is an IPv4 spelling the URL parser did not accept: refuse it.
  if (/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) throw netErrors.url_not_allowed();

  const singleLabel = !host.includes('.');
  if (singleLabel || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1))) {
    throw netErrors.url_not_allowed();
  }
  return url;
}

export interface SafeFetchInit extends RequestInit {
  /** Give up after this long, body included. Default 8000. */
  timeoutMs?: number;
  /** Largest body to read. Default 1,000,000 bytes. */
  maxBytes?: number;
  /** Redirects to follow, each one checked. Default 3. */
  maxRedirects?: number;
  /** Cut the body at `maxBytes` instead of failing with `fetch_too_large`. */
  truncate?: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY = new Set([101, 204, 205, 304]);
/** Describe the buffered body we hand back, not the bytes that came over the wire. */
const WIRE_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding'];

async function readCapped(res: Response, maxBytes: number, truncate: boolean): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (!truncate && declared > maxBytes) {
    await res.body?.cancel();
    throw netErrors.fetch_too_large();
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      if (!truncate) throw netErrors.fetch_too_large();
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch a user-supplied URL without letting it reach anything private. Every hop (the first
 * request and each redirect) goes through `assertPublicUrl`, the time and size are capped, and
 * the whole body is buffered, so the caller gets an ordinary `Response` it can read twice.
 * Cookies and authorization headers are dropped when a redirect leaves the original host.
 * Throws `url_not_allowed`, `fetch_timeout`, `fetch_too_large`, `too_many_redirects` or `fetch_failed`.
 */
export async function safeFetch(url: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const { timeoutMs = 8000, maxBytes = 1_000_000, maxRedirects = 3, truncate = false, ...rest } = init;
  let current = assertPublicUrl(String(url));
  let method = (rest.method ?? 'GET').toUpperCase();
  let body = rest.body;
  const headers = new Headers(rest.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', 'Toolshed');

  const controller = new AbortController();
  rest.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(netErrors.fetch_timeout());
    }, timeoutMs);
  });

  const run = async (): Promise<Response> => {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current.toString(), { ...rest, method, body, headers, redirect: 'manual', signal: controller.signal });
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || !location) {
        const bytes = NO_BODY.has(res.status) ? null : await readCapped(res, maxBytes, truncate);
        const out = new Headers(res.headers);
        for (const name of WIRE_HEADERS) out.delete(name);
        return new Response(bytes, { status: res.status, statusText: res.statusText, headers: out });
      }
      await res.body?.cancel();
      if (hop >= maxRedirects) throw netErrors.too_many_redirects();
      const next = assertPublicUrl(new URL(location, current).toString());
      if (next.host !== current.host) {
        headers.delete('cookie');
        headers.delete('authorization');
        headers.delete('proxy-authorization');
      }
      // Browsers turn a redirected POST into a GET; a 307 or 308 keeps the method and body.
      if (res.status === 303 ? method !== 'GET' && method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST') {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.delete('content-length');
      }
      current = next;
    }
  };

  try {
    return await Promise.race([run(), timedOut]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw netErrors.fetch_failed();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
