/** Public routes under /w: hosted page, embed, sign-up endpoint, status pages, invites and unsubscribe. */
import { Hono, type Context } from 'hono';
import { orgDb } from '../../core/db';
import { AppError, jsonError } from '../../core/errors';
import { enforceRateLimit } from '../../core/ratelimit';
import { getSetting } from '../../core/settings';
import type { AppEnv, Env } from '../../env';
import { parseAppearance, type Appearance } from '../../ui/appearance';
import { wlErrors } from './errors';
import { statusLink } from './emails';
import { makeToken, readToken, baseUrl, visitorHash } from './platform';
import { leaderboard, publicCount } from './queue';
import { afterJoin, confirm, findBySlug, findByToken, join, personView, sendStatusLink, trackAcceptance } from './signups';
import { recordView } from './stats';
import type { Waitlist } from './types';
import { BoardPage, FindPage, JoinPage, MessagePage, StatusPage } from './views';
import { PublicButton } from '../../ui/public';

type C = Context<AppEnv>;

/** A form that arrives sooner than this after the page loaded was filled by a script. */
const MIN_FILL_MS = 2000;
const PREVIEW_TTL = 3600;

export const publicApp = new Hono<AppEnv>();

const BOT = /bot|crawl|spider|preview|curl|wget|fetch|monitor|python|headless/i;

function defer(c: C, work: Promise<unknown>): Promise<unknown> {
  const safe = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(safe);
    return Promise.resolve();
  } catch {
    return safe;
  }
}

async function look(env: Env, wl: Waitlist): Promise<Appearance> {
  return parseAppearance(await getSetting<Record<string, unknown>>(env, wl.org_id, 'appearance', {}));
}

/** A link that opens the hosted page for the owner: its signups are test signups, and it works before launch. */
export async function previewLink(env: Env, base: string, wl: Waitlist): Promise<string> {
  return `${base}/w/${wl.slug}?preview=${await makeToken(env, 'wl-preview', { w: wl.id }, PREVIEW_TTL)}`;
}

async function validPreview(env: Env, wl: Waitlist, token: unknown): Promise<string> {
  if (typeof token !== 'string' || !token) return '';
  const p = await readToken<{ w: string }>(env, 'wl-preview', token);
  return p && p.w === wl.id ? token : '';
}

function page(c: C, body: unknown, status: 200 | 404 | 422 = 200): Response {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  return c.html(body as string, status);
}

function notFound(c: C): Response {
  return c.html('<!doctype html><title>Not found</title><p>That page does not exist.</p>', 404);
}

function cors(c: C): void {
  c.header('access-control-allow-origin', '*');
  c.header('vary', 'origin');
}

function carryFrom(q: Record<string, string>): Record<string, string> {
  const pick = (k: string, ...alts: string[]) => [k, ...alts].map((n) => q[n]).find(Boolean)?.slice(0, 60) ?? '';
  return { ref: pick('ref').slice(0, 24), source: pick('source', 'utm_source'), medium: pick('medium', 'utm_medium'), campaign: pick('campaign', 'utm_campaign') };
}

async function showJoin(c: C, wl: Waitlist, extra: { values?: Record<string, string>; errors?: Record<string, string>; notice?: string; carry?: Record<string, string>; preview?: string } = {}, embed = false): Promise<Response> {
  const now = Date.now();
  const preview = extra.preview ?? (await validPreview(c.env, wl, c.req.query('preview')));
  if (wl.status === 'draft' && !preview) return notFound(c);
  const [appearance, count, token] = await Promise.all([
    look(c.env, wl),
    wl.show_count ? publicCount(c.env, wl) : Promise.resolve(null),
    makeToken(c.env, 'wl-form', { w: wl.id, at: now }, 6 * 3600),
  ]);
  const ua = c.req.header('user-agent') ?? '';
  if (wl.status === 'live' && !preview && !BOT.test(ua) && c.req.method === 'GET') void defer(c, recordView(orgDb(c.env.DB, wl.org_id), wl));
  return page(c, <JoinPage wl={wl} look={appearance} count={count} token={token} preview={preview} embed={embed} carry={extra.carry ?? carryFrom(c.req.query())} now={now} values={extra.values} errors={extra.errors} notice={extra.notice} />);
}

// ---- Unsubscribe: registered first so the word is never read as a waitlist address ----

async function unsubscribeTarget(c: C): Promise<string | null> {
  const t = await readToken<{ s: string }>(c.env, 'wl-unsub', c.req.param('token') ?? '');
  return t ? t.s : null;
}

publicApp.get('/w/unsubscribe/:token', async (c) => {
  const id = await unsubscribeTarget(c);
  const row = id ? await c.env.DB.prepare('SELECT s.waitlist_id AS wid FROM wl_signups s WHERE s.id = ?1').bind(id).first<{ wid: string }>() : null;
  const wl = row ? await c.env.DB.prepare('SELECT * FROM wl_waitlists WHERE id = ?1').bind(row.wid).first<Waitlist>() : null;
  const appearance = wl ? await look(c.env, wl) : parseAppearance({});
  if (!id) return page(c, <MessagePage look={appearance} title="This link has expired"><p>Ask the sender for a new email, or reply to it and ask to be removed.</p></MessagePage>, 404);
  return page(c, (
    <MessagePage look={appearance} title="Unsubscribe">
      <p>You will stop getting emails about this waitlist. You keep your place.</p>
      <form method="post"><PublicButton type="submit" block>Unsubscribe</PublicButton></form>
    </MessagePage>
  ));
});

publicApp.post('/w/unsubscribe/:token', async (c) => {
  const id = await unsubscribeTarget(c);
  if (id) await c.env.DB.prepare('UPDATE wl_signups SET unsubscribed_at = ?1 WHERE id = ?2 AND unsubscribed_at IS NULL').bind(Date.now(), id).run();
  return page(c, <MessagePage look={parseAppearance({})} title={id ? 'You are unsubscribed' : 'This link has expired'}><p>{id ? 'We will not email you about this waitlist again.' : 'Ask the sender for a new email.'}</p></MessagePage>);
});

// ---- Hosted page and embed ----

async function slugged(c: C): Promise<Waitlist | null> {
  return findBySlug(c.env, c.req.param('slug') ?? '');
}

publicApp.get('/w/:slug', async (c) => {
  const wl = await slugged(c);
  return wl ? showJoin(c, wl) : notFound(c);
});

publicApp.get('/w/:slug/embed', async (c) => {
  const wl = await slugged(c);
  return wl ? showJoin(c, wl, {}, true) : notFound(c);
});

publicApp.get('/w/:slug/thanks', async (c) => {
  const wl = await slugged(c);
  if (!wl) return notFound(c);
  return page(c, <MessagePage look={await look(c.env, wl)} title="Thank you"><p>{wl.success_message || 'You are on the list. If you do not see an email soon, check your spam folder.'}</p></MessagePage>);
});

// ---- Sign-up ----

const ALLOW = 'content-type';

publicApp.options('/w/:slug/join', (c) => {
  cors(c);
  c.header('access-control-allow-methods', 'POST, OPTIONS');
  c.header('access-control-allow-headers', ALLOW);
  c.header('access-control-max-age', '86400');
  return c.body(null, 204);
});

async function readBody(c: C): Promise<{ body: Record<string, unknown>; json: boolean }> {
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    const raw = (await c.req.json().catch(() => ({}))) as unknown;
    return { body: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}, json: true };
  }
  const form = await c.req.parseBody().catch(() => ({}));
  return { body: form as Record<string, unknown>, json: false };
}

function answersOf(body: Record<string, unknown>): Record<string, unknown> {
  if (body.answers && typeof body.answers === 'object') return body.answers as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (k.startsWith('a_')) out[k.slice(2)] = v;
  return out;
}

publicApp.post('/w/:slug/join', async (c) => {
  const wl = await slugged(c);
  const { body, json } = await readBody(c);
  if (json) cors(c);
  if (!wl) return json ? jsonError(c, wlErrors.not_found()) : notFound(c);
  const base = baseUrl(c);
  const thanks = () => (json ? c.json({ ok: true }) : c.redirect(`/w/${wl.slug}/thanks`, 303));
  if (typeof body.website === 'string' && body.website.trim() !== '') return thanks();
  try {
    const now = Date.now();
    const preview = await validPreview(c.env, wl, body.p);
    const form = typeof body.t === 'string' ? await readToken<{ w: string; at: number }>(c.env, 'wl-form', body.t, now) : null;
    if (form && form.w === wl.id && now - form.at < MIN_FILL_MS) throw wlErrors.too_fast();
    const visitor = await visitorHash(c.env, c.req.raw);
    await enforceRateLimit(c.env, `wl.join:${visitor}`, { limit: 10, windowSec: 600 }, 'Too many tries. Wait a few minutes and try again.');
    const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const result = await join(c.env, wl, { email: body.email, name: body.name, answers: answersOf(body), ref: text('ref'), source: text('source') || text('utm_source'), medium: text('medium') || text('utm_medium'), campaign: text('campaign') || text('utm_campaign'), test: Boolean(preview), visitor, base }, now);
    if (result.kind === 'existing') return thanks();
    const s = result.signup;
    void defer(c, afterJoin(c.env, s.id, base));
    const statusUrl = statusLink(base, wl, s);
    if (!json) return c.redirect(`/w/${wl.slug}/me/${s.token}`, 303);
    return c.json({ ok: true, status: s.status === 'flagged' ? 'review' : s.status, needsConfirm: result.needsConfirm, position: result.position, referralCode: s.code, referralLink: `${base}/w/${wl.slug}?ref=${s.code}`, statusUrl }, 201);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (json) return jsonError(c, err);
    const strings = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    return showJoinError(c, wl, err, strings);
  }
});

async function showJoinError(c: C, wl: Waitlist, err: AppError, values: Record<string, string>): Promise<Response> {
  const fields = err.fields ?? {};
  const res = await showJoin(c, wl, { values, errors: fields, notice: Object.keys(fields).length ? undefined : err.message, carry: { ref: values.ref ?? '', source: values.source ?? '', medium: values.medium ?? '', campaign: values.campaign ?? '' }, preview: await validPreview(c.env, wl, values.p) });
  return new Response(res.body, { status: err.status === 429 ? 429 : 422, headers: res.headers });
}

// ---- Personal pages ----

publicApp.get('/w/:slug/me/:token', async (c) => {
  const found = await findByToken(c.env, c.req.param('token') ?? '');
  if (!found || found.wl.slug !== c.req.param('slug')) return notFound(c);
  const { wl, s } = found;
  const view = await personView(c.env, wl, s);
  const base = baseUrl(c);
  const inviteUrl = s.invite_code ? `${base}/w/${wl.slug}/invite/${s.invite_code}` : null;
  return page(c, <StatusPage wl={wl} look={await look(c.env, wl)} view={view} base={base} inviteUrl={inviteUrl} />);
});

publicApp.get('/w/:slug/confirm/:token', async (c) => {
  const found = await findByToken(c.env, c.req.param('token') ?? '');
  if (!found || found.wl.slug !== c.req.param('slug')) return notFound(c);
  return page(c, (
    <MessagePage look={await look(c.env, found.wl)} title="Confirm your email">
      <p>One more step. Confirm that this address is yours to save your place on {found.wl.name}.</p>
      <form method="post"><PublicButton type="submit" block>Confirm my email</PublicButton></form>
    </MessagePage>
  ));
});

publicApp.post('/w/:slug/confirm/:token', async (c) => {
  const found = await findByToken(c.env, c.req.param('token') ?? '');
  if (!found || found.wl.slug !== c.req.param('slug')) return notFound(c);
  await enforceRateLimit(c.env, `wl.confirm:${await visitorHash(c.env, c.req.raw)}`, { limit: 20, windowSec: 600 });
  const done = await confirm(c.env, found.wl, found.s, baseUrl(c));
  return c.redirect(`/w/${found.wl.slug}/me/${done.token}`, 303);
});

publicApp.get('/w/:slug/me', async (c) => {
  const wl = await slugged(c);
  return wl ? page(c, <FindPage wl={wl} look={await look(c.env, wl)} sent={false} />) : notFound(c);
});

publicApp.post('/w/:slug/find', async (c) => {
  const wl = await slugged(c);
  if (!wl) return notFound(c);
  const visitor = await visitorHash(c.env, c.req.raw);
  await enforceRateLimit(c.env, `wl.find:${visitor}`, { limit: 5, windowSec: 600 }, 'Too many tries. Wait a few minutes and try again.');
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  void defer(c, sendStatusLink(c.env, wl, body.email, baseUrl(c)));
  return page(c, <FindPage wl={wl} look={await look(c.env, wl)} sent />);
});

// ---- Leaderboard and counts ----

publicApp.get('/w/:slug/leaderboard', async (c) => {
  const wl = await slugged(c);
  if (!wl || !wl.leaderboard_on || wl.status === 'draft') return notFound(c);
  return page(c, <BoardPage wl={wl} look={await look(c.env, wl)} board={await leaderboard(c.env, wl)} />);
});

publicApp.get('/w/:slug/leaderboard.json', async (c) => {
  const wl = await slugged(c);
  if (!wl || !wl.leaderboard_on || wl.status === 'draft') return c.json({ code: 'waitlist.not_found', message: wlErrors.not_found().message }, 404);
  cors(c);
  c.header('cache-control', 'public, max-age=60');
  return c.json({ data: await leaderboard(c.env, wl) });
});

publicApp.get('/w/:slug/count.json', async (c) => {
  const wl = await slugged(c);
  if (!wl || !wl.show_count || wl.status === 'draft') return c.json({ code: 'waitlist.not_found', message: wlErrors.not_found().message }, 404);
  cors(c);
  c.header('cache-control', 'public, max-age=60');
  return c.json({ count: await publicCount(c.env, wl) });
});

// ---- Invites ----

publicApp.get('/w/:slug/invite/:code', async (c) => {
  const wl = await slugged(c);
  if (!wl) return notFound(c);
  const s = await trackAcceptance(c.env, wl, c.req.param('code') ?? '');
  if (!s) return page(c, <MessagePage look={await look(c.env, wl)} title="This invite is not valid"><p>The link may have been copied wrong. Ask the sender for a new one.</p></MessagePage>, 404);
  if (wl.invite_url) {
    const to = new URL(wl.invite_url);
    to.searchParams.set('invite', s.invite_code ?? '');
    return c.redirect(to.toString(), 302);
  }
  return page(c, <MessagePage look={await look(c.env, wl)} title="You are in"><p>Your invite is accepted. We will be in touch with next steps.</p></MessagePage>);
});

