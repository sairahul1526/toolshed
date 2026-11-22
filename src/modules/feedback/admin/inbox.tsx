/** Admin: first run, inbox and triage, post detail, merge, comments held for review, roadmap view. */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import { orgDb } from '../../../core/db';
import { needRole } from '../../../core/guards';
import type { AppEnv } from '../../../env';
import {
  Button, Callout, Card, CopyField, DangerZone, EmptyState, Field, FilterBar, Input, KeyValueList, LinkButton, PageHeader, Pill, Select, Table, Tabs, Textarea, Checkbox, SearchInput,
  ConfirmButton, renderPage, formatNumber, plural, timeAgo,
} from '../../../ui';
import { actorOf } from '../api';
import { fbErrors } from '../errors';
import { renderVisitorMarkdown } from '../lib';
import { mailOff, upsertEmailPerson } from '../people';
import { createPortal, listBoards, listCategories, listStatuses, listTags, type Ctx } from '../portal';
import {
  addNote, addStaffComment, addVoteFor, approveComment, approvePost, changeStatus, deleteComment, deletePost, getPostView, inboxCounts, insertPost, listComments, listNotes, listPosts, listVoters,
  mergePosts, mergePreview, pendingComments, postTags, rejectComment, rejectPost, setPostTags, updatePost, type Sort,
} from '../posts';
import { errorText } from '../pub/kit';
import { clearSample, seedSample } from '../sample';
import type { Portal } from '../types';
import { A, done, fail, flag, loadAdmin, str, tone } from './common';

export const inbox = new Hono<AppEnv>();

const SOURCE_LABEL: Record<string, string> = { portal: 'Portal', admin: 'Added by your team', api: 'API', import: 'Import', widget: 'Widget', sample: 'Sample data' };

const VIEWS = [
  { id: 'all', label: 'All posts' },
  { id: 'review', label: 'Needs review' },
  { id: 'reply', label: 'Needs a reply' },
  { id: 'comments', label: 'Held comments' },
] as const;

// ---------------------------------------------------------------------------------------------
// First run: three steps
// ---------------------------------------------------------------------------------------------

function Steps({ portal, c, hasSample, total }: { portal: Portal | null; c: { req: { url: string } }; hasSample: boolean; total: number }) {
  const connected = Boolean(portal?.widget_seen_at);
  const origin = new URL(c.req.url).origin;
  return (
    <Card title="Get started" description="Three steps. You can do them in any order and come back later.">
      <ol class="fb-steps">
        <li>
          <strong>Name your portal</strong> {portal ? <Pill tone="good">Done</Pill> : null}
          {portal ? (
            <p class="hint">Your portal is live at {origin}/feedback/{portal.slug}</p>
          ) : (
            <form method="post" action={`${A}/start`} class="stack">
              <Field id="s-name" label="Portal name" hint="Shown at the top of the public pages.">
                <Input id="s-name" name="name" required maxlength={60} placeholder="Acme feedback" />
              </Field>
              <Field id="s-slug" label="Address" optional hint="Lowercase letters, numbers and dashes. Leave empty to pick one for you.">
                <Input id="s-slug" name="slug" maxlength={40} prefix="/feedback/" />
              </Field>
              <div>
                <Button type="submit" variant="primary">
                  Create portal
                </Button>
              </div>
            </form>
          )}
        </li>
        <li>
          <strong>Add the widget to your site</strong> {connected ? <Pill tone="good">Widget connected</Pill> : portal ? <Pill tone="warn">Not seen yet</Pill> : null}
          {portal ? (
            <p class="hint">
              {connected ? `Last seen on ${portal.widget_host}.` : 'Paste one line of code into your site. This light turns on after the first page view.'}{' '}
              <a href={`${A}/settings/widget`}>Get the code</a>
            </p>
          ) : (
            <p class="hint">Available once the portal exists.</p>
          )}
        </li>
        <li>
          <strong>Share it and see the first ideas</strong> {total > 0 ? <Pill tone="good">{plural(total, 'idea')}</Pill> : null}
          {portal ? (
            <div class="stack">
              <CopyField label="Public link" value={`${origin}/feedback/${portal.slug}`} secret={false} />
              <form method="post" action={hasSample ? `${A}/sample/clear` : `${A}/sample`}>
                <Button type="submit">{hasSample ? 'Clear sample data' : 'Fill with sample data'}</Button>
              </form>
            </div>
          ) : (
            <form method="post" action={`${A}/sample`}>
              <p class="hint">Want to look around first? Fill the portal with believable sample posts, and clear them when you are done.</p>
              <Button type="submit">Create it with sample data</Button>
            </form>
          )}
        </li>
      </ol>
    </Card>
  );
}

inbox.post('/start', async (c) => {
  needRole(c, 'admin');
  const a = await loadAdmin(c);
  const body = await c.req.parseBody();
  try {
    await createPortal(a.ctx, { name: str(body, 'name'), slug: str(body, 'slug') || undefined });
    return done(c, A, 'Portal created.');
  } catch (e) {
    return fail(c, A, e);
  }
});

function mctx(c: import('hono').Context<AppEnv>) {
  const org = c.get('org')!;
  return { env: c.env, org: { id: org.id, name: org.name, slug: org.slug }, db: orgDb(c.env.DB, org.id) };
}

inbox.post('/sample', async (c) => {
  needRole(c, 'admin');
  try {
    await seedSample(mctx(c));
    return done(c, A, 'Sample data added. Clear it any time.');
  } catch (e) {
    return fail(c, A, e);
  }
});

inbox.post('/sample/clear', async (c) => {
  needRole(c, 'admin');
  await clearSample(mctx(c));
  return done(c, A, 'Sample data cleared.');
});

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

inbox.get('/', async (c) => {
  const a = await loadAdmin(c);
  const { ctx, portal } = a;
  const q = c.req.query();
  if (!portal) {
    return renderPage(c, { title: 'Feedback' }, (
      <>
        <PageHeader title="Feedback" description="Let customers post ideas and vote, then close the loop when you ship." />
        <Steps portal={null} c={c} hasSample={false} total={0} />
      </>
    ));
  }
  const view = VIEWS.some((v) => v.id === q.view) ? q.view! : 'all';
  const [counts, boards, statuses] = await Promise.all([inboxCounts(ctx), listBoards(ctx), listStatuses(ctx)]);
  const hasSample = Boolean((await ctx.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM fb_posts WHERE org_id = :org AND sample = 1'))?.n);
  const sort: Sort = q.sort === 'new' || q.sort === 'trending' ? (q.sort as Sort) : 'top';
  const tabs = VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    href: `${A}?view=${v.id}`,
    count: v.id === 'review' ? counts.pendingPosts : v.id === 'reply' ? counts.needsReply : v.id === 'comments' ? counts.pendingComments : undefined,
  }));
  const showSteps = counts.total === 0 || !portal.widget_seen_at || hasSample;
  let body;
  if (view === 'comments') {
    const held = await pendingComments(ctx, 50);
    body = (
      <Card flush>
        <Table
          caption="Comments waiting for review"
          columns={[
            { key: 'comment', label: 'Comment' },
            { key: 'post', label: 'On', hideOnMobile: true },
            { key: 'act', label: 'Actions', srOnly: true },
          ]}
          rows={held.map((m) => ({
            comment: (
              <div>
                <div class="wrap">{m.body.slice(0, 400)}</div>
                <div class="hint">{m.author_name ?? 'A guest'}, {timeAgo(m.created_at)}</div>
              </div>
            ),
            post: <a href={`${A}/posts/${m.post_id}`}>{m.post_title}</a>,
            act: (
              <form method="post" class="row">
                <Button size="sm" variant="primary" type="submit" formAction={`${A}/comments/${m.id}/approve`}>
                  Approve
                </Button>
                <Button size="sm" type="submit" formAction={`${A}/comments/${m.id}/reject`}>
                  Reject
                </Button>
              </form>
            ),
          }))}
          empty={<EmptyState bare icon="check" title="No comments waiting" body="Held comments show up here so you can approve or reject them." />}
        />
      </Card>
    );
  } else {
    const page = await listPosts(ctx, {
      review: view === 'review' ? 'pending' : 'published',
      needsReply: view === 'reply',
      boardId: boards.find((b) => b.slug === q.board)?.id,
      statusId: statuses.find((s) => s.id === q.status)?.id,
      q: (q.q ?? '').slice(0, 80),
      sort: view === 'review' ? 'new' : sort,
      cursor: q.cursor,
      limit: 25,
    });
    const keep = new URLSearchParams({ view });
    for (const k of ['q', 'board', 'status', 'sort']) if (q[k]) keep.set(k, q[k]!);
    body = (
      <>
        <FilterBar action={A}>
          <input type="hidden" name="view" value={view} />
          <SearchInput name="q" label="Search posts" value={q.q ?? ''} placeholder="Search posts" />
          <Select id="f-board" name="board" aria-label="Board" value={q.board ?? ''} options={[{ value: '', label: 'All boards' }, ...boards.map((b) => ({ value: b.slug, label: b.name }))]} />
          <Select id="f-status" name="status" aria-label="Status" value={q.status ?? ''} options={[{ value: '', label: 'Any status' }, ...statuses.map((s) => ({ value: s.id, label: s.name }))]} />
          <Select id="f-sort" name="sort" aria-label="Sort" value={sort} options={[{ value: 'top', label: 'Top' }, { value: 'trending', label: 'Trending' }, { value: 'new', label: 'New' }]} />
        </FilterBar>
        <Card flush>
          <Table
            caption={view === 'review' ? 'Posts waiting for review' : 'Posts'}
            columns={[
              { key: 'title', label: 'Post' },
              { key: 'status', label: 'Status' },
              { key: 'votes', label: 'Votes', numeric: true },
              { key: 'comments', label: 'Comments', numeric: true, hideOnMobile: true },
              { key: 'age', label: 'Posted', hideOnMobile: true },
              ...(view === 'review' ? [{ key: 'act', label: 'Actions', srOnly: true }] : []),
            ]}
            rows={page.items.map((p) => ({
              title: (
                <div>
                  <a href={`${A}/posts/${p.id}`}>
                    <strong>{p.title}</strong>
                  </a>
                  <div class="hint">
                    {p.board_name}
                    {p.author_name ? `, ${p.author_name}` : ''}
                    {p.held_reason ? `, held: ${p.held_reason}` : ''}
                  </div>
                </div>
              ),
              status: p.status_name ? <Pill tone={tone(p.status_tone)}>{p.status_name}</Pill> : '',
              votes: formatNumber(p.vote_count),
              comments: formatNumber(p.comment_count),
              age: timeAgo(p.created_at),
              act: (
                <form method="post" class="row">
                  <Button size="sm" variant="primary" type="submit" formAction={`${A}/posts/${p.id}/approve`}>
                    Approve
                  </Button>
                  <Button size="sm" type="submit" formAction={`${A}/posts/${p.id}/reject`}>
                    Reject
                  </Button>
                </form>
              ),
            }))}
            empty={
              <EmptyState
                bare
                icon="msg"
                title={view === 'review' ? 'Nothing to review' : view === 'reply' ? 'Everything has a reply' : q.q ? 'No posts match' : 'No posts yet'}
                body={view === 'all' && !q.q ? 'Share your portal link or add the widget. You can also post on behalf of a customer.' : undefined}
              />
            }
          />
        </Card>
        {page.nextCursor ? (
          <p>
            <LinkButton href={`${A}?${keep.toString()}&cursor=${encodeURIComponent(page.nextCursor)}`}>Show more</LinkButton>
          </p>
        ) : null}
      </>
    );
  }
  return renderPage(c, { title: 'Feedback' }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader
        title="Feedback"
        soft={plural(counts.total, 'post')}
        description="Ideas from your customers. Triage them, reply, and move them along."
        actions={
          <>
            <LinkButton href={`${A}/posts/new`} icon="plus">
              Post for a customer
            </LinkButton>
            <LinkButton href={`/feedback/${portal.slug}`} icon="globe" target="_blank" rel="noopener">
              View portal
            </LinkButton>
          </>
        }
      />
      {showSteps ? <Steps portal={portal} c={c} hasSample={hasSample} total={counts.total} /> : null}
      <Tabs label="Inbox views" items={tabs} active={view} />
      {body}
    </>
  ));
});

// ---------------------------------------------------------------------------------------------
// Post on behalf of a customer
// ---------------------------------------------------------------------------------------------

async function newPostPage(c: import('hono').Context<AppEnv>, opts: { error?: string; fields?: Record<string, string>; values?: Record<string, string>; status?: 422 } = {}) {
  const a = await loadAdmin(c);
  if (!a.portal) return c.redirect(A);
  const [boards, cats] = await Promise.all([listBoards(a.ctx), listCategories(a.ctx)]);
  const v = opts.values ?? {};
  const f = opts.fields ?? {};
  return renderPage(c, { title: 'Post for a customer', crumbs: [{ label: 'Feedback', href: A }, { label: 'Post for a customer' }], status: opts.status }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader title="Post for a customer" description="Record an idea you heard on a call or in an email. It is published right away under their name." />
      {opts.error ? <Callout tone="bad" title="That did not save">{opts.error}</Callout> : null}
      <Card>
        <form method="post" action={`${A}/posts/new`} class="stack" data-busy-form>
          <Field id="np-board" label="Board">
            <Select id="np-board" name="board" value={v.board ?? boards[0]?.slug} options={boards.map((b) => ({ value: b.slug, label: b.name }))} />
          </Field>
          <Field id="np-title" label="Title" error={f.title}>
            <Input id="np-title" name="title" required maxlength={140} value={v.title ?? ''} invalid={Boolean(f.title)} />
          </Field>
          <Field id="np-details" label="Details" optional>
            <Textarea id="np-details" name="details" rows={5} maxlength={5000} value={v.details ?? ''} />
          </Field>
          {cats.length ? (
            <Field id="np-cat" label="Category" optional>
              <Select id="np-cat" name="category" value={v.category ?? ''} options={[{ value: '', label: 'No category' }, ...cats.map((k) => ({ value: k.id, label: `${boards.find((b) => b.id === k.board_id)?.name ?? ''}: ${k.name}` }))]} />
            </Field>
          ) : null}
          <Field id="np-email" label="Customer email" error={f.email} hint="Votes and replies are tied to this address.">
            <Input id="np-email" name="email" type="email" required maxlength={254} value={v.email ?? ''} invalid={Boolean(f.email)} />
          </Field>
          <Field id="np-name" label="Customer name" optional>
            <Input id="np-name" name="name" maxlength={60} value={v.name ?? ''} />
          </Field>
          <Checkbox name="mail" label="Email them when this changes" description="Only turn this on if they asked to hear back." checked={v.mail === 'on'} />
          <div class="row">
            <Button type="submit" variant="primary">
              Publish post
            </Button>
            <LinkButton href={A} variant="ghost">
              Cancel
            </LinkButton>
          </div>
        </form>
      </Card>
    </>
  ));
}

inbox.get('/posts/new', (c) => newPostPage(c));

inbox.post('/posts/new', async (c) => {
  needRole(c, 'member');
  const a = await loadAdmin(c);
  const b = await c.req.parseBody();
  const values = { board: str(b, 'board'), title: str(b, 'title'), details: str(b, 'details'), category: str(b, 'category'), email: str(b, 'email'), name: str(b, 'name'), mail: flag(b, 'mail') ? 'on' : '' };
  try {
    const board = (await listBoards(a.ctx)).find((x) => x.slug === values.board);
    if (!board) throw fbErrors.board_missing();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) throw fbErrors.email_invalid();
    const person = await upsertEmailPerson(a.ctx, values.email, { name: values.name.trim().slice(0, 60), source: 'admin' });
    if (person.blocked) throw fbErrors.blocked();
    await mailOff(a.ctx, person.id, !flag(b, 'mail'));
    const cat = values.category ? await a.ctx.db.get<{ board_id: string }>('fb_categories', values.category) : null;
    const post = await insertPost(a.ctx, { board, title: values.title, body: values.details, authorId: person.id, createdBy: actorOf(c).id, categoryId: cat && cat.board_id === board.id ? values.category : null, source: 'admin' });
    return done(c, `${A}/posts/${post.id}`, 'Post published.');
  } catch (e) {
    const t = errorText(e);
    const fields = { ...t.fields };
    if (e instanceof Error && 'code' in e && String((e as { code: string }).code).endsWith('email_invalid')) fields.email = t.message;
    return newPostPage(c, { error: t.message, fields, values, status: 422 });
  }
});

// ---------------------------------------------------------------------------------------------
// One post
// ---------------------------------------------------------------------------------------------

inbox.get('/posts/:id', async (c) => {
  const a = await loadAdmin(c);
  if (!a.portal) return c.redirect(A);
  const { ctx, portal } = a;
  const post = await getPostView(ctx, c.req.param('id'));
  if (!post) throw fbErrors.post_missing();
  const [comments, notes, voters, statuses, tagList, boards, cats, tags] = await Promise.all([
    listComments(ctx, post.id, { includeHeld: true }),
    listNotes(ctx, post.id),
    listVoters(ctx, post.id, 30),
    listStatuses(ctx),
    listTags(ctx),
    listBoards(ctx),
    listCategories(ctx, post.board_id),
    postTags(ctx, [post.id]),
  ]);
  const mine = new Set((tags.get(post.id) ?? []).map((t) => t.id));
  const here = `${A}/posts/${post.id}`;
  const closed = statuses.find((s) => s.id === post.status_id)?.kind === 'closed';
  return renderPage(c, { title: post.title, crumbs: [{ label: 'Feedback', href: A }, { label: post.title }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader
        title={post.title}
        soft={post.board_name}
        description={`${post.author_name ?? 'A guest'}${post.author_email ? ` (${post.author_email})` : ''}, ${timeAgo(post.created_at)}`}
        actions={
          post.review === 'published' ? (
            <LinkButton href={`/feedback/${portal.slug}/p/${post.slug}`} icon="globe" target="_blank" rel="noopener">
              View public page
            </LinkButton>
          ) : null
        }
      />
      {post.review === 'pending' ? (
        <Callout
          tone="warn"
          title="Waiting for review"
          actions={
            <form method="post" class="row">
              <Button variant="primary" type="submit" formAction={`${here}/approve`}>
                Approve
              </Button>
              <Button type="submit" formAction={`${here}/reject`}>
                Reject
              </Button>
            </form>
          }
        >
          {post.held_reason === 'guest' ? 'It came from someone who has not confirmed an email address.' : post.held_reason === 'links' ? 'It has several links.' : 'This board checks posts before they appear.'}
        </Callout>
      ) : null}
      {post.review === 'merged' ? <Callout tone="info" title="This post was merged">Its votes and comments moved to another post.</Callout> : null}
      <div class="fb-admin-grid">
        <div class="stack">
          <Card title="Idea">
            {post.body ? <div class="prose">{raw(renderVisitorMarkdown(post.body))}</div> : <p class="hint">No details were added.</p>}
            <KeyValueList
              items={[
                { label: 'Votes', value: formatNumber(post.vote_count) },
                { label: 'Category', value: post.category_name ?? 'None' },
                { label: 'Source', value: SOURCE_LABEL[post.source] ?? post.source },
                { label: 'First reply', value: post.first_reply_at ? timeAgo(post.first_reply_at) : 'Not yet' },
              ]}
            />
          </Card>
          <Card title="Conversation" description="Replies from you are public and emailed to voters unless you turn that off.">
            {comments.length === 0 ? <p class="hint">No comments yet.</p> : null}
            <ul class="fb-admin-list">
              {comments.map((m) => (
                <li>
                  <div class="hint">
                    {m.staff_name ? `${m.staff_name} (team)` : (m.author_name ?? 'A guest')}, {timeAgo(m.created_at)}
                    {m.review === 'pending' ? ' , held' : ''}
                  </div>
                  <div class="prose">{raw(renderVisitorMarkdown(m.body))}</div>
                  <form method="post" class="row">
                    {m.review === 'pending' ? (
                      <>
                        <Button size="sm" variant="primary" type="submit" formAction={`${A}/comments/${m.id}/approve?back=${post.id}`}>
                          Approve
                        </Button>
                        <Button size="sm" type="submit" formAction={`${A}/comments/${m.id}/reject?back=${post.id}`}>
                          Reject
                        </Button>
                      </>
                    ) : null}
                    <ConfirmButton id={`dc-${m.id}`} size="sm" variant="ghost" title="Delete this comment" body="It will be removed for everyone. This cannot be undone." confirmLabel="Delete comment" formAction={`${A}/comments/${m.id}/delete?back=${post.id}`}>
                      Delete
                    </ConfirmButton>
                  </form>
                </li>
              ))}
            </ul>
            <form method="post" action={`${here}/reply`} class="stack" data-busy-form>
              <Field id="reply" label="Reply as the team">
                <Textarea id="reply" name="body" rows={4} maxlength={3000} required />
              </Field>
              <Checkbox name="notify" label="Email people who voted or commented" checked />
              <div>
                <Button type="submit" variant="primary">
                  Post reply
                </Button>
              </div>
            </form>
          </Card>
          <Card title="Internal notes" description="Only your team sees these.">
            {notes.length === 0 ? <p class="hint">No notes yet.</p> : null}
            <ul class="fb-admin-list">
              {notes.map((n) => (
                <li>
                  <div class="hint">
                    {n.user_name}, {timeAgo(n.created_at)}
                  </div>
                  <div class="wrap">{n.body}</div>
                </li>
              ))}
            </ul>
            <form method="post" action={`${here}/note`} class="stack">
              <Field id="note" label="Add a note">
                <Textarea id="note" name="body" rows={3} maxlength={2000} required />
              </Field>
              <div>
                <Button type="submit">Save note</Button>
              </div>
            </form>
          </Card>
        </div>
        <div class="stack">
          <Card title="Status">
            <form method="post" action={`${here}/status`} class="stack" data-busy-form>
              <Field id="st" label="Status">
                <Select id="st" name="status" value={post.status_id ?? ''} options={statuses.map((s) => ({ value: s.id, label: s.name }))} />
              </Field>
              <Field id="st-reason" label="Reason for closing" optional hint="Shown on the public page and emailed to voters when the status is a closed one.">
                <Textarea id="st-reason" name="reason" rows={3} maxlength={1000} value={closed ? (post.decline_reason ?? '') : ''} />
              </Field>
              <Checkbox name="silent" label="Do not email followers" />
              <div>
                <Button type="submit" variant="primary">
                  Update status
                </Button>
              </div>
            </form>
          </Card>
          <Card title="Details">
            <form method="post" action={`${here}/details`} class="stack">
              <Field id="d-title" label="Title">
                <Input id="d-title" name="title" value={post.title} maxlength={140} required />
              </Field>
              <Field id="d-board" label="Board">
                <Select id="d-board" name="board" value={post.board_id} options={boards.map((b) => ({ value: b.id, label: b.name }))} />
              </Field>
              {cats.length ? (
                <Field id="d-cat" label="Category" optional>
                  <Select id="d-cat" name="category" value={post.category_id ?? ''} options={[{ value: '', label: 'No category' }, ...cats.map((k) => ({ value: k.id, label: k.name }))]} />
                </Field>
              ) : null}
              <Field id="d-assignee" label="Assigned to" optional hint="A name or email. Filtering by assignee is available in the API.">
                <Input id="d-assignee" name="assignee" value={post.assignee ?? ''} maxlength={100} />
              </Field>
              {tagList.length ? (
                <fieldset class="fb-tags">
                  <legend>Tags</legend>
                  {tagList.map((t) => (
                    <Checkbox name="tag" value={t.id} label={t.is_public ? t.name : `${t.name} (internal)`} checked={mine.has(t.id)} />
                  ))}
                </fieldset>
              ) : null}
              <div>
                <Button type="submit">Save details</Button>
              </div>
            </form>
          </Card>
          {post.review === 'published' ? (
            <>
              <Card title="Merge into another post" description="Use this for duplicates. You see a preview first.">
                <form method="get" action={`${here}/merge`} class="stack">
                  <Field id="m-q" label="Find the post to keep">
                    <Input id="m-q" name="q" placeholder="Search by title" required />
                  </Field>
                  <div>
                    <Button type="submit">Find posts</Button>
                  </div>
                </form>
              </Card>
              <Card title={`Voters (${voters.length}${post.vote_count > voters.length ? '+' : ''})`}>
                <ul class="fb-admin-list">
                  {voters.map((v) => (
                    <li>
                      {v.name || v.email || 'A guest'}
                      {v.email && v.name ? <span class="hint"> {v.email}</span> : null}
                    </li>
                  ))}
                </ul>
                <form method="post" action={`${here}/vote-for`} class="stack">
                  <Field id="vf-email" label="Add a vote for a customer">
                    <Input id="vf-email" name="email" type="email" required maxlength={254} placeholder="customer@example.com" />
                  </Field>
                  <div>
                    <Button type="submit">Add vote</Button>
                  </div>
                </form>
              </Card>
            </>
          ) : null}
          <DangerZone
            items={[
              {
                title: 'Delete this post',
                description: 'Removes the post, its votes, comments and notes for good.',
                action: (
                  <form method="post" action={`${here}/delete`}>
                    <ConfirmButton id="del-post" title="Delete this post" body="The post, its votes and comments will be removed. This cannot be undone." confirmLabel="Delete post">
                      Delete post
                    </ConfirmButton>
                  </form>
                ),
              },
            ]}
          />
        </div>
      </div>
    </>
  ));
});

async function postOrThrow(c: import('hono').Context<AppEnv>): Promise<{ ctx: Ctx; id: string; here: string }> {
  const a = await loadAdmin(c);
  if (!a.portal) throw fbErrors.portal_missing();
  const id = c.req.param('id')!;
  return { ctx: a.ctx, id, here: `${A}/posts/${id}` };
}

inbox.post('/posts/:id/approve', async (c) => {
  needRole(c, 'member');
  const { ctx, id } = await postOrThrow(c);
  try {
    await approvePost(ctx, id);
    return done(c, `${A}?view=review`, 'Post approved and published.');
  } catch (e) {
    return fail(c, `${A}?view=review`, e);
  }
});

inbox.post('/posts/:id/reject', async (c) => {
  needRole(c, 'member');
  const { ctx, id } = await postOrThrow(c);
  try {
    await rejectPost(ctx, id);
    return done(c, `${A}?view=review`, 'Post rejected.');
  } catch (e) {
    return fail(c, `${A}?view=review`, e);
  }
});

inbox.post('/posts/:id/status', async (c) => {
  needRole(c, 'member');
  const { ctx, id, here } = await postOrThrow(c);
  const b = await c.req.parseBody();
  try {
    await changeStatus(ctx, id, str(b, 'status'), actorOf(c), { reason: str(b, 'reason') || undefined, silent: flag(b, 'silent') });
    return done(c, here, 'Status updated.');
  } catch (e) {
    return fail(c, here, e);
  }
});

inbox.post('/posts/:id/details', async (c) => {
  needRole(c, 'member');
  const { ctx, id, here } = await postOrThrow(c);
  const b = await c.req.parseBody({ all: true });
  const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  try {
    await updatePost(ctx, id, { title: one('title'), board_id: one('board') || undefined, category_id: one('category') || null, assignee: one('assignee') || null });
    const tags = Array.isArray(b.tag) ? (b.tag as string[]) : typeof b.tag === 'string' ? [b.tag] : [];
    await setPostTags(ctx, id, tags);
    return done(c, here, 'Details saved.');
  } catch (e) {
    return fail(c, here, e);
  }
});

inbox.post('/posts/:id/reply', async (c) => {
  needRole(c, 'member');
  const { ctx, id, here } = await postOrThrow(c);
  const b = await c.req.parseBody();
  try {
    await addStaffComment(ctx, id, actorOf(c), str(b, 'body'), { notify: flag(b, 'notify') });
    return done(c, here, 'Reply posted.');
  } catch (e) {
    return fail(c, here, e);
  }
});

inbox.post('/posts/:id/note', async (c) => {
  needRole(c, 'member');
  const { ctx, id, here } = await postOrThrow(c);
  const b = await c.req.parseBody();
  try {
    await addNote(ctx, id, actorOf(c), str(b, 'body'));
    return done(c, here, 'Note saved.');
  } catch (e) {
    return fail(c, here, e);
  }
});

inbox.post('/posts/:id/vote-for', async (c) => {
  needRole(c, 'member');
  const { ctx, id, here } = await postOrThrow(c);
  const b = await c.req.parseBody();
  try {
    const email = str(b, 'email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw fbErrors.email_invalid();
    const person = await upsertEmailPerson(ctx, email, { source: 'admin' });
    if (person.blocked) throw fbErrors.blocked();
    await addVoteFor(ctx, id, person.id);
    return done(c, here, 'Vote added.');
  } catch (e) {
    return fail(c, here, e);
  }
});

inbox.post('/posts/:id/delete', async (c) => {
  needRole(c, 'admin');
  const { ctx, id } = await postOrThrow(c);
  try {
    await deletePost(ctx, id);
    return done(c, A, 'Post deleted.');
  } catch (e) {
    return fail(c, A, e);
  }
});

// Merge: pick, preview, confirm.
inbox.get('/posts/:id/merge', async (c) => {
  const { ctx, id, here } = await postOrThrow(c);
  const into = c.req.query('into');
  const source = await getPostView(ctx, id);
  if (!source) throw fbErrors.post_missing();
  if (!into) {
    const q = (c.req.query('q') ?? '').slice(0, 80);
    const found = (await listPosts(ctx, { q, limit: 12 })).items.filter((p) => p.id !== id);
    return renderPage(c, { title: 'Merge', crumbs: [{ label: 'Feedback', href: A }, { label: source.title, href: here }, { label: 'Merge' }] }, (
      <>
        <PageHeader title="Merge into another post" soft={source.title} description="Pick the post to keep. Nothing changes until you confirm." />
        <Card flush>
          <Table
            caption="Posts you can merge into"
            columns={[{ key: 'title', label: 'Post' }, { key: 'votes', label: 'Votes', numeric: true }, { key: 'act', label: 'Choose', srOnly: true }]}
            rows={found.map((p) => ({ title: p.title, votes: String(p.vote_count), act: <LinkButton size="sm" href={`${here}/merge?into=${p.id}`}>Preview merge</LinkButton> }))}
            empty={<EmptyState bare icon="search" title="No posts found" body="Try other words from the title." />}
          />
        </Card>
      </>
    ));
  }
  try {
    const pv = await mergePreview(ctx, id, into);
    return renderPage(c, { title: 'Confirm merge', crumbs: [{ label: 'Feedback', href: A }, { label: source.title, href: here }, { label: 'Confirm merge' }] }, (
      <>
        <PageHeader title="Confirm merge" description="Review what moves. People who voted on the merged post are not asked again." />
        <Card>
          <KeyValueList
            items={[
              { label: 'Merging', value: pv.source.title },
              { label: 'Into', value: pv.target.title },
              { label: 'Votes that move', value: formatNumber(pv.votesMoved) },
              { label: 'Voted on both, counted once', value: formatNumber(pv.votesAlready) },
              { label: 'Comments that move', value: formatNumber(pv.commentsMoved) },
              { label: 'Votes after the merge', value: formatNumber(pv.resultVotes) },
            ]}
          />
          <form method="post" action={`${here}/merge`} class="row">
            <input type="hidden" name="into" value={into} />
            <Button type="submit" variant="primary">
              Merge posts
            </Button>
            <LinkButton href={here} variant="ghost">
              Cancel
            </LinkButton>
          </form>
        </Card>
      </>
    ));
  } catch (e) {
    return fail(c, here, e);
  }
});

inbox.post('/posts/:id/merge', async (c) => {
  needRole(c, 'member');
  const { ctx, id, here } = await postOrThrow(c);
  const b = await c.req.parseBody();
  try {
    const target = await mergePosts(ctx, id, str(b, 'into'));
    return done(c, `${A}/posts/${target.id}`, 'Posts merged.');
  } catch (e) {
    return fail(c, here, e);
  }
});

// Held comments.
for (const act of ['approve', 'reject', 'delete'] as const) {
  inbox.post(`/comments/:id/${act}`, async (c) => {
    needRole(c, 'member');
    const a = await loadAdmin(c);
    const back = c.req.query('back') ? `${A}/posts/${c.req.query('back')!.replace(/[^a-z0-9_]/gi, '')}` : `${A}?view=comments`;
    try {
      const id = c.req.param('id');
      if (act === 'approve') await approveComment(a.ctx, id);
      else if (act === 'reject') await rejectComment(a.ctx, id);
      else await deleteComment(a.ctx, id);
      return done(c, back, act === 'approve' ? 'Comment approved.' : act === 'reject' ? 'Comment rejected.' : 'Comment deleted.');
    } catch (e) {
      return fail(c, back, e);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Roadmap overview for the team
// ---------------------------------------------------------------------------------------------

inbox.get('/roadmap', async (c) => {
  const a = await loadAdmin(c);
  if (!a.portal) return c.redirect(A);
  const lanes = (await listStatuses(a.ctx)).filter((s) => s.in_roadmap === 1);
  const filled = await Promise.all(lanes.map(async (s) => ({ s, page: await listPosts(a.ctx, { statusId: s.id, sort: 'top', limit: 20 }) })));
  const any = filled.some((l) => l.page.items.length);
  return renderPage(c, { title: 'Roadmap', crumbs: [{ label: 'Feedback', href: A }, { label: 'Roadmap' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader
        title="Roadmap"
        description={a.portal.roadmap_on ? 'Built from your statuses. A status shows here when "Show in roadmap" is on.' : 'The public roadmap is off. Turn it on in settings.'}
        actions={
          a.portal.roadmap_on ? (
            <LinkButton href={`/roadmap/${a.portal.slug}`} icon="globe" target="_blank" rel="noopener">
              View public roadmap
            </LinkButton>
          ) : (
            <LinkButton href={`${A}/settings`}>Open settings</LinkButton>
          )
        }
      />
      {!any ? (
        <EmptyState icon="flag" title="Nothing on the roadmap" body="Move a post to a status that shows in the roadmap, like Planned or In progress." actions={<LinkButton href={A} variant="primary">Go to the inbox</LinkButton>} />
      ) : (
        <div class="fb-admin-lanes">
          {filled.map(({ s, page }) => (
            <Card title={`${s.name} (${page.items.length}${page.nextCursor ? '+' : ''})`}>
              {page.items.length === 0 ? <p class="hint">Nothing here.</p> : null}
              <ul class="fb-admin-list">
                {page.items.map((p) => (
                  <li>
                    <a href={`${A}/posts/${p.id}`}>{p.title}</a> <span class="hint">{plural(p.vote_count, 'vote')}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  ));
});

