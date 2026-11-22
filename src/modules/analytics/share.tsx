/**
 * Public dashboards. Anyone with the link can look at one site's numbers and change nothing.
 *
 *   GET  /a/share/<token>         the report, or the password form when the link has one
 *   POST /a/share/<token>         the password form
 *   GET  /a/share/<token>/embed   the same report for an <iframe> on another site
 *
 * A stranger can reload these as often as they like, so a finished page is kept in memory for a
 * minute and only a miss is counted against the visitor's limit. The link itself is looked up
 * every time: deleting it, or its expiry passing, stops the page at once.
 */
import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { getCookie, setCookie } from 'hono/cookie';
import { orgDb } from '../../core/db';
import { clientIp } from '../../core/net';
import { rateLimit } from '../../core/ratelimit';
import { moduleState } from '../../core/registry';
import { getSetting } from '../../core/settings';
import { readSignedToken, signedToken } from '../../core/signing';
import type { AppEnv, Env } from '../../env';
import { PublicButton, PublicCard, PublicField, PublicInput, PublicPage, formatNumber, parseAppearance, type Appearance } from '../../ui';
import { ensureFresh } from './rollup';
import { analyticsErrors, checkSharePassword, domainNote, getSite, listGoals, shareByToken, type Share } from './sites';
import { live } from './stats';
import { MINUTE } from './time';
import { loadReport, queryOf, RangeForm, readView, ReportView } from './view';

type Ctx = Context<AppEnv>;
type Theme = 'light' | 'dark' | undefined;

const STYLES = ['/m/analytics/report.css', '/m/analytics/share.css'];
const PURPOSE = 'analytics.share';
const COOKIE = 'an_share';
const UNLOCK_DAYS = 7;
/** Rows per list on a public page: enough to be useful, small enough to keep the page light. */
const ROWS = 6;
const PAGE_TTL_MS = MINUTE;
const MAX_PAGES = 50;
const PUBLIC_FRESH_MS = 5 * MINUTE;

const PAGE_CSP = (frames: string) => `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`;

const pages = new WeakMap<D1Database, Map<string, { at: number; html: string }>>();

function pageCache(env: Env): Map<string, { at: number; html: string }> {
  let m = pages.get(env.DB);
  if (!m) pages.set(env.DB, (m = new Map()));
  return m;
}

function send(c: Ctx, body: unknown, status: 200 | 401 | 403 | 404 | 429, embed: boolean): Response {
  c.header('content-security-policy', PAGE_CSP(embed ? '*' : "'self'"));
  c.header('referrer-policy', 'no-referrer');
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  return c.html(body as string, status);
}

async function appearanceOf(env: Env, orgId: string): Promise<Appearance> {
  return parseAppearance(await getSetting<Record<string, unknown>>(env, orgId, 'appearance', {}));
}

const themeOf = (c: Ctx): Theme => {
  const t = c.req.query('theme');
  return t === 'light' || t === 'dark' ? t : undefined;
};

function Notice({ title, body, appearance, theme, children }: { title: string; body: string; appearance?: Appearance; theme?: Theme; children?: Child }) {
  return (
    <PublicPage title={title} appearance={appearance} forceTheme={theme}>
      <PublicCard>
        <h1>{title}</h1>
        <p>{body}</p>
        {children}
      </PublicCard>
    </PublicPage>
  );
}

const gone = (c: Ctx, embed: boolean): Response =>
  send(c, <Notice title="This dashboard is not available" body="The link was deleted or has expired. Ask whoever shared it for a new one." theme={themeOf(c)} />, 404, embed);

/** The link and its workspace, or null when the link is unknown, expired, or its workspace has Analytics switched off. */
async function open(c: Ctx): Promise<Share | null> {
  const share = await shareByToken(c.env, c.req.param('token') ?? '');
  if (!share) return null;
  return (await moduleState(c.env, share.org_id, 'analytics')).enabled ? share : null;
}

async function unlocked(c: Ctx, share: Share): Promise<boolean> {
  if (!share.password_hash) return true;
  const cookie = getCookie(c, COOKIE);
  if (!cookie) return false;
  const seen = await readSignedToken<{ s: string }>(c.env, PURPOSE, cookie);
  return seen?.s === share.id;
}

function PasswordPage({ share, error, appearance }: { share: Share; error?: string; appearance: Appearance }) {
  return (
    <PublicPage title="Password needed" appearance={appearance} styles={['/m/analytics/share.css']}>
      <PublicCard>
        <h1>This dashboard needs a password</h1>
        <p>Enter the password you were given to see the numbers.</p>
        <form method="post" action={`/a/share/${share.token}`} class="an-pw">
          <PublicField id="password" label="Password" error={error}>
            <PublicInput id="password" type="password" required autocomplete="off" invalid={!!error} describedBy={error ? 'password-error' : undefined} maxlength={256} />
          </PublicField>
          <PublicButton type="submit" block>
            Continue
          </PublicButton>
        </form>
      </PublicCard>
    </PublicPage>
  );
}

async function show(c: Ctx, embed: boolean): Promise<Response> {
  const share = await open(c);
  if (!share) return gone(c, embed);
  const theme = themeOf(c);
  const here = `/a/share/${share.token}`;

  if (!(await unlocked(c, share))) {
    const appearance = await appearanceOf(c.env, share.org_id);
    if (!embed) return send(c, <PasswordPage share={share} appearance={appearance} />, 401, false);
    // A browser does not send this site's cookie from inside another site's page, so the form could never succeed there.
    return send(c, (
      <Notice title="This dashboard needs a password" body="It cannot be opened inside another page." appearance={appearance} theme={theme}>
        <p><a href={here} target="_blank" rel="noopener">Open it in a new tab</a></p>
      </Notice>
    ), 401, true);
  }

  const now = Date.now();
  const db = orgDb(c.env.DB, share.org_id);
  let site;
  try {
    site = await getSite(db, share.site_id);
  } catch {
    return gone(c, embed);
  }
  const view = readView((key) => c.req.query(key), site, now, true);
  const base = embed ? `${here}/embed` : here;
  const key = `${share.id}|${embed ? 'e' : 'p'}|${theme ?? ''}|${queryOf(view)}`;
  const cache = pageCache(c.env);
  const hit = cache.get(key);
  if (hit && now - hit.at < PAGE_TTL_MS && now >= hit.at) return send(c, hit.html, 200, embed);

  const limit = await rateLimit(c.env, `analytics.share:${clientIp(c.req.raw) ?? 'unknown'}`, { limit: 30, windowSec: 60 }, now);
  if (!limit.ok) {
    c.header('retry-after', String(limit.retryAfter));
    return send(c, <Notice title="Too many page loads" body="Wait a minute, then load the page again." theme={theme} />, 429, embed);
  }

  site = await ensureFresh(c.env, site, now, PUBLIC_FRESH_MS);
  const [goals, appearance, state] = await Promise.all([listGoals(db, site.id), appearanceOf(c.env, share.org_id), live(db, site, now)]);
  const data = await loadReport(db, site, view, goals, ROWS);
  const html = String(
    await (
      <PublicPage title={`${site.name} visitors`} description={`Visitors and page views for ${site.domain}.`} appearance={appearance} forceTheme={theme} wide styles={STYLES}>
        <div class={embed ? 'an-pub an-framed' : 'an-pub'}>
          <header class="an-head">
            <h1>{site.name}</h1>
            <p>
              {domainNote(site)}
              <span class="an-now">{formatNumber(state.visitors)} on the site now</span>
            </p>
          </header>
          <RangeForm action={base} view={view} />
          <ReportView base={base} view={view} data={data} goals={goals} limit={ROWS} retentionDays={site.retention_days} />
        </div>
      </PublicPage>
    ),
  );
  if (cache.size >= MAX_PAGES) {
    for (const [k, v] of cache) if (now - v.at >= PAGE_TTL_MS || cache.size >= MAX_PAGES) cache.delete(k);
  }
  cache.set(key, { at: now, html });
  return send(c, html, 200, embed);
}

const share = new Hono<AppEnv>();

share.get('/a/share/:token', (c) => show(c, false));
share.get('/a/share/:token/embed', (c) => show(c, true));

share.post('/a/share/:token', async (c) => {
  const link = await open(c);
  if (!link) return gone(c, false);
  const here = `/a/share/${link.token}`;
  if (!link.password_hash) return c.redirect(here, 303);
  const appearance = await appearanceOf(c.env, link.org_id);
  const rule = { windowSec: 600 };
  // One limit per visitor so a guesser is slowed down, one per link so many guessers together are too.
  const mine = await rateLimit(c.env, `analytics.pw:${clientIp(c.req.raw) ?? 'unknown'}:${link.id}`, { ...rule, limit: 8 });
  const all = mine.ok ? await rateLimit(c.env, `analytics.pw:${link.id}`, { ...rule, limit: 60 }) : mine;
  if (!all.ok) {
    c.header('retry-after', String(all.retryAfter));
    return send(c, <PasswordPage share={link} error="Too many tries. Wait a few minutes and try again." appearance={appearance} />, 429, false);
  }
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const given = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  if (!(await checkSharePassword(link, given))) {
    return send(c, <PasswordPage share={link} error={analyticsErrors.wrong_password().message} appearance={appearance} />, 403, false);
  }
  setCookie(c, COOKIE, await signedToken(c.env, PURPOSE, { s: link.id }, UNLOCK_DAYS * 86_400), {
    path: here,
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: UNLOCK_DAYS * 86_400,
  });
  return c.redirect(here, 303);
});

export default share;
