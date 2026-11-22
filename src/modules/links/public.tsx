/**
 * Everything strangers reach: the short link redirect (the module `fallback` for /<code>), the
 * bio pages, and the utility pages under /l (password gate, preview, report form, QR codes).
 */
import { Hono, type Context } from 'hono';
import type { HtmlEscapedString } from 'hono/utils/html';
import { encode, renderSVG } from 'uqr';
import { verifyPassword } from '../../auth/hasher';
import { errors } from '../../core/errors';
import { baseUrl, clientIp, geo, isPreviewBot, parseUserAgent } from '../../core/net';
import { enforceRateLimit } from '../../core/ratelimit';
import { moduleState } from '../../core/registry';
import { getSetting } from '../../core/settings';
import { readSignedToken, signedToken } from '../../core/signing';
import type { AppEnv, Env } from '../../env';
import { parseAppearance, type Appearance } from '../../ui';
import { createReport } from './abuse';
import type { BioRow, BlockRow } from './bios';
import { bust, linkKey, pageKey, putCached, LINK_TTL_SEC, PAGE_TTL_SEC } from './cache';
import { CODE_PATTERN } from './codes';
import { BioPage, bioCss, NoticePage, noticeStatus, PasswordPage, PreviewPage, ReportDonePage, ReportPage, socialPreviewHtml } from './pages';
import { recordVisit, visitFromRequest, type VisitKind } from './record';
import { noteCapReached } from './rollup';
import { linkState, type LinkRow, type LinkState, type RuleDef } from './types';

/** What the redirect needs about a link, kept small so one KV read serves a visit. */
export interface Rec {
  k: 'link' | 'bio';
  org: string;
  id: string;
  code: string;
  url?: string;
  type?: number;
  s?: LinkRow['status'];
  from?: number | null;
  to?: number | null;
  cap?: number | null;
  pw?: boolean;
  eu?: string | null;
  fq?: boolean;
  rules?: RuleDef[];
  title?: string;
  pv?: { t: string; d: string; i: string };
}

export function toRec(row: LinkRow): Rec {
  let rules: RuleDef[] = [];
  try {
    rules = JSON.parse(row.rules) as RuleDef[];
  } catch {
    rules = [];
  }
  return {
    k: 'link', org: row.org_id, id: row.id, code: row.code, url: row.url, type: row.redirect_type, s: row.status,
    from: row.starts_at, to: row.expires_at, cap: row.click_cap, pw: !!row.password_hash, eu: row.expired_url,
    fq: row.forward_query === 1, rules, title: row.title, pv: { t: row.preview_title, d: row.preview_description, i: row.preview_image },
  };
}

const defer = (c: Context<AppEnv>, work: Promise<unknown>): void => {
  const p = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No execution context (some test setups): the promise still runs.
  }
};

/** Find a code: KV first, then the database. Only a miss costs database reads. */
export async function lookup(env: Env, code: string): Promise<Rec | null> {
  const hit = await env.KV.get(linkKey(code));
  if (hit) {
    try {
      return JSON.parse(hit) as Rec;
    } catch {
      // fall through to the database
    }
  }
  const slug = await env.DB.prepare('SELECT org_id, kind, target_id FROM links_slugs WHERE code = ?1').bind(code).first<{ org_id: string; kind: string; target_id: string }>();
  if (!slug) return null;
  if (!(await moduleState(env, slug.org_id, 'links')).enabled) return null;
  let rec: Rec;
  if (slug.kind === 'bio') rec = { k: 'bio', org: slug.org_id, id: slug.target_id, code };
  else {
    const row = await env.DB.prepare('SELECT * FROM links_links WHERE id = ?1').bind(slug.target_id).first<LinkRow>();
    if (!row) return null;
    rec = toRec(row);
  }
  await putCached(env, linkKey(code), JSON.stringify(rec), LINK_TTL_SEC);
  return rec;
}

async function appearanceOf(env: Env, orgId: string): Promise<Appearance> {
  return parseAppearance(await getSetting<Record<string, string>>(env, orgId, 'appearance', {}));
}

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

function redirectTo(url: string, status: number): Response {
  return new Response(null, { status, headers: { location: url, ...NO_STORE } });
}

function html(c: Context<AppEnv>, body: string | Promise<HtmlEscapedString>, status = 200): Response | Promise<Response> {
  for (const [k, v] of Object.entries(NO_STORE)) c.header(k, v);
  if (typeof body === 'string') return c.body(body, status as 200, { 'content-type': 'text/html; charset=utf-8' });
  return c.html(body, status as 200);
}

/** Add the query the visitor arrived with (not `qr`) to the destination, never replacing what is already there. */
export function forwardQuery(dest: string, incoming: URLSearchParams): string {
  try {
    const u = new URL(dest);
    for (const [k, v] of incoming) if (k !== 'qr' && !u.searchParams.has(k)) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return dest;
  }
}

function osName(ua: string | null): string {
  const os = parseUserAgent(ua).os.toLowerCase();
  return os === 'ipados' ? 'ios' : os;
}

/** The destination for this visitor: the first matching rule, else the link's own address. */
export function pickDestination(rec: Rec, req: Request): string {
  const rules = rec.rules ?? [];
  if (rules.length) {
    const ua = req.headers.get('user-agent');
    const country = (geo(req).country ?? '').toUpperCase();
    const device = parseUserAgent(ua).device;
    const os = osName(ua);
    for (const r of rules) {
      const v = r.kind === 'country' ? country : r.kind === 'device' ? device : os;
      if (v && r.values.includes(v)) return r.url;
    }
  }
  return rec.url ?? '';
}

async function clicksSoFar(env: Env, id: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(clicks), 0) AS n FROM links_daily WHERE target_id = ?1 AND kind = 'click'`).bind(id).first<{ n: number }>();
  return r?.n ?? 0;
}

function track(c: Context<AppEnv>, rec: Rec, kind: VisitKind, extra: { blockId?: string; qr?: boolean } = {}): void {
  if (c.req.method === 'HEAD') return;
  defer(c, (async () => {
    const v = await visitFromRequest(c.env, c.req.raw, { orgId: rec.org, targetId: rec.id, code: rec.code, kind, blockId: extra.blockId, qr: extra.qr });
    await recordVisit(c.env, v);
  })());
}

// ---------------------------------------------------------------------------------------------
// The redirect
// ---------------------------------------------------------------------------------------------

async function serveLink(c: Context<AppEnv>, rec: Rec, opts: { passwordOk?: boolean } = {}): Promise<Response> {
  const now = Date.now();
  const used = rec.cap != null ? await clicksSoFar(c.env, rec.id) : 0;
  const state = linkState({ status: rec.s ?? 'active', starts_at: rec.from ?? null, expires_at: rec.to ?? null, click_cap: rec.cap ?? null }, used, now);
  if (state !== 'live') {
    if (state === 'capped') defer(c, noteCapReached(c.env, { id: rec.id, org_id: rec.org, code: rec.code }));
    if ((state === 'expired' || state === 'capped') && rec.eu) return redirectTo(rec.eu, 302);
    return html(c, <NoticePage state={state} appearance={await appearanceOf(c.env, rec.org)} />, noticeStatus(state));
  }
  const ua = c.req.header('user-agent') ?? null;
  const url = new URL(c.req.url);
  const qr = url.searchParams.get('qr') === '1';
  if (isPreviewBot(ua) && (rec.pv?.t || rec.pv?.d || rec.pv?.i)) {
    track(c, rec, 'click');
    const body = socialPreviewHtml({ url: `${baseUrl(c)}/${rec.code}`, title: rec.pv.t || rec.title || rec.code, description: rec.pv.d, image: rec.pv.i });
    return html(c, body);
  }
  if (rec.pw && !opts.passwordOk) return redirectTo(`/l/p/${rec.code}`, 302);
  let dest = pickDestination(rec, c.req.raw);
  if (rec.fq) dest = forwardQuery(dest, url.searchParams);
  track(c, rec, 'click', { qr });
  return redirectTo(dest, opts.passwordOk ? 303 : (rec.type ?? 302));
}

async function previewResponse(c: Context<AppEnv>, rec: Rec): Promise<Response> {
  const used = rec.cap != null ? await clicksSoFar(c.env, rec.id) : 0;
  const state = linkState({ status: rec.s ?? 'active', starts_at: rec.from ?? null, expires_at: rec.to ?? null, click_cap: rec.cap ?? null }, used);
  return html(c, <PreviewPage appearance={await appearanceOf(c.env, rec.org)} info={{ code: rec.code, shortUrl: `${baseUrl(c)}/${rec.code}`, title: rec.title ?? '', destination: rec.url ?? '', protectedByPassword: !!rec.pw, state }} />);
}

// ---------------------------------------------------------------------------------------------
// Bio pages
// ---------------------------------------------------------------------------------------------

async function renderBio(env: Env, rec: Rec): Promise<string | null> {
  const cached = await env.KV.get(pageKey(rec.code));
  if (cached) return cached;
  const bio = await env.DB.prepare('SELECT * FROM links_bios WHERE id = ?1').bind(rec.id).first<BioRow>();
  if (!bio || bio.published !== 1) return null;
  const { results } = await env.DB.prepare('SELECT * FROM links_bio_blocks WHERE bio_id = ?1 AND visible = 1 ORDER BY position, id').bind(bio.id).all<BlockRow>();
  const page = String(await (<BioPage bio={bio} blocks={results} appearance={await appearanceOf(env, rec.org)} />));
  await putCached(env, pageKey(rec.code), page, PAGE_TTL_SEC);
  return page;
}

// ---------------------------------------------------------------------------------------------
// The fallback: /<code>, /<code>+
// ---------------------------------------------------------------------------------------------

export async function fallback(c: Context<AppEnv>): Promise<Response | null> {
  let path = new URL(c.req.url).pathname.slice(1);
  if (path.endsWith('/')) path = path.slice(0, -1);
  let preview = false;
  if (path.endsWith('+')) {
    preview = true;
    path = path.slice(0, -1);
  }
  if (!path || path.length > 64 || /[./%]/.test(path)) return null;
  const code = path.toLowerCase();
  if (!CODE_PATTERN.test(code)) return null;
  const rec = await lookup(c.env, code);
  if (!rec) return null;
  if (rec.k === 'bio') {
    if (preview) return null;
    const page = await renderBio(c.env, rec);
    if (!page) return null;
    track(c, rec, 'view');
    return html(c, page);
  }
  return preview ? previewResponse(c, rec) : serveLink(c, rec);
}

// ---------------------------------------------------------------------------------------------
// /l routes
// ---------------------------------------------------------------------------------------------

const REPORT_PURPOSE = 'links.report';
const REPORT_MIN_AGE_MS = 3000;

export const publicApp = new Hono<AppEnv>();

async function linkRec(c: Context<AppEnv>): Promise<Rec> {
  const code = (c.req.param('code') ?? '').toLowerCase();
  const rec = CODE_PATTERN.test(code) ? await lookup(c.env, code) : null;
  if (!rec || rec.k !== 'link') throw errors.not_found('We couldn’t find that link.');
  return rec;
}

publicApp.get('/l/preview/:code', async (c) => previewResponse(c, await linkRec(c)));

publicApp.get('/l/p/:code', async (c) => {
  const rec = await linkRec(c);
  if (!rec.pw) return redirectTo(`/${rec.code}`, 302);
  return html(c, <PasswordPage code={rec.code} appearance={await appearanceOf(c.env, rec.org)} />);
});

publicApp.post('/l/p/:code', async (c) => {
  const rec = await linkRec(c);
  const ip = clientIp(c.req.raw) ?? 'unknown';
  await enforceRateLimit(c.env, `links:pw:${ip}:${rec.code}`, { limit: 8, windowSec: 600 }, 'Too many tries. Wait a few minutes and try again.');
  await enforceRateLimit(c.env, `links:pwc:${rec.code}`, { limit: 60, windowSec: 600 }, 'Too many tries on this link. Wait a few minutes and try again.');
  const row = await c.env.DB.prepare('SELECT * FROM links_links WHERE id = ?1').bind(rec.id).first<LinkRow>();
  if (!row?.password_hash) return redirectTo(`/${rec.code}`, 302);
  const body = await c.req.parseBody();
  const given = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  if (!given || !(await verifyPassword(given, row.password_hash))) {
    return html(c, <PasswordPage code={rec.code} error="That password isn’t right." appearance={await appearanceOf(c.env, rec.org)} />, 403);
  }
  return serveLink(c, toRec(row), { passwordOk: true });
});

publicApp.get('/l/report/:code', async (c) => {
  const rec = await linkRec(c);
  const token = await signedToken(c.env, REPORT_PURPOSE, { c: rec.code, at: Date.now() }, 3600);
  return html(c, <ReportPage code={rec.code} token={token} appearance={await appearanceOf(c.env, rec.org)} />);
});

publicApp.post('/l/report/:code', async (c) => {
  const rec = await linkRec(c);
  const ip = clientIp(c.req.raw) ?? 'unknown';
  await enforceRateLimit(c.env, `links:report:${ip}`, { limit: 5, windowSec: 3600 }, 'You have sent a few reports already. Try again later.');
  await enforceRateLimit(c.env, `links:reportc:${rec.code}`, { limit: 30, windowSec: 3600 }, 'This link has had many reports. Try again later.');
  const appearance = await appearanceOf(c.env, rec.org);
  const form = await c.req.parseBody();
  const str = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');
  const tok = await readSignedToken<{ c: string; at: number }>(c.env, REPORT_PURPOSE, str('t'));
  const fresh = !!tok && tok.c === rec.code && Date.now() - tok.at >= REPORT_MIN_AGE_MS;
  // A filled honeypot or a form sent too fast is a bot: say thanks and store nothing.
  if (str('website') || !tok || tok.c !== rec.code) return html(c, <ReportDonePage appearance={appearance} />);
  if (!fresh) return html(c, <ReportDonePage appearance={appearance} />);
  try {
    await createReport(c.env, rec.code, { reason: str('reason'), details: str('details') || undefined, contact: str('contact') || undefined });
  } catch (e) {
    if ((e as { status?: number }).status === 422) {
      const token = await signedToken(c.env, REPORT_PURPOSE, { c: rec.code, at: Date.now() - REPORT_MIN_AGE_MS }, 3600);
      return html(c, <ReportPage code={rec.code} token={token} error="Pick what is wrong with this link." values={{ reason: str('reason'), details: str('details'), contact: str('contact') }} appearance={appearance} />, 422);
    }
    throw e;
  }
  return html(c, <ReportDonePage appearance={appearance} />);
});

publicApp.get('/l/b/:blockId', async (c) => {
  const id = c.req.param('blockId');
  const row = await c.env.DB.prepare(
    `SELECT b.url, b.id, b.org_id, b.bio_id, s.code FROM links_bio_blocks b JOIN links_bios o ON o.id = b.bio_id JOIN links_slugs s ON s.target_id = o.id
     WHERE b.id = ?1 AND b.visible = 1 AND o.published = 1 AND b.kind IN ('link', 'social')`,
  ).bind(id).first<{ url: string; id: string; org_id: string; bio_id: string; code: string }>();
  if (!row || !row.url) throw errors.not_found('We couldn’t find that link.');
  if (!(await moduleState(c.env, row.org_id, 'links')).enabled) throw errors.not_found('We couldn’t find that link.');
  track(c, { k: 'bio', org: row.org_id, id: row.bio_id, code: row.code }, 'block', { blockId: row.id });
  return redirectTo(row.url, 302);
});

publicApp.get('/l/s/:file', async (c) => {
  const code = (c.req.param('file') ?? '').replace(/\.css$/, '').toLowerCase();
  const bio = CODE_PATTERN.test(code) ? await c.env.DB.prepare('SELECT colors FROM links_bios WHERE code = ?1 AND published = 1').bind(code).first<Pick<BioRow, 'colors'>>() : null;
  if (!bio) throw errors.not_found('We couldn’t find that page.');
  return c.body(bioCss(bio), 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});

const hexParam = (v: string | undefined, fallbackColor: string): string => {
  const s = (v ?? '').replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}` : fallbackColor;
};
const intParam = (v: string | undefined, min: number, max: number, def: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** A QR code (SVG) for a short link or bio page. Scans carry `?qr=1` so they are counted as QR scans. */
export function qrSvg(base: string, code: string, q: { size?: string; margin?: string; fg?: string; bg?: string; ecc?: string }): string {
  const ecc = (['L', 'M', 'Q', 'H'] as const).find((e) => e === (q.ecc ?? '').toUpperCase()) ?? 'M';
  const margin = intParam(q.margin, 0, 10, 2);
  const size = intParam(q.size, 96, 2048, 512);
  const data = `${base}/${code}?qr=1`;
  const modules = encode(data, { ecc }).size;
  const pixelSize = Math.max(1, Math.floor(size / (modules + margin * 2)));
  const svg = renderSVG(data, { ecc, border: margin, pixelSize, whiteColor: hexParam(q.bg, '#ffffff'), blackColor: hexParam(q.fg, '#000000') });
  const edge = (modules + margin * 2) * pixelSize;
  return svg.replace('<svg ', `<svg width="${edge}" height="${edge}" role="img" aria-label="QR code for ${code}" `);
}

publicApp.get('/l/qr/:code', (c) => {
  const code = (c.req.param('code') ?? '').toLowerCase();
  if (!CODE_PATTERN.test(code)) throw errors.not_found('We couldn’t find that link.');
  const svg = qrSvg(baseUrl(c), code, c.req.query());
  const headers: Record<string, string> = { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' };
  if (c.req.query('download') === '1') headers['content-disposition'] = `attachment; filename="${code}-qr.svg"`;
  return c.body(svg, 200, headers);
});

export { bust };
