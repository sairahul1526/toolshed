/** Everything strangers reach, under /n: signup, confirm, unsubscribe, tracking hits, archive and RSS. */
import { Hono, type Context } from 'hono';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { AppEnv, Env } from '../../env';
import { errors } from '../../core/errors';
import { baseUrl, clientIp, isBot } from '../../core/net';
import { enforceRateLimit } from '../../core/ratelimit';
import { moduleState } from '../../core/registry';
import { getSetting } from '../../core/settings';
import { parseAppearance, type Appearance } from '../../ui';
import { resolveBrand } from '../../core/email-templates/brand';
import { archiveIssue, archivePage, archiveRss } from './archive';
import { listBySlug } from './lists';
import { recordClick, recordOpen } from './stats';
import { confirmSubscription, emailOf, joinList, unsubscribe } from './subscribers';
import { readConfirmToken, readUnsubscribeToken } from './tokens';
import { ArchiveIndexPage, ArchiveIssuePage, ConfirmedPage, ConfirmPage, NoticePage, SignupDonePage, SignupPage, UnsubscribedPage, UnsubscribePage } from './pages';
import { ctxOf, type List } from './types';

export const publicApp = new Hono<AppEnv>();

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

async function appearanceOf(env: Env, orgId: string): Promise<Appearance> {
  return parseAppearance(await getSetting<Record<string, string>>(env, orgId, 'appearance', {}));
}

function page(c: Context<AppEnv>, body: Promise<HtmlEscapedString> | HtmlEscapedString, status = 200, indexable = false): Response | Promise<Response> {
  if (!indexable) for (const [k, v] of Object.entries(NO_STORE)) c.header(k, v);
  return c.html(body, status as 200);
}

const notFoundPage = async (c: Context<AppEnv>): Promise<Response> =>
  c.html(<NoticePage title="Page not found" body="This page does not exist or has been taken down." appearance={await appearanceOf(c.env, '')} />, 404);

/** The newsletter behind a slug, or null when it does not exist or the Mail module is switched off for its workspace. */
async function findList(c: Context<AppEnv>, slug: string): Promise<{ list: List; appearance: Appearance } | null> {
  const list = await listBySlug(c.env, slug);
  if (!list) return null;
  if (!(await moduleState(c.env, list.org_id, 'mail')).enabled) return null;
  return { list, appearance: await appearanceOf(c.env, list.org_id) };
}

const badLink = async (c: Context<AppEnv>, orgId = ''): Promise<Response> =>
  page(c, <NoticePage title="This link does not work" body="It may be incomplete, or too old. Ask for a new email." appearance={await appearanceOf(c.env, orgId)} />, 400) as Promise<Response>;

const ipKey = (c: Context<AppEnv>): string => clientIp(c.req.raw) ?? 'unknown';

// Signup -----------------------------------------------------------------------------------------

async function showSignup(c: Context<AppEnv>, embed: boolean): Promise<Response> {
  const found = await findList(c, c.req.param('slug') ?? '');
  if (!found) return notFoundPage(c);
  const { list, appearance } = found;
  const brand = embed ? undefined : (await resolveBrand(c.env, list.org_id)).name;
  return page(c, <SignupPage list={list} appearance={appearance} embed={embed} hasArchive={list.archive_public === 1} {...(brand ? { brand } : {})} />, 200, !embed) as Promise<Response>;
}

publicApp.get('/n/:slug/embed', (c) => showSignup(c, true));

// The signup form posts here from the page, an embed, or any site that copies the form. Same answer for every address.
publicApp.post('/n/:slug/subscribe', async (c) => {
  const embed = c.req.query('embed') === '1';
  const found = await findList(c, c.req.param('slug') ?? '');
  if (!found) return notFoundPage(c);
  const { list, appearance } = found;
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const done = () => page(c, <SignupDonePage list={list} appearance={appearance} embed={embed} />) as Promise<Response>;
  if (typeof form.website === 'string' && form.website.trim() !== '') return done(); // a bot filled the hidden box

  const ip = ipKey(c);
  await enforceRateLimit(c.env, `mail:signup:ip:${ip}`, { limit: 10, windowSec: 600 }, 'Too many signups from your network. Try again in a few minutes.');
  await enforceRateLimit(c.env, `mail:signup:list:${list.id}`, { limit: 300, windowSec: 3600 }, 'This signup page is very busy. Try again in a few minutes.');

  const rawEmail = String(form.email ?? '');
  let email: string;
  try {
    email = emailOf(rawEmail);
  } catch {
    return page(c, <SignupPage list={list} appearance={appearance} embed={embed} error="Enter a full address such as sam@example.com." email={rawEmail.slice(0, 254)} name={String(form.name ?? '').slice(0, 80)} />, 400) as Promise<Response>;
  }
  // One address can only trigger a few emails an hour, so the form cannot be used to flood someone's inbox.
  await enforceRateLimit(c.env, `mail:signup:email:${list.id}:${email}`, { limit: 3, windowSec: 3600 }, 'This address already asked for a confirmation email. Check your inbox.');
  const name = String(form.name ?? '').slice(0, 80);
  await joinList(ctxOf(c.env, list.org_id), list, { email, name, source: embed ? 'embed' : 'signup page', confirmed: false }, { base: baseUrl(c) });
  return done();
});

publicApp.get('/n/:slug', (c) => showSignup(c, false));

// Confirm ----------------------------------------------------------------------------------------

publicApp.get('/n/confirm/:token', async (c) => {
  const t = await readConfirmToken(c.env, c.req.param('token'));
  if (!t) return badLink(c);
  const list = await ctxOf(c.env, t.o).db.get<List>('mail_lists', t.l);
  if (!list) return badLink(c);
  return page(c, <ConfirmPage listName={list.name} token={c.req.param('token')} appearance={await appearanceOf(c.env, t.o)} />) as Promise<Response>;
});

publicApp.post('/n/confirm/:token', async (c) => {
  const t = await readConfirmToken(c.env, c.req.param('token'));
  if (!t) return badLink(c);
  await enforceRateLimit(c.env, `mail:confirm:${ipKey(c)}`, { limit: 30, windowSec: 600 });
  const done = await confirmSubscription(ctxOf(c.env, t.o), { s: t.s, l: t.l });
  if (!done) return badLink(c, t.o);
  return page(c, <ConfirmedPage listName={done.list.name} appearance={await appearanceOf(c.env, t.o)} />) as Promise<Response>;
});

// Unsubscribe: GET shows a button, POST does it. POST is also the one-click target mail apps call. ---

publicApp.get('/n/u/:token', async (c) => {
  const t = await readUnsubscribeToken(c.env, c.req.param('token'));
  if (!t) return badLink(c);
  const list = await ctxOf(c.env, t.o).db.get<List>('mail_lists', t.l);
  if (!list) return badLink(c);
  return page(c, <UnsubscribePage listName={list.name} token={c.req.param('token')} appearance={await appearanceOf(c.env, t.o)} />) as Promise<Response>;
});

publicApp.post('/n/u/:token', async (c) => {
  const t = await readUnsubscribeToken(c.env, c.req.param('token'));
  if (!t) return badLink(c);
  await enforceRateLimit(c.env, `mail:unsub:${ipKey(c)}`, { limit: 60, windowSec: 600 });
  const ctx = ctxOf(c.env, t.o);
  const list = await ctx.db.get<List>('mail_lists', t.l);
  if (!list) return badLink(c, t.o);
  await unsubscribe(ctx, { s: t.s, l: t.l });
  return page(c, <UnsubscribedPage listName={list.name} appearance={await appearanceOf(c.env, t.o)} />) as Promise<Response>;
});

// Tracking: only emails that opted in contain these links. ---------------------------------------

publicApp.get('/n/c/:token', async (c) => {
  const ua = c.req.header('user-agent') ?? null;
  const dest = await recordClick(c.env, c.req.param('token'), Date.now(), { count: !isBot(ua) });
  if (!dest || !/^https?:\/\//i.test(dest)) return badLink(c);
  return new Response(null, { status: 302, headers: { location: dest, ...NO_STORE } });
});

const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));

publicApp.get('/n/o/:token', async (c) => {
  if (!isBot(c.req.header('user-agent') ?? null)) await recordOpen(c.env, c.req.param('token')).catch(() => false);
  return new Response(PIXEL, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0', 'x-robots-tag': 'noindex' } });
});

// Archive ----------------------------------------------------------------------------------------

async function archiveList(c: Context<AppEnv>) {
  const found = await findList(c, c.req.param('slug') ?? '');
  return found && found.list.archive_public === 1 ? found : null;
}

publicApp.get('/n/:slug/archive', async (c) => {
  const found = await archiveList(c);
  if (!found) return notFoundPage(c);
  const issues = await archivePage(c.env, found.list, 50, 0);
  return page(c, <ArchiveIndexPage list={found.list} issues={issues} appearance={found.appearance} />, 200, true) as Promise<Response>;
});

publicApp.get('/n/:slug/archive/:post', async (c) => {
  const found = await archiveList(c);
  if (!found) return notFoundPage(c);
  const issue = await archiveIssue(c.env, found.list, c.req.param('post'));
  if (!issue) return notFoundPage(c);
  return page(c, <ArchiveIssuePage list={found.list} issue={issue} appearance={found.appearance} />, 200, true) as Promise<Response>;
});

publicApp.get('/n/:slug/rss.xml', async (c) => {
  const found = await archiveList(c);
  if (!found) throw errors.not_found();
  const issues = await archivePage(c.env, found.list, 30, 0);
  return c.body(archiveRss(found.list, issues, baseUrl(c)), 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
});
