/**
 * Shared pieces of the public pages: who is asking, the HTML shell with its SEO tags, and the post row.
 * Pages here use /assets/public.css for the look (presets) and /m/feedback/feedback.css for layout.
 */
import { raw } from 'hono/html';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { orgDb } from '../../../core/db';
import { emailStatus } from '../../../core/email';
import { AppError } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { ICON_SPRITE } from '../../../ui/icons';
import { fbErrors } from '../errors';
import { baseUrl } from '../lib';
import { cookieName, embedToken, readCookie, resolveIdentity } from '../people';
import { portalBySlug, type Ctx } from '../portal';
import type { PostView } from '../posts';
import type { Board, Person, Portal } from '../types';
import { displayName, initials, plural, timeAgo } from '../util';

/** Everything a public handler needs to know about the request. */
export interface Req {
  c: Context<AppEnv>;
  portal: Portal;
  ctx: Ctx;
  person: Person | null;
  origin: string;
  embed: boolean;
  /** Carried through links and forms inside the widget, where third-party cookies may be blocked. */
  vt: string | null;
  emailUp: boolean;
  /** May someone without a verified email post and vote? Always true when codes cannot be sent. */
  canGuest: boolean;
}

export async function loadReq(c: Context<AppEnv>, body?: Record<string, unknown>, opts: { embed?: boolean } = {}): Promise<Req> {
  const slug = c.req.param('portal') ?? '';
  const portal = await portalBySlug(c.env, slug);
  if (!portal) throw fbErrors.portal_missing();
  const origin = baseUrl(c);
  const ctx: Ctx = { env: c.env, orgId: portal.org_id, db: orgDb(c.env.DB, portal.org_id), origin };
  const pick = (k: string): string => {
    const q = c.req.query(k);
    if (q) return q;
    const b = body?.[k];
    return typeof b === 'string' ? b : '';
  };
  const embed = opts.embed === true || pick('embed') === '1';
  const person = await resolveIdentity(ctx, { sso: pick('sso') || null, vt: pick('vt') || null, cookie: readCookie(c.req.header('cookie'), cookieName(portal)) });
  const emailUp = (await emailStatus(c.env)).status === 'ready';
  const vt = embed && person ? await embedToken(c.env, portal, person.id) : null;
  return { c, portal, ctx, person, origin, embed, vt, emailUp, canGuest: !emailUp || portal.allow_anonymous === 1 };
}

/** A path on this portal's pages, with the widget's carry-over parameters added. */
export function href(r: Pick<Req, 'embed' | 'vt'>, path: string, params: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  if (r.embed) p.set('embed', '1');
  if (r.embed && r.vt) p.set('vt', r.vt);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

export const base = (r: Pick<Req, 'portal'>) => `/feedback/${r.portal.slug}`;

/** Hidden fields every public form carries so the widget keeps working without cookies. */
export function Carry({ r }: { r: Pick<Req, 'embed' | 'vt'> }) {
  return (
    <>
      {r.embed ? <input type="hidden" name="embed" value="1" /> : null}
      {r.embed && r.vt ? <input type="hidden" name="vt" value={r.vt} /> : null}
    </>
  );
}

/** Only ever send people back to a page of this portal. */
export function safeNext(next: unknown, fallback: string): string {
  return typeof next === 'string' && /^\/(feedback|roadmap|changelog)\/[a-z0-9-]+(\/[^\s?#]*)?(\?[^\s#]*)?$/.test(next) ? next : fallback;
}

/** Messages shown after a redirect. The address carries only a short code, never text. */
export const NOTES: Record<string, { text: string; kind?: 'bad' | 'warn' }> = {
  posted: { text: 'Thanks. Your idea is posted.' },
  'held-guest': { text: 'Thanks. An admin will look at it before it appears, because you have not confirmed an email address.', kind: 'warn' },
  'held-links': { text: 'Thanks. Posts with several links are checked by an admin before they appear.', kind: 'warn' },
  'held-moderation': { text: 'Thanks. An admin will look at it before it appears.', kind: 'warn' },
  commented: { text: 'Your comment is posted.' },
  'comment-held': { text: 'Thanks. An admin will look at your comment before it appears.', kind: 'warn' },
  'signed-in': { text: 'You are signed in.' },
  'signed-out': { text: 'You are signed out on this device.' },
  subscribed: { text: 'Check your inbox. We sent a link to confirm your address.' },
  'already-subscribed': { text: 'That address already gets updates.' },
  'e-vote_limit': { text: 'You have used all your votes. Remove a vote from another idea first.', kind: 'bad' },
  'e-voting_off': { text: 'Voting is turned off here.', kind: 'bad' },
  'e-blocked': { text: 'You can not take part in this portal.', kind: 'bad' },
  'e-spam_suspected': { text: 'You are doing that a lot. Wait a little and try again.', kind: 'bad' },
  'e-generic': { text: 'That did not work. Try again in a moment.', kind: 'bad' },
};

/** The note code for an error, so a failed vote without JavaScript can redirect with a short message. */
export function errNote(e: unknown): string {
  const code = e instanceof AppError ? `e-${e.code.split('.').pop()}` : 'e-generic';
  return code in NOTES ? code : 'e-generic';
}

export function Note({ code }: { code?: string }) {
  const n = code ? NOTES[code] : undefined;
  if (!n) return null;
  return (
    <p class={`fb-note${n.kind ? ` ${n.kind}` : ''}`} role="status">
      {n.text}
    </p>
  );
}

export function Alert({ error }: { error?: string | null }) {
  return error ? (
    <p class="fb-note bad" role="alert">
      {error}
    </p>
  ) : null;
}

export function errorText(e: unknown): { message: string; fields: Record<string, string>; status: 400 | 401 | 403 | 404 | 409 | 422 | 429 } {
  const known = e instanceof AppError ? e : null;
  if (!known) throw e;
  const status = ([400, 401, 403, 404, 409, 422, 429].includes(known.status) ? known.status : 422) as 400 | 401 | 403 | 404 | 409 | 422 | 429;
  return { message: known.message, fields: known.fields ?? {}, status };
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

export interface ShellProps {
  r: Req;
  title: string;
  description?: string;
  /** Path of this page (no query), for the canonical link and Open Graph address. */
  path: string;
  /** Which tab is current. */
  tab?: 'feedback' | 'roadmap' | 'changelog' | '';
  /** Keep search engines out (private boards, sign-in, forms). */
  noindex?: boolean;
  /** Narrow reading column. */
  narrow?: boolean;
  /** Adds an RSS link to the head. */
  rss?: boolean;
  ogType?: 'website' | 'article';
  children?: Child;
}

export function Shell({ r, title, description, path, tab = '', noindex, narrow, rss, ogType = 'website', children }: ShellProps) {
  const { portal } = r;
  const full = title === portal.name ? title : `${title} · ${portal.name}`;
  const canonical = `${r.origin}${path}`;
  const desc = (description || portal.tagline || `Ideas, roadmap and updates from ${portal.name}.`).slice(0, 200);
  const slug = portal.slug;
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en" data-preset={portal.theme} data-theme-lock="">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{full}</title>
          <meta name="description" content={desc} />
          {noindex || r.embed ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={canonical} />}
          <meta name="color-scheme" content="light dark" />
          <meta property="og:site_name" content={portal.name} />
          <meta property="og:title" content={full} />
          <meta property="og:description" content={desc} />
          <meta property="og:type" content={ogType} />
          {noindex || r.embed ? null : <meta property="og:url" content={canonical} />}
          <meta name="twitter:card" content="summary" />
          {rss && portal.changelog_on ? <link rel="alternate" type="application/rss+xml" title={`${portal.name} changelog`} href={`${r.origin}/changelog/${slug}/feed.rss`} /> : null}
          <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
          <script src="/assets/theme.js"></script>
          <link rel="stylesheet" href="/assets/public.css" />
          <link rel="stylesheet" href="/m/feedback/feedback.css" />
          {portal.accent ? <link rel="stylesheet" href={`/feedback/${slug}/theme.css`} /> : null}
        </head>
        <body class="fb" data-embed={r.embed ? '' : undefined} data-portal={slug}>
          {raw(ICON_SPRITE)}
          <a class="fb-skip" href="#main">
            Skip to content
          </a>
          {r.embed ? null : (
            <header class="fb-head">
              <div class="fb-head-in">
                <a class="fb-name" href={`/feedback/${slug}`}>
                  {portal.name}
                </a>
                <nav class="fb-nav" aria-label="Sections">
                  <a href={`/feedback/${slug}`} aria-current={tab === 'feedback' ? 'page' : undefined}>
                    Feedback
                  </a>
                  {portal.roadmap_on ? (
                    <a href={`/roadmap/${slug}`} aria-current={tab === 'roadmap' ? 'page' : undefined}>
                      Roadmap
                    </a>
                  ) : null}
                  {portal.changelog_on ? (
                    <a href={`/changelog/${slug}`} aria-current={tab === 'changelog' ? 'page' : undefined}>
                      Changelog
                    </a>
                  ) : null}
                </nav>
              </div>
            </header>
          )}
          <main class={`fb-main${narrow ? ' narrow' : ''}`} id="main">
            {children}
          </main>
          {r.embed ? null : (
            <footer class="fb-foot">
              {r.person ? <SignedIn r={r} path={path} /> : null}
              {portal.show_powered ? (
                <span>
                  Powered by{' '}
                  <a href="https://github.com/sairahul1526/toolshed" rel="noopener">
                    Toolshed
                  </a>
                </span>
              ) : null}
            </footer>
          )}
          <script src="/m/feedback/portal.js" defer></script>
        </body>
      </html>
    </>
  );
}

function SignedIn({ r, path }: { r: Req; path: string }) {
  const p = r.person!;
  if (p.source === 'guest') return <span>Posting as a guest. Your ideas wait for approval until you confirm an email.</span>;
  return (
    <form class="fb-who" method="post" action={`/feedback/${r.portal.slug}/sign-out`}>
      <input type="hidden" name="next" value={path} />
      <span>Signed in{p.email ? ` as ${p.email}` : ''}.</span>
      <button class="fb-link" type="submit">
        Sign out
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Post rows
// ---------------------------------------------------------------------------------------------

export function Arrow() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3.5 10 8 5.5 12.5 10" />
    </svg>
  );
}

export function VoteButton({ r, post, voted, back }: { r: Req; post: PostView; voted: boolean; back: string }) {
  const hide = post.board_hide_votes === 1;
  const off = post.review !== 'published';
  return (
    <form class="fb-voteform" method="post" action={`/feedback/${r.portal.slug}/p/${post.slug}/vote`} data-vote-form>
      <Carry r={r} />
      <input type="hidden" name="next" value={back} />
      <button class="fb-vote" type="submit" aria-pressed={voted ? 'true' : 'false'} aria-label={`${voted ? 'Remove your vote from' : 'Vote for'} ${post.title}`} disabled={off} data-vote>
        <Arrow />
        {hide ? <span class="fb-sr" data-count>{post.vote_count}</span> : <b data-count>{post.vote_count}</b>}
      </button>
    </form>
  );
}

export function StatusPill({ name, tone }: { name: string | null; tone: string | null }) {
  if (!name) return null;
  return <span class={`fb-pill ${tone && ['good', 'warn', 'bad', 'solid', 'neutral'].includes(tone) ? tone : 'neutral'}`}>{name}</span>;
}

export function postLink(r: Req, post: { slug: string }): string {
  return href(r, `/feedback/${r.portal.slug}/p/${post.slug}`);
}

export function PostLink({ r, post }: { r: Req; post: { slug: string; title: string } }) {
  return <a href={postLink(r, post)}>{post.title}</a>;
}

export function PostRow({ r, post, voted, tags, back }: { r: Req; post: PostView; voted: boolean; tags?: { name: string }[]; back: string }) {
  const who = post.author_name !== null ? displayName(post.author_name, { hideLast: r.portal.hide_last_names === 1, fallback: 'A visitor' }) : 'A visitor';
  return (
    <li>
      <article class="fb-row">
        <VoteButton r={r} post={post} voted={voted} back={back} />
        <div>
          <h3>
            <a href={postLink(r, post)}>{post.title}</a>
          </h3>
          {post.body ? <p>{post.body.replace(/[#*_`>\[\]]/g, '').slice(0, 220)}</p> : null}
          <div class="fb-meta">
            <StatusPill name={post.status_name} tone={post.status_tone} />
            <span>{plural(post.comment_count, 'comment')}</span>
            {post.category_name ? <span>{post.category_name}</span> : null}
            {tags && tags.length ? <span>{tags.map((t) => t.name).join(', ')}</span> : null}
            <span>
              {who}, {timeAgo(post.created_at)}
            </span>
          </div>
        </div>
      </article>
    </li>
  );
}

export function Avatar({ name }: { name: string }) {
  return (
    <span class="fb-av" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Private boards are only open to people the customer's own system has identified. */
export function boardAllowed(board: Pick<Board, 'visibility'>, person: Person | null): boolean {
  return board.visibility === 'public' || person?.source === 'sso';
}
