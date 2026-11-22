/** Public roadmap and changelog pages, the RSS feed, subscriptions and admin images. */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv } from '../../../env';
import { confirmSubscriber, entryBySlug, entryLabels, linkedPosts, listEntries, readImage, subscribe, unsubscribeSubscriber } from '../changelog';
import { fbErrors } from '../errors';
import { clientIp, excerpt, markdownToText, renderMarkdown } from '../lib';
import { readSubscriberToken } from '../notify';
import { listBoards, listStatuses } from '../portal';
import { listPosts, type Sort } from '../posts';
import { esc, formatDate, plural } from '../util';
import { Alert, errorText, Note, PostLink, Shell, loadReq, type Req } from './kit';
import { unsubscribePage } from './unsub';

export const changelogRoutes = new Hono<AppEnv>();

const ROAD_SORTS: { id: Sort; label: string }[] = [
  { id: 'top', label: 'Most votes' },
  { id: 'new', label: 'Newest' },
  { id: 'trending', label: 'Trending' },
];

// ---------------------------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------------------------

changelogRoutes.get('/roadmap/:portal', async (c) => {
  const r = await loadReq(c);
  const { portal, ctx, person } = r;
  if (!portal.roadmap_on) throw fbErrors.portal_missing();
  const sort: Sort = c.req.query('sort') === 'new' || c.req.query('sort') === 'trending' ? (c.req.query('sort') as Sort) : 'top';
  const lanes = (await listStatuses(ctx)).filter((s) => s.in_roadmap === 1);
  const boards = await listBoards(ctx);
  const hide = new Map(boards.map((b) => [b.id, b.hide_votes === 1]));
  const sso = person?.source === 'sso';
  const filled = await Promise.all(lanes.map(async (s) => ({ status: s, page: await listPosts(ctx, { statusId: s.id, sort, publicOnly: !sso, limit: 30 }) })));
  const total = filled.reduce((n, l) => n + l.page.items.length, 0);
  const here = `/roadmap/${portal.slug}`;
  c.header('cache-control', 'private, no-cache');
  return c.html(
    <Shell r={r} title="Roadmap" description={`What ${portal.name} is working on, planned and has shipped.`} path={here} tab="roadmap" rss>
      <h1 class="fb-title">Roadmap</h1>
      <p class="fb-tag">What we plan to build, what is in progress, and what has shipped.</p>
      <div class="fb-sorts" role="group" aria-label="Sort roadmap">
        {ROAD_SORTS.map((s) => (
          <a href={`${here}?sort=${s.id}`} aria-current={sort === s.id ? 'true' : undefined}>
            {s.label}
          </a>
        ))}
      </div>
      {total === 0 ? (
        <div class="fb-empty">
          <h2>Nothing on the roadmap yet</h2>
          <p>Ideas show up here once the team plans them.</p>
          <a class="fb-btn" href={`/feedback/${portal.slug}`}>
            See ideas
          </a>
        </div>
      ) : (
        <div class={`fb-road c${Math.min(Math.max(filled.length, 1), 4)}`}>
          {filled.map(({ status, page }) => (
            <section class="fb-lane" aria-labelledby={`lane-${status.id}`}>
              <h2 id={`lane-${status.id}`} class="fb-h2">
                <span class={`fb-dot ${status.tone}`} aria-hidden="true"></span> {status.name} <span class="fb-hint">{page.items.length}{page.nextCursor ? '+' : ''}</span>
              </h2>
              {page.items.length === 0 ? (
                <p class="fb-hint">Nothing here right now.</p>
              ) : (
                <ul class="fb-tiles">
                  {page.items.map((p) => (
                    <li class="fb-tile">
                      <PostLink r={r} post={p} />
                      <span class="fb-hint">{hide.get(p.board_id) ? p.board_name : `${plural(p.vote_count, 'vote')}, ${p.board_name}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </Shell>,
  );
});

// ---------------------------------------------------------------------------------------------
// Changelog list, entry, feed
// ---------------------------------------------------------------------------------------------

function Labels({ labels }: { labels: string[] }) {
  return labels.length ? (
    <span class="fb-labels">
      {labels.map((l) => (
        <span class="fb-label">{l}</span>
      ))}
    </span>
  ) : null;
}

function entryHtml(body: string): string {
  return renderMarkdown(body, { allowImages: true, headingOffset: 1 });
}

changelogRoutes.get('/changelog/:portal', async (c) => {
  const r = await loadReq(c);
  const { portal, ctx } = r;
  if (!portal.changelog_on) throw fbErrors.portal_missing();
  const page = await listEntries(ctx, { state: 'published', cursor: c.req.query('cursor'), limit: 10 });
  const here = `/changelog/${portal.slug}`;
  c.header('cache-control', 'private, no-cache');
  return c.html(
    <Shell r={r} title="Changelog" description={`New and improved, from ${portal.name}.`} path={here} tab="changelog" rss noindex={Boolean(c.req.query('cursor'))}>
      <Note code={c.req.query('note')} />
      <div class="fb-split">
        <div>
          <h1 class="fb-title">Changelog</h1>
          <p class="fb-tag">New and improved, in the order it shipped.</p>
        </div>
        <div class="fb-actions">
          <a class="fb-btn ghost" href={`${here}/subscribe`}>
            Get updates by email
          </a>
          <a class="fb-btn ghost" href={`${here}/feed.rss`}>
            RSS
          </a>
        </div>
      </div>
      {page.items.length === 0 ? (
        <div class="fb-empty">
          <h2>No updates yet</h2>
          <p>Product news will be listed here as it ships.</p>
        </div>
      ) : (
        page.items.map((e) => (
          <article class="fb-entry">
            <header>
              <time datetime={new Date(e.published_at ?? e.created_at).toISOString()}>{formatDate(e.published_at ?? e.created_at)}</time>
              <h2>
                <a href={`${here}/${e.slug}`}>{e.title}</a>
              </h2>
              <Labels labels={entryLabels(e)} />
            </header>
            <div class="fb-body">{raw(entryHtml(e.body))}</div>
          </article>
        ))
      )}
      {page.nextCursor ? (
        <div class="fb-more">
          <a class="fb-btn ghost" href={`${here}?cursor=${encodeURIComponent(page.nextCursor)}`}>
            Older updates
          </a>
        </div>
      ) : null}
    </Shell>,
  );
});

// Fixed paths first, so an entry titled "feed" cannot shadow them.
changelogRoutes.get('/changelog/:portal/feed.rss', async (c) => {
  const r = await loadReq(c);
  const { portal, ctx, origin } = r;
  if (!portal.changelog_on) throw fbErrors.portal_missing();
  const page = await listEntries(ctx, { state: 'published', limit: 20 });
  const items = page.items
    .map((e) => {
      const url = `${origin}/changelog/${portal.slug}/${e.slug}`;
      const when = new Date(e.published_at ?? e.created_at).toUTCString();
      const cats = entryLabels(e)
        .map((l) => `<category>${esc(l)}</category>`)
        .join('');
      return `<item><title>${esc(e.title)}</title><link>${esc(url)}</link><guid isPermaLink="true">${esc(url)}</guid><pubDate>${when}</pubDate>${cats}<description>${esc(entryHtml(e.body))}</description></item>`;
    })
    .join('');
  const last = page.items[0] ? new Date(page.items[0].published_at ?? page.items[0].created_at).toUTCString() : new Date(portal.created_at).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${esc(portal.name)} changelog</title><link>${esc(`${origin}/changelog/${portal.slug}`)}</link><description>${esc(`Product updates from ${portal.name}`)}</description><language>en</language><lastBuildDate>${last}</lastBuildDate><atom:link href="${esc(`${origin}/changelog/${portal.slug}/feed.rss`)}" rel="self" type="application/rss+xml"/>${items}</channel></rss>`;
  return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

changelogRoutes.get('/changelog/:portal/img/:file', async (c) => {
  const r = await loadReq(c);
  const img = await readImage(c.env, r.portal.org_id, c.req.param('file'));
  if (!img) return c.notFound();
  return new Response(img.body, { headers: { 'content-type': img.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
});

function SubscribePage({ r, error, email, frequency }: { r: Req; error?: string; email?: string; frequency?: string }) {
  const { portal } = r;
  const here = `/changelog/${portal.slug}/subscribe`;
  return (
    <Shell r={r} title="Get updates by email" path={here} tab="changelog" noindex narrow>
      <h1 class="fb-title">Get updates by email</h1>
      <Alert error={error} />
      {!r.emailUp ? (
        <div class="fb-card">
          <p>This site cannot send email yet, so signing up by email is not available. You can follow the RSS feed instead.</p>
          <a class="fb-btn" href={`/changelog/${portal.slug}/feed.rss`}>
            Open the RSS feed
          </a>
        </div>
      ) : (
        <form class="fb-form fb-card" method="post" action={here} data-busy-form>
          <p class="fb-tag">We send a link to confirm your address first. You can leave with one click from any email.</p>
          <div class="fb-field">
            <label for="email">Email</label>
            <input class="fb-in" id="email" name="email" type="email" required autocomplete="email" inputmode="email" maxlength={254} value={email ?? ''} aria-invalid={error ? 'true' : undefined} />
          </div>
          <div class="fb-field">
            <label for="frequency">How often</label>
            <select id="frequency" name="frequency">
              <option value="each" selected={!frequency || frequency === 'each'}>
                Each update, when it ships
              </option>
              <option value="weekly" selected={frequency === 'weekly'}>
                A weekly digest
              </option>
              <option value="monthly" selected={frequency === 'monthly'}>
                A monthly digest
              </option>
            </select>
          </div>
          <button class="fb-btn" type="submit">
            Subscribe
          </button>
        </form>
      )}
    </Shell>
  );
}

changelogRoutes.get('/changelog/:portal/subscribe', async (c) => {
  const r = await loadReq(c);
  if (!r.portal.changelog_on) throw fbErrors.portal_missing();
  c.header('cache-control', 'private, no-cache');
  return c.html(<SubscribePage r={r} />);
});

changelogRoutes.post('/changelog/:portal/subscribe', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const email = typeof body.email === 'string' ? body.email : '';
  const frequency = typeof body.frequency === 'string' ? body.frequency : 'each';
  if (typeof body.website === 'string' && body.website) return c.redirect(`/changelog/${r.portal.slug}?note=subscribed`);
  try {
    const res = await subscribe(r.ctx, r.portal, email, frequency, clientIp(c.req.raw) ?? 'unknown', r.origin);
    return c.redirect(`/changelog/${r.portal.slug}?note=${res.sent ? 'subscribed' : 'already-subscribed'}`);
  } catch (e) {
    const { message, status } = errorText(e);
    return c.html(<SubscribePage r={r} error={message} email={email} frequency={frequency} />, status === 429 ? 429 : 422);
  }
});

changelogRoutes.get('/changelog/:portal/confirm', async (c) => {
  const r = await loadReq(c);
  const t = c.req.query('t') ?? '';
  const meta = await readSubscriberToken(c.env, t);
  const ok = meta && meta.o === r.portal.org_id ? await confirmSubscriber(c.env, t) : null;
  c.header('cache-control', 'no-store');
  return c.html(
    <Shell r={r} title="Confirm subscription" path={`/changelog/${r.portal.slug}/confirm`} tab="changelog" noindex narrow>
      <h1 class="fb-title">{ok ? 'You are subscribed' : 'That link did not work'}</h1>
      <div class="fb-card" role="status">
        {ok ? <p>Thanks. We will email {ok.email} when there is news. Every email has a link to unsubscribe.</p> : <p>The link may be too old or already used. You can sign up again from the changelog page.</p>}
        <a class="fb-btn" href={ok ? `/changelog/${r.portal.slug}` : `/changelog/${r.portal.slug}/subscribe`}>
          {ok ? 'See the changelog' : 'Sign up again'}
        </a>
      </div>
    </Shell>,
    ok ? 200 : 422,
  );
});

// Mail clients post here for one-click unsubscribe; people get a confirm page first.
changelogRoutes.get('/changelog/:portal/unsubscribe', async (c) => {
  const r = await loadReq(c);
  const t = c.req.query('t') ?? '';
  const meta = await readSubscriberToken(c.env, t);
  const target = meta && meta.o === r.portal.org_id ? ({ kind: 'subscriber', org: meta.o, id: meta.s, token: t } as const) : null;
  c.header('cache-control', 'no-store');
  return c.html(unsubscribePage(r, target, false), target ? 200 : 422);
});

changelogRoutes.post('/changelog/:portal/unsubscribe', async (c) => {
  const r = await loadReq(c);
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
  const t = c.req.query('t') || (typeof body.s === 'string' ? body.s : '') || (typeof body.t === 'string' ? body.t : '');
  const meta = await readSubscriberToken(c.env, t);
  const ok = meta && meta.o === r.portal.org_id ? await unsubscribeSubscriber(c.env, t) : false;
  c.header('cache-control', 'no-store');
  return c.html(unsubscribePage(r, ok && meta ? { kind: 'subscriber', org: meta.o, id: meta.s, token: t } : null, ok), ok ? 200 : 422);
});

changelogRoutes.get('/changelog/:portal/:slug', async (c) => {
  const r = await loadReq(c);
  const { portal, ctx } = r;
  if (!portal.changelog_on) throw fbErrors.portal_missing();
  const e = await entryBySlug(ctx, c.req.param('slug'));
  if (!e || e.state !== 'published') throw fbErrors.entry_missing();
  const linked = await linkedPosts(ctx, e.id);
  const here = `/changelog/${portal.slug}/${e.slug}`;
  c.header('cache-control', 'private, no-cache');
  return c.html(
    <Shell r={r} title={e.title} description={excerpt(markdownToText(e.body), 180)} path={here} tab="changelog" ogType="article" rss narrow>
      <p class="fb-crumb">
        <a href={`/changelog/${portal.slug}`}>Changelog</a>
      </p>
      <article class="fb-entry single">
        <header>
          <time datetime={new Date(e.published_at ?? e.created_at).toISOString()}>{formatDate(e.published_at ?? e.created_at)}</time>
          <h1 class="fb-title">{e.title}</h1>
          <Labels labels={entryLabels(e)} />
        </header>
        <div class="fb-body">{raw(entryHtml(e.body))}</div>
        {linked.length ? (
          <div class="fb-card">
            <h2 class="fb-h2">Ideas this shipped</h2>
            <ul class="fb-boards">
              {linked.map((p) => (
                <li>
                  <a href={`/feedback/${portal.slug}/p/${p.slug}`}>{p.title}</a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </article>
    </Shell>,
  );
});
