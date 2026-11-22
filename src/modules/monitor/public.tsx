/** Public routes: heartbeat pings, and the status page with its feeds, badge, widget data and email subscriptions. */
import { Hono } from 'hono';
import { rateLimit } from '../../core/ratelimit';
import { getSetting } from '../../core/settings';
import { clientIp } from '../../core/net';
import { baseUrl } from '../../core/net';
import { AppError } from '../../core/errors';
import type { AppEnv } from '../../env';
import { parseAppearance, type Appearance } from '../../ui/appearance';
import { atomFeed, badgeSvg, rssFeed, statusJson } from './feeds';
import { recordPing, type PingKind } from './heartbeats';
import { loadStatus, safeCss, STATUS_LABEL } from './pages';
import { NoticePage, StatusPage, UnsubscribePage } from './status-page';
import { confirmSubscriber, subscribe, unsubscribeByToken } from './subscribers';
import type { PageRow } from './schema';

const app = new Hono<AppEnv>();

const text = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });

/* ------------------------------------------------------------------ heartbeats */

async function ping(c: import('hono').Context<AppEnv>, kind: PingKind): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const ip = clientIp(c.req.raw) ?? 'unknown';
  let note: string | null = c.req.query('msg') ?? null;
  if (!note && c.req.method === 'POST') {
    try {
      note = (await c.req.text()).slice(0, 200) || null;
    } catch {
      note = null;
    }
  }
  const codeRaw = c.req.query('code') ?? c.req.query('exit');
  const code = codeRaw !== undefined && /^-?\d{1,4}$/.test(codeRaw) ? Number(codeRaw) : null;
  // A fail ping can also say so with a non-zero exit code on the normal URL, the way cron wrappers report.
  const effective: PingKind = kind === 'success' && code !== null && code !== 0 ? 'fail' : kind;
  const res = await recordPing(c.env, token, effective, { code, note });
  if (res === 'unknown') {
    const rl = await rateLimit(c.env, `mon.hb404:${ip}`, { limit: 30, windowSec: 60 });
    return text('Unknown ping address', rl.ok ? 404 : 429, rl.ok ? {} : { 'retry-after': String(rl.retryAfter) });
  }
  if (res === 'limited') return text('Too many pings for this check. Send at most 12 a minute.', 429, { 'retry-after': '60' });
  return text('OK');
}

app.on(['GET', 'POST'], '/hb/:token', (c) => ping(c, 'success'));
app.on(['GET', 'POST'], '/hb/:token/start', (c) => ping(c, 'start'));
app.on(['GET', 'POST'], '/hb/:token/fail', (c) => ping(c, 'fail'));

/* ------------------------------------------------------------------ status page */

const CORS = { 'access-control-allow-origin': '*' };

async function appearanceFor(c: import('hono').Context<AppEnv>, orgId: string): Promise<Appearance> {
  return parseAppearance(await getSetting<Record<string, unknown>>(c.env, orgId, 'appearance', {}));
}

/** Cache the finished response for a couple of minutes. Skipped where the Cache API does not exist (tests). */
async function cached(c: import('hono').Context<AppEnv>, ttl: number, build: () => Promise<Response>): Promise<Response> {
  const store = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL(c.req.url).origin + new URL(c.req.url).pathname, { method: 'GET' });
  if (store) {
    const hit = await store.match(key).catch(() => undefined);
    if (hit) return hit;
  }
  const res = await build();
  if (store && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('cache-control', `public, max-age=30, s-maxage=${ttl}`);
    try {
      c.executionCtx.waitUntil(store.put(key, copy.clone()));
    } catch {
      // No execution context outside the Worker.
    }
    return copy;
  }
  return res;
}

async function gone(c: import('hono').Context<AppEnv>): Promise<Response> {
  return await c.html(
    <NoticePage title="Status page not found" body="This address doesn’t match a status page. Check the link, or ask whoever sent it to you." appearance={parseAppearance({})} />,
    404,
  );
}

app.get('/status/:slug', async (c) => {
  const slug = c.req.param('slug');
  return cached(c, 120, async () => {
    const data = await loadStatus(c.env, slug);
    if (!data) return gone(c);
    const appearance = await appearanceFor(c, data.page.orgId);
    const res = await c.html(<StatusPage data={data} appearance={appearance} base={baseUrl(c)} />);
    res.headers.set('cache-control', 'public, max-age=30');
    return res;
  });
});

app.get('/status/:slug/status.json', async (c) => {
  const data = await loadStatus(c.env, c.req.param('slug'));
  if (!data) return c.json({ error: { code: 'not_found', message: 'No status page here.' } }, 404, CORS);
  return c.json(statusJson(data, baseUrl(c)), 200, { ...CORS, 'cache-control': 'public, max-age=30, s-maxage=60' });
});

app.get('/status/:slug/feed.rss', async (c) => {
  const data = await loadStatus(c.env, c.req.param('slug'));
  if (!data) return text('Not found', 404);
  return new Response(rssFeed(data, baseUrl(c)), { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=60, s-maxage=120' } });
});

app.get('/status/:slug/feed.atom', async (c) => {
  const data = await loadStatus(c.env, c.req.param('slug'));
  if (!data) return text('Not found', 404);
  return new Response(atomFeed(data, baseUrl(c)), { headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=60, s-maxage=120' } });
});

app.get('/status/:slug/badge.svg', async (c) => {
  const data = await loadStatus(c.env, c.req.param('slug'));
  const body = data ? badgeSvg('status', STATUS_LABEL[data.overall.status].toLowerCase(), data.overall.status) : badgeSvg('status', 'unknown', 'maintenance');
  return new Response(body, { status: data ? 200 : 404, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=60, s-maxage=120', ...CORS } });
});

/** The page's own stylesheet as a file, so a strict Content-Security-Policy never has to allow inline styles. */
app.get('/status/:slug/custom.css', async (c) => {
  const row = await c.env.DB.prepare('SELECT custom_css FROM mon_pages WHERE slug = ?1 AND published = 1').bind(c.req.param('slug')).first<Pick<PageRow, 'custom_css'>>();
  return new Response(safeCss(row?.custom_css ?? null), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60, s-maxage=300' } });
});

/* ------------------------------------------------------------------ subscriptions */

app.post('/status/:slug/subscribe', async (c) => {
  const slug = c.req.param('slug');
  const page = await c.env.DB.prepare('SELECT id, org_id, slug, title, allow_subscribe, published FROM mon_pages WHERE slug = ?1').bind(slug).first<Pick<PageRow, 'id' | 'org_id' | 'slug' | 'title' | 'allow_subscribe' | 'published'>>();
  if (!page || page.published !== 1 || page.allow_subscribe !== 1) return gone(c);
  const appearance = await appearanceFor(c, page.org_id);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
  // A hidden field only bots fill in: pretend it worked.
  if (typeof form.website === 'string' && form.website) {
    return c.html(<NoticePage title="Check your email" body="If that address is valid, we sent a link to confirm it." appearance={appearance} slug={slug} />);
  }
  const ip = clientIp(c.req.raw) ?? 'unknown';
  const rl = await rateLimit(c.env, `mon.sub:${ip}`, { limit: 8, windowSec: 3600 });
  if (!rl.ok) {
    return c.html(<NoticePage title="Too many tries" body={`Please wait ${Math.ceil(rl.retryAfter / 60)} minutes and try again.`} appearance={appearance} slug={slug} />, 429, { 'retry-after': String(rl.retryAfter) });
  }
  try {
    await subscribe(c.env, page, { email: typeof form.email === 'string' ? form.email : '' }, baseUrl(c));
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'email_not_ready') return c.html(<NoticePage title="Email is off" body="This site can’t send email yet, so subscribing is turned off for now." appearance={appearance} slug={slug} />, 503);
      return c.html(<NoticePage title="That didn’t work" body={err.message} appearance={appearance} slug={slug} />, err.status as 400);
    }
    throw err;
  }
  return c.html(<NoticePage title="Check your email" body="If that address is valid, we sent a link to confirm it. Updates start once you click it." appearance={appearance} slug={slug} />);
});

app.get('/status/:slug/confirm/:token', async (c) => {
  const hit = await confirmSubscriber(c.env, c.req.param('token'));
  const slug = c.req.param('slug');
  if (!hit || hit.page.slug !== slug) {
    return c.html(<NoticePage title="This link has expired" body="The confirmation link is no longer valid. Subscribe again from the status page." appearance={parseAppearance({})} slug={slug} />, 404);
  }
  return c.html(<NoticePage title="You’re subscribed" body={`You’ll get an email when ${hit.page.title} reports an incident or maintenance.`} appearance={parseAppearance({})} slug={slug} />);
});

app.get('/status/:slug/unsubscribe/:token', async (c) => {
  const slug = c.req.param('slug');
  const page = await c.env.DB.prepare('SELECT title FROM mon_pages WHERE slug = ?1').bind(slug).first<{ title: string }>();
  if (!page) return gone(c);
  return c.html(<UnsubscribePage slug={slug} token={c.req.param('token')} title={page.title} appearance={parseAppearance({})} />);
});

app.post('/status/:slug/unsubscribe/:token', async (c) => {
  const slug = c.req.param('slug');
  const hit = await unsubscribeByToken(c.env, c.req.param('token'));
  const appearance = parseAppearance({});
  if (!hit) return c.html(<NoticePage title="Already unsubscribed" body="This address isn’t getting updates." appearance={appearance} slug={slug} />);
  return c.html(<NoticePage title="You’re unsubscribed" body={`You won’t get more email from ${hit.page.title}.`} appearance={appearance} slug={slug} />);
});

export default app;
