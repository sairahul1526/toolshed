/** Public feedback pages: list, post, new post, sign-in, voting, comments, the widget's iframe page and small JSON endpoints. */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import { rateLimit } from '../../../core/ratelimit';
import type { AppEnv } from '../../../env';
import { entryLabels, listEntries } from '../changelog';
import { fbErrors } from '../errors';
import { clientIp, excerpt, markdownToText, renderVisitorMarkdown } from '../lib';
import { adoptGuest, createGuest, embedToken, mailOff, requestCode, setName, setVisitorCookie, verifyCode, visitorToken } from '../people';
import { listBoards, listCategories, updatePortal } from '../portal';
import { addVisitorComment, getPostView, listComments, listPosts, postBySlug, postTags, similarPosts, submitPost, toggleVote, votedSet, type Sort } from '../posts';
import { checkForm, formToken, heldMessage, throttle } from '../spam';
import type { Person } from '../types';
import { displayName, plural, timeAgo } from '../util';
import { Alert, Avatar, boardAllowed, base, Carry, errNote, errorText, href, loadReq, Note, PostRow, safeNext, Shell, StatusPill, VoteButton, type Req } from './kit';
import { readUnsubTarget, unsubscribePage } from './unsub';

export const feedbackRoutes = new Hono<AppEnv>();

const SORTS: { id: Sort; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'trending', label: 'Trending' },
  { id: 'new', label: 'New' },
];

function noCache(c: { header: (k: string, v: string) => void }) {
  c.header('cache-control', 'private, no-cache');
}

/** Set the visitor cookie for a person and return a Req that carries their embed token. */
async function signedInAs(r: Req, person: Person): Promise<Req> {
  const h = new Headers();
  setVisitorCookie(h, r.portal, await visitorToken(r.c.env, r.portal, person.id), new URL(r.c.req.url).protocol === 'https:');
  r.c.header('set-cookie', h.get('set-cookie')!, { append: true });
  return { ...r, person, vt: r.embed ? await embedToken(r.c.env, r.portal, person.id) : null };
}

// ---------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------

async function home(c: import('hono').Context<AppEnv>, embed: boolean) {
  const r = await loadReq(c, undefined, { embed });
  const { portal, ctx, person } = r;
  const q = c.req.query();
  const boards = (await listBoards(ctx)).filter((b) => boardAllowed(b, person));
  const board = q.board ? boards.find((b) => b.slug === q.board) : undefined;
  const sort: Sort = q.sort === 'top' || q.sort === 'new' || q.sort === 'trending' ? q.sort : (portal.default_sort as Sort);
  const term = (q.q ?? '').trim().slice(0, 80);
  const page = await listPosts(ctx, { publicOnly: person?.source !== 'sso', boardId: board?.id, sort, q: term, cursor: q.cursor, limit: 20 });
  const ids = page.items.map((p) => p.id);
  const [voted, tags] = await Promise.all([votedSet(ctx, person?.id, ids), postTags(ctx, ids)]);
  const here = `/feedback/${portal.slug}`;
  const keep = { board: board?.slug, q: term || undefined };
  const back = href(r, here, { ...keep, sort: q.sort ? sort : undefined });
  const postingBoards = boards.filter((b) => b.posting_on);
  noCache(c);
  return c.html(
    <Shell r={r} title={portal.name} description={portal.tagline} path={here} tab="feedback" noindex={Boolean(q.q || q.cursor || q.board) || boards.some((b) => b.visibility === 'private' && person?.source === 'sso')} rss>
      <Note code={q.note} />
      <div>
        <h1 class="fb-title">{board ? board.name : 'Ideas'}</h1>
        <p class="fb-tag">{board?.description || portal.tagline || 'Tell us what to build next, and vote on what matters to you.'}</p>
      </div>
      <div class="fb-cols">
        <div class="fb-side-main" style={undefined}>
          <form class="fb-search" method="get" action={here} role="search">
            {board ? <input type="hidden" name="board" value={board.slug} /> : null}
            {q.sort ? <input type="hidden" name="sort" value={sort} /> : null}
            {r.embed ? <input type="hidden" name="embed" value="1" /> : null}
            {r.embed && r.vt ? <input type="hidden" name="vt" value={r.vt} /> : null}
            <label class="fb-sr" for="q">
              Search ideas
            </label>
            <input class="fb-in" id="q" name="q" type="search" value={term} placeholder="Search ideas" maxlength={80} />
            <button class="fb-btn ghost" type="submit">
              Search
            </button>
          </form>
          <div class="fb-sorts" role="group" aria-label="Sort ideas">
            {SORTS.map((s) => (
              <a href={href(r, here, { ...keep, sort: s.id })} aria-current={sort === s.id ? 'true' : undefined}>
                {s.label}
              </a>
            ))}
          </div>
          {page.items.length === 0 ? (
            <div class="fb-empty">
              <h2>{term ? 'No ideas match that search' : 'No ideas yet'}</h2>
              <p>{term ? 'Try fewer words, or share it as a new idea.' : 'Be the first to share one. It takes a minute.'}</p>
              {postingBoards.length ? (
                <a class="fb-btn" href={href(r, `${here}/new`, { board: board?.slug, title: term || undefined })}>
                  Share an idea
                </a>
              ) : null}
            </div>
          ) : (
            <ul class="fb-list">
              {page.items.map((p) => (
                <PostRow r={r} post={p} voted={voted.has(p.id)} tags={(tags.get(p.id) ?? []).filter((t) => t.is_public)} back={back} />
              ))}
            </ul>
          )}
          {page.nextCursor ? (
            <div class="fb-more">
              <a class="fb-btn ghost" href={href(r, here, { ...keep, sort: q.sort ? sort : undefined, cursor: page.nextCursor })}>
                Show more
              </a>
            </div>
          ) : null}
        </div>
        <aside class="fb-side" aria-label="Boards">
          {postingBoards.length ? (
            <a class="fb-btn block" href={href(r, `${here}/new`, { board: board?.slug })}>
              Share an idea
            </a>
          ) : null}
          {boards.length > 1 ? (
            <div class="fb-card">
              <h2 class="fb-h2">Boards</h2>
              <ul class="fb-boards">
                <li>
                  <a href={href(r, here, { sort: q.sort ? sort : undefined })} aria-current={!board ? 'true' : undefined}>
                    All ideas
                  </a>
                </li>
                {boards.map((b) => (
                  <li>
                    <a href={href(r, here, { board: b.slug, sort: q.sort ? sort : undefined })} aria-current={board?.id === b.id ? 'true' : undefined}>
                      {b.name}
                      {b.visibility === 'private' ? <span class="fb-hint">Private</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!r.person && !r.embed ? (
            <div class="fb-card">
              <h2 class="fb-h2">Sign in</h2>
              <p class="fb-hint">Confirm your email to vote and post under your name. We never share it.</p>
              <a class="fb-btn ghost" href={`${here}/sign-in?next=${encodeURIComponent(back)}`}>
                Sign in with email
              </a>
            </div>
          ) : null}
        </aside>
      </div>
    </Shell>,
  );
}

feedbackRoutes.get('/feedback/:portal', (c) => home(c, false));
feedbackRoutes.get('/feedback/:portal/embed', (c) => home(c, true));

// ---------------------------------------------------------------------------------------------
// One post
// ---------------------------------------------------------------------------------------------

async function renderPost(r: Req, slug: string, opts: { error?: string; values?: { body?: string; name?: string }; status?: 200 | 422 | 429 | 403 } = {}) {
  const { c, portal, ctx, person } = r;
  const post = await postBySlug(ctx, slug);
  if (!post || post.review === 'rejected' || post.review === 'pending') throw fbErrors.post_missing();
  if (post.review === 'merged' && post.merged_into) {
    const target = await getPostView(ctx, post.merged_into);
    if (target && target.review === 'published') return c.redirect(href(r, `/feedback/${portal.slug}/p/${target.slug}`), 301);
    throw fbErrors.post_missing();
  }
  const boards = await listBoards(ctx);
  const board = boards.find((b) => b.id === post.board_id);
  if (!board || !boardAllowed(board, person)) throw fbErrors.private_board();
  const [comments, voted, tags, token] = await Promise.all([listComments(ctx, post.id), votedSet(ctx, person?.id, [post.id]), postTags(ctx, [post.id]), formToken(c.env, `comment:${portal.id}`)]);
  const here = `/feedback/${portal.slug}/p/${post.slug}`;
  const hide = portal.hide_last_names === 1;
  const who = post.author_name !== null ? displayName(post.author_name, { hideLast: hide, fallback: 'A visitor' }) : 'A visitor';
  const publicTags = (tags.get(post.id) ?? []).filter((t) => t.is_public);
  const desc = excerpt(post.body, 180) || `An idea on ${portal.name}`;
  noCache(c);
  return c.html(
    <Shell r={r} title={post.title} description={desc} path={here} tab="feedback" ogType="article" noindex={board.visibility === 'private'}>
      <Note code={c.req.query('note')} />
      <Alert error={opts.error} />
      <p class="fb-crumb">
        <a href={href(r, `/feedback/${portal.slug}`, { board: board.slug })}>All ideas</a>
        {boards.length > 1 ? ` / ${board.name}` : ''}
      </p>
      <article class="fb-post">
        <div class="fb-post-head">
          <VoteButton r={r} post={post} voted={voted.has(post.id)} back={href(r, here)} />
          <div>
            <h1 class="fb-title">{post.title}</h1>
            <div class="fb-meta">
              <StatusPill name={post.status_name} tone={post.status_tone} />
              {post.category_name ? <span>{post.category_name}</span> : null}
              {publicTags.length ? <span>{publicTags.map((t) => t.name).join(', ')}</span> : null}
              <span>
                {who}, {timeAgo(post.created_at)}
              </span>
              {post.board_hide_votes ? null : <span>{plural(post.vote_count, 'vote')}</span>}
            </div>
          </div>
        </div>
        {post.body ? <div class="fb-body">{raw(renderVisitorMarkdown(post.body))}</div> : null}
        {post.decline_reason ? (
          <div class="fb-decline">
            <strong>Why this was closed</strong>
            <div class="fb-body">{raw(renderVisitorMarkdown(post.decline_reason))}</div>
          </div>
        ) : null}
      </article>
      <section aria-labelledby="comments-h" class="fb-post">
        <h2 class="fb-h2" id="comments-h">
          {comments.length ? plural(comments.length, 'comment') : 'Comments'}
        </h2>
        {comments.length === 0 ? <p class="fb-hint">No comments yet.</p> : null}
        <ol class="fb-comments">
          {comments.map((m) => {
            const name = m.staff_name ?? (m.author_name !== null ? displayName(m.author_name, { hideLast: hide, fallback: 'A visitor' }) : 'A visitor');
            return (
              <li class="fb-comment">
                <Avatar name={name} />
                <div>
                  <div class="who">
                    {name}
                    {m.staff_name ? <span class="fb-staff">Team</span> : null}
                    <span>{timeAgo(m.created_at)}</span>
                  </div>
                  <div class="fb-body">{raw(renderVisitorMarkdown(m.body))}</div>
                </div>
              </li>
            );
          })}
        </ol>
        <form class="fb-form" method="post" action={`${here}/comment`} data-busy-form>
          <Carry r={r} />
          <input type="hidden" name="ft" value={token} />
          <div class="fb-hp" aria-hidden="true">
            <label>
              Leave this empty
              <input type="text" name="website" tabindex={-1} autocomplete="off" />
            </label>
          </div>
          <div class="fb-field">
            <label for="cbody">Add a comment</label>
            <textarea id="cbody" name="body" required maxlength={3000} rows={4}>
              {opts.values?.body ?? ''}
            </textarea>
            <span class="fb-hint">Links are fine. Markdown works.</span>
          </div>
          {!person && r.canGuest ? (
            <div class="fb-field">
              <label for="cname">
                Your name <span class="opt">(optional)</span>
              </label>
              <input class="fb-in" id="cname" name="name" maxlength={60} autocomplete="name" value={opts.values?.name ?? ''} />
            </div>
          ) : null}
          <div class="fb-actions">
            {person || r.canGuest ? (
              <button class="fb-btn" type="submit">
                Post comment
              </button>
            ) : (
              <a class="fb-btn" href={`/feedback/${portal.slug}/sign-in?next=${encodeURIComponent(href(r, here))}`}>
                Sign in to comment
              </a>
            )}
          </div>
        </form>
      </section>
    </Shell>,
    opts.status ?? 200,
  );
}

feedbackRoutes.get('/feedback/:portal/p/:slug', async (c) => renderPost(await loadReq(c), c.req.param('slug')));

feedbackRoutes.post('/feedback/:portal/p/:slug/vote', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const wantsJson = (c.req.header('accept') ?? '').includes('application/json');
  const slug = c.req.param('slug');
  const here = href(r, `/feedback/${r.portal.slug}/p/${slug}`);
  const next = safeNext(body.next, here);
  const withNote = (url: string, code: string) => `${url}${url.includes('?') ? '&' : '?'}note=${code}`;
  try {
    const post = await postBySlug(r.ctx, slug);
    if (!post || post.review !== 'published') throw fbErrors.post_missing();
    const board = (await listBoards(r.ctx)).find((b) => b.id === post.board_id);
    if (!board || !boardAllowed(board, r.person)) throw fbErrors.private_board();
    let rr = r;
    let person = r.person;
    if (!person) {
      if (!r.canGuest) {
        if (wantsJson) return c.json({ signIn: `/feedback/${r.portal.slug}/sign-in?next=${encodeURIComponent(next)}` }, 401);
        return c.redirect(`/feedback/${r.portal.slug}/sign-in?next=${encodeURIComponent(next)}`);
      }
      person = await createGuest(r.ctx, c.req.raw, '');
      rr = await signedInAs(r, person);
    }
    await throttle(c.env, r.portal, 'vote', person, c.req.raw);
    const res = await toggleVote(r.ctx, post, board, person, r.portal.vote_limit);
    if (wantsJson) return c.json({ voted: res.voted, count: res.count, hidden: board.hide_votes === 1 });
    return c.redirect(rr.embed && rr.vt && !next.includes('vt=') ? withNote(next, '').replace(/[?&]note=$/, '') + `${next.includes('?') ? '&' : '?'}vt=${rr.vt}` : next);
  } catch (e) {
    const { message, status } = errorText(e);
    if (wantsJson) return c.json({ error: message }, status);
    return c.redirect(withNote(next, errNote(e)));
  }
});

feedbackRoutes.post('/feedback/:portal/p/:slug/comment', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const slug = c.req.param('slug');
  const here = href(r, `/feedback/${r.portal.slug}/p/${slug}`);
  const text = typeof body.body === 'string' ? body.body : '';
  const name = typeof body.name === 'string' ? body.name : '';
  try {
    const post = await postBySlug(r.ctx, slug);
    if (!post || post.review !== 'published') throw fbErrors.post_missing();
    const board = (await listBoards(r.ctx)).find((b) => b.id === post.board_id);
    if (!board || !boardAllowed(board, r.person)) throw fbErrors.private_board();
    const check = await checkForm(c.env, `comment:${r.portal.id}`, String(body.ft ?? ''), String(body.website ?? ''));
    if (check === 'honeypot') return c.redirect(here);
    if (check !== 'ok') throw fbErrors.spam_suspected();
    let rr = r;
    let person = r.person;
    if (!person) {
      if (!r.canGuest) return c.redirect(`/feedback/${r.portal.slug}/sign-in?next=${encodeURIComponent(here)}`);
      person = await createGuest(r.ctx, c.req.raw, name);
      rr = await signedInAs(r, person);
    } else if (name && !person.name) person = await setName(r.ctx, person, name);
    await throttle(c.env, r.portal, 'comment', person, c.req.raw);
    const res = await addVisitorComment(r.ctx, post, board, person, text);
    const out = href(rr, `/feedback/${r.portal.slug}/p/${slug}`, { note: res.held ? 'comment-held' : 'commented' });
    return c.redirect(res.held ? out : `${out}#comments-h`);
  } catch (e) {
    const { message, status } = errorText(e);
    return renderPost(r, slug, { error: message, values: { body: text, name }, status: status === 429 ? 429 : status === 403 ? 403 : 422 });
  }
});

// ---------------------------------------------------------------------------------------------
// New post
// ---------------------------------------------------------------------------------------------

async function renderNew(r: Req, opts: { error?: string; values?: Record<string, string>; status?: 200 | 403 | 404 | 422 | 429 } = {}) {
  const { c, portal, ctx, person } = r;
  const boards = (await listBoards(ctx)).filter((b) => b.posting_on && boardAllowed(b, person));
  if (boards.length === 0) throw fbErrors.posting_off();
  const cats = await listCategories(ctx);
  const v = opts.values ?? {};
  const want = v.board || c.req.query('board') || '';
  const board = boards.find((b) => b.slug === want || b.id === want) ?? boards[0]!;
  const token = await formToken(c.env, `post:${portal.id}`);
  const here = `/feedback/${portal.slug}/new`;
  noCache(c);
  return c.html(
    <Shell r={r} title="Share an idea" path={here} noindex narrow tab="feedback">
      <p class="fb-crumb">
        <a href={href(r, `/feedback/${portal.slug}`)}>All ideas</a>
      </p>
      <h1 class="fb-title">Share an idea</h1>
      <Alert error={opts.error} />
      {!r.emailUp ? (
        <p class="fb-note warn">Email is not set up on this site, so ideas from guests wait for an admin to approve them before they appear.</p>
      ) : !person ? (
        <p class="fb-note">
          <span>
            <a href={`/feedback/${portal.slug}/sign-in?next=${encodeURIComponent(href(r, here))}`}>Sign in with your email</a> to post under your name and skip the wait for approval.
          </span>
        </p>
      ) : null}
      {!person && !r.canGuest ? (
        <div class="fb-empty">
          <h2>Sign in to post</h2>
          <p>Posting here needs a confirmed email address.</p>
          <a class="fb-btn" href={`/feedback/${portal.slug}/sign-in?next=${encodeURIComponent(href(r, here))}`}>
            Sign in with email
          </a>
        </div>
      ) : (
        <form class="fb-form" method="post" action={here} data-busy-form data-similar-url={`/feedback/${portal.slug}/similar`}>
          <Carry r={r} />
          <input type="hidden" name="ft" value={token} />
          <div class="fb-hp" aria-hidden="true">
            <label>
              Leave this empty
              <input type="text" name="website" tabindex={-1} autocomplete="off" />
            </label>
          </div>
          {boards.length > 1 ? (
            <div class="fb-field">
              <label for="board">Board</label>
              <select id="board" name="board" data-board-select>
                {boards.map((b) => (
                  <option value={b.slug} selected={b.id === board.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <input type="hidden" name="board" value={board.slug} />
          )}
          <div class="fb-field">
            <label for="title">Title</label>
            <input class="fb-in" id="title" name="title" required maxlength={140} value={v.title ?? c.req.query('title') ?? ''} autocomplete="off" aria-describedby="title-hint" data-similar-title />
            <span class="fb-hint" id="title-hint">
              A short summary, like a headline.
            </span>
          </div>
          <ul class="fb-similar" data-similar hidden aria-live="polite"></ul>
          <div class="fb-field">
            <label for="details">
              Details <span class="opt">(optional)</span>
            </label>
            <textarea id="details" name="details" maxlength={5000} rows={6}>
              {v.details ?? ''}
            </textarea>
            <span class="fb-hint">What are you trying to do, and what gets in the way? Markdown works.</span>
          </div>
          {cats.length ? (
            <div class="fb-field">
              <label for="category">
                Category <span class="opt">(optional)</span>
              </label>
              <select id="category" name="category" data-category-select>
                <option value="">No category</option>
                {cats
                  .filter((k) => boards.some((b) => b.id === k.board_id))
                  .map((k) => (
                    <option value={k.id} data-board={boards.find((b) => b.id === k.board_id)?.slug} selected={v.category === k.id}>
                      {boards.length > 1 ? `${boards.find((b) => b.id === k.board_id)?.name}: ${k.name}` : k.name}
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
          {!person ? (
            <div class="fb-field">
              <label for="name">
                Your name <span class="opt">(optional)</span>
              </label>
              <input class="fb-in" id="name" name="name" maxlength={60} autocomplete="name" value={v.name ?? ''} />
            </div>
          ) : null}
          <div class="fb-actions">
            <button class="fb-btn" type="submit">
              Post idea
            </button>
            <a class="fb-btn ghost" href={href(r, `/feedback/${portal.slug}`)}>
              Cancel
            </a>
          </div>
        </form>
      )}
    </Shell>,
    opts.status ?? 200,
  );
}

feedbackRoutes.get('/feedback/:portal/new', async (c) => renderNew(await loadReq(c)));

feedbackRoutes.post('/feedback/:portal/new', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const val = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const values = { board: val('board'), title: val('title'), details: val('details'), category: val('category'), name: val('name') };
  try {
    const boards = await listBoards(r.ctx);
    const board = boards.find((b) => b.slug === values.board);
    if (!board || !boardAllowed(board, r.person)) throw fbErrors.board_missing();
    const check = await checkForm(c.env, `post:${r.portal.id}`, val('ft'), val('website'));
    if (check === 'honeypot') return c.redirect(href(r, `/feedback/${r.portal.slug}`, { note: 'posted' }));
    if (check !== 'ok') throw fbErrors.spam_suspected();
    let rr = r;
    let person = r.person;
    if (!person) {
      if (!r.canGuest) return c.redirect(`/feedback/${r.portal.slug}/sign-in?next=${encodeURIComponent(`/feedback/${r.portal.slug}/new`)}`);
      person = await createGuest(r.ctx, c.req.raw, values.name);
      rr = await signedInAs(r, person);
    } else if (values.name && !person.name) person = await setName(r.ctx, person, values.name);
    await throttle(c.env, r.portal, 'post', person, c.req.raw);
    const res = await submitPost(r.ctx, { board, person, title: values.title, body: values.details, categoryId: values.category || null });
    if (res.post && res.post.review === 'published') return c.redirect(href(rr, `/feedback/${r.portal.slug}/p/${res.post.slug}`, { note: 'posted' }));
    return c.redirect(href(rr, `/feedback/${r.portal.slug}`, { note: `held-${res.held ?? 'moderation'}` }));
  } catch (e) {
    const { message, status } = errorText(e);
    return renderNew(r, { error: message, values, status: status === 429 ? 429 : status === 404 ? 404 : status === 403 ? 403 : 422 });
  }
});

feedbackRoutes.get('/feedback/:portal/similar', async (c) => {
  const r = await loadReq(c);
  const ip = clientIp(c.req.raw);
  if (ip) {
    const rl = await rateLimit(c.env, `feedback.similar:${ip}`, { limit: 60, windowSec: 60 });
    if (!rl.ok) return c.json({ items: [] }, 429);
  }
  const text = (c.req.query('q') ?? '').slice(0, 140);
  if (text.trim().length < 4) return c.json({ items: [] });
  const boards = await listBoards(r.ctx);
  const board = boards.find((b) => b.slug === c.req.query('board'));
  const items = await similarPosts(r.ctx, text, { boardId: board?.id, publicOnly: r.person?.source !== 'sso', limit: 4 });
  c.header('cache-control', 'private, no-cache');
  return c.json({ items: items.map((p) => ({ title: p.title, url: href(r, `/feedback/${r.portal.slug}/p/${p.slug}`), votes: p.board_hide_votes ? null : p.vote_count })) });
});

// ---------------------------------------------------------------------------------------------
// Sign in with an email code
// ---------------------------------------------------------------------------------------------

function SignInPage({ r, next, step, email, error, name }: { r: Req; next: string; step: 'email' | 'code'; email?: string; error?: string; name?: string }) {
  const { portal } = r;
  const here = `/feedback/${portal.slug}/sign-in`;
  return (
    <Shell r={r} title="Sign in" path={here} noindex narrow>
      <h1 class="fb-title">Sign in</h1>
      <Alert error={error} />
      {!r.emailUp ? (
        <div class="fb-card">
          <p>
            This site cannot send email codes yet, so you cannot confirm an address. You can still post and vote as a guest. New ideas from guests wait for an admin to approve them.
          </p>
          <form class="fb-form" method="post" action={`/feedback/${portal.slug}/guest`}>
            <Carry r={r} />
            <input type="hidden" name="next" value={next} />
            <div class="fb-field">
              <label for="gname">
                Your name <span class="opt">(optional)</span>
              </label>
              <input class="fb-in" id="gname" name="name" maxlength={60} autocomplete="name" />
            </div>
            <button class="fb-btn" type="submit">
              Continue as a guest
            </button>
          </form>
        </div>
      ) : step === 'email' ? (
        <form class="fb-form fb-card" method="post" action={here} data-busy-form>
          <Carry r={r} />
          <input type="hidden" name="step" value="email" />
          <input type="hidden" name="next" value={next} />
          <p class="fb-tag">We will email you a six digit code. No password, and we do not use your address for anything else.</p>
          <div class="fb-field">
            <label for="email">Email</label>
            <input class="fb-in" id="email" name="email" type="email" required autocomplete="email" inputmode="email" maxlength={254} value={email ?? ''} aria-invalid={error ? 'true' : undefined} />
          </div>
          <div class="fb-field">
            <label for="name">
              Your name <span class="opt">(optional)</span>
            </label>
            <input class="fb-in" id="name" name="name" maxlength={60} autocomplete="name" value={name ?? ''} />
          </div>
          <button class="fb-btn" type="submit">
            Send code
          </button>
        </form>
      ) : (
        <form class="fb-form fb-card" method="post" action={here} data-busy-form>
          <Carry r={r} />
          <input type="hidden" name="step" value="code" />
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={email ?? ''} />
          <input type="hidden" name="name" value={name ?? ''} />
          <p class="fb-tag">
            We sent a code to <strong>{email}</strong>. It works for 10 minutes.
          </p>
          <div class="fb-field">
            <label for="code">Six digit code</label>
            <input class="fb-in fb-code" id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength={6} pattern="[0-9]{6}" aria-invalid={error ? 'true' : undefined} />
          </div>
          <button class="fb-btn" type="submit">
            Confirm and sign in
          </button>
          <a href={`${here}?next=${encodeURIComponent(next)}`}>Use a different email</a>
        </form>
      )}
    </Shell>
  );
}

feedbackRoutes.get('/feedback/:portal/sign-in', async (c) => {
  const r = await loadReq(c);
  const next = safeNext(c.req.query('next'), `/feedback/${r.portal.slug}`);
  noCache(c);
  return c.html(<SignInPage r={r} next={next} step="email" />);
});

feedbackRoutes.post('/feedback/:portal/sign-in', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const val = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const next = safeNext(val('next'), `/feedback/${r.portal.slug}`);
  const email = val('email');
  const name = val('name');
  const step = val('step') === 'code' ? 'code' : 'email';
  noCache(c);
  try {
    if (step === 'email') {
      const res = await requestCode(r.ctx, r.portal, email, clientIp(c.req.raw) ?? 'unknown');
      if (res.guestOnly) return c.html(<SignInPage r={r} next={next} step="email" />);
      return c.html(<SignInPage r={r} next={next} step="code" email={email.trim().toLowerCase()} name={name} />);
    }
    const person = await verifyCode(r.ctx, email, val('code'), name);
    if (r.person && r.person.id !== person.id) await adoptGuest(r.ctx, r.person, person);
    const rr = await signedInAs(r, person);
    return c.redirect(href(rr, next, { note: 'signed-in' }));
  } catch (e) {
    const { message, status } = errorText(e);
    return c.html(<SignInPage r={r} next={next} step={step === 'code' && status !== 429 && message.includes('expired') === false ? 'code' : 'email'} email={email.trim().toLowerCase()} name={name} error={message} />, status === 429 ? 429 : 422);
  }
});

feedbackRoutes.post('/feedback/:portal/guest', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const next = safeNext(body.next, `/feedback/${r.portal.slug}`);
  if (r.emailUp) return c.redirect(`/feedback/${r.portal.slug}/sign-in?next=${encodeURIComponent(next)}`);
  const person = r.person ?? (await createGuest(r.ctx, c.req.raw, typeof body.name === 'string' ? body.name : ''));
  const rr = await signedInAs(r, person);
  return c.redirect(href(rr, next));
});

feedbackRoutes.post('/feedback/:portal/sign-out', async (c) => {
  const body = await c.req.parseBody();
  const r = await loadReq(c, body);
  const next = safeNext(body.next, `/feedback/${r.portal.slug}`);
  const h = new Headers();
  setVisitorCookie(h, r.portal, '', new URL(c.req.url).protocol === 'https:');
  c.header('set-cookie', h.get('set-cookie')!.replace(/Max-Age=\d+/, 'Max-Age=0'), { append: true });
  return c.redirect(`${next}${next.includes('?') ? '&' : '?'}note=signed-out`);
});

// ---------------------------------------------------------------------------------------------
// Widget support: seen ping, changelog feed for the popover, theme override
// ---------------------------------------------------------------------------------------------

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };

feedbackRoutes.options('/feedback/:portal/ping', (c) => c.body(null, 204, CORS));
feedbackRoutes.options('/feedback/:portal/latest.json', (c) => c.body(null, 204, CORS));

feedbackRoutes.post('/feedback/:portal/ping', async (c) => {
  const r = await loadReq(c);
  const origin = c.req.header('origin') ?? '';
  let host = '';
  try {
    host = new URL(origin || c.req.header('referer') || '').hostname;
  } catch {
    host = '';
  }
  if (/^[a-z0-9.-]{1,100}$/i.test(host)) {
    // One write a minute per workspace is plenty for a "connected" light.
    const rl = await rateLimit(c.env, `feedback.ping:${r.portal.org_id}`, { limit: 1, windowSec: 60 });
    if (rl.ok) await r.ctx.db.update('fb_portals', r.portal.id, { widget_seen_at: Date.now(), widget_host: host.toLowerCase() });
  }
  return c.body(null, 204, CORS);
});

feedbackRoutes.get('/feedback/:portal/latest.json', async (c) => {
  const r = await loadReq(c);
  if (!r.portal.changelog_on) return c.json({ name: r.portal.name, latest: 0, items: [] }, 200, CORS);
  const page = await listEntries(r.ctx, { state: 'published', limit: 5 });
  const items = page.items.map((e) => ({
    title: e.title,
    url: `${r.origin}/changelog/${r.portal.slug}/${e.slug}`,
    at: e.published_at ?? e.created_at,
    labels: entryLabels(e),
    summary: excerpt(markdownToText(e.body), 140),
  }));
  c.header('cache-control', 'public, max-age=60');
  return c.json({ name: r.portal.name, latest: items[0]?.at ?? 0, all: `${r.origin}/changelog/${r.portal.slug}`, items }, 200, CORS);
});

function channel(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function luminance(rgb: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
const hex2 = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const onColour = (rgb: [number, number, number]) => (luminance(rgb) > 0.4 ? '#111111' : '#ffffff');

/** The portal's accent colour as a stylesheet, so no inline style is needed. Dark mode gets a lighter mix. */
export function themeCss(accent: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) return '';
  const rgb = channel(accent);
  const lift = rgb.map((v) => v + (255 - v) * 0.4) as [number, number, number];
  const dark = hex2(lift);
  const light = `--ac:${accent};--at:${accent};--on:${onColour(rgb)}`;
  const night = `--ac:${dark};--at:${dark};--on:${onColour(lift)}`;
  return `:root{${light}}\n@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${night}}}\n:root[data-theme="dark"]{${night}}\n`;
}

feedbackRoutes.get('/feedback/:portal/theme.css', async (c) => {
  const r = await loadReq(c);
  c.header('cache-control', 'public, max-age=300');
  return c.body(r.portal.accent ? themeCss(r.portal.accent) : '', 200, { 'content-type': 'text/css; charset=utf-8' });
});

// ---------------------------------------------------------------------------------------------
// Unsubscribe from close-the-loop emails. GET asks, POST does it (also the one-click mail client request).
// ---------------------------------------------------------------------------------------------

feedbackRoutes.get('/feedback/:portal/unsubscribe', async (c) => {
  const r = await loadReq(c);
  const target = await readUnsubTarget(c.env, c.req.query('t'), c.req.query('a'));
  noCache(c);
  return c.html(unsubscribePage(r, target, false), target ? 200 : 422);
});

feedbackRoutes.post('/feedback/:portal/unsubscribe', async (c) => {
  const q = c.req.query();
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
  const r = await loadReq(c);
  const t = q.t || (typeof body.t === 'string' ? body.t : undefined);
  const a = q.a || (typeof body.a === 'string' ? body.a : undefined);
  const target = await readUnsubTarget(c.env, t, a);
  if (target?.kind === 'person' && target.org === r.portal.org_id) await mailOff(r.ctx, target.id, true);
  if (target?.kind === 'admin' && target.org === r.portal.org_id) {
    const left = r.portal.digest_emails.split(',').filter((e) => e && e !== target.email);
    await updatePortal(r.ctx, { digest_emails: left.join(',') });
  }
  noCache(c);
  return c.html(unsubscribePage(r, target, true), target ? 200 : 422);
});

