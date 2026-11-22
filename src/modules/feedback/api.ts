/** REST API at /api/v1/feedback. Scopes: feedback:read, feedback:write. Lists return { items, nextCursor }. */
import { Hono, type Context } from 'hono';
import { orgDb } from '../../core/db';
import { errors, readJson } from '../../core/errors';
import { requireScope } from '../../core/guards';
import type { AppEnv } from '../../env';
import { subscriberCounts, listSubscribers, createEntry, deleteEntry, entryLabels, getEntry, linkedPostIds, listEntries, publishEntry, removeSubscriber, updateEntry } from './changelog';
import { fbErrors } from './errors';
import { importPosts, previewCsv, postsCsv, exportAll } from './exportimport';
import { listPeople, setBlocked, setTrusted } from './people';
import { createBoard, createCategory, ensurePortal, createStatus, createTag, deleteBoard, deleteCategory, deleteStatus, deleteTag, getPortal, listBoards, listCategories, listStatuses, listTags, updateBoard, updatePortal, updateStatus, updateTag, type Ctx } from './portal';
import {
  addNote, addStaffComment, addVoteFor, approveComment, approvePost, changeStatus, deleteComment, deletePost, getPostView, insertPost, listComments, listNotes, listPosts, listVoters,
  mergePosts, mergePreview, pendingComments, postTags, rejectComment, rejectPost, setPostTags, similarPosts, updatePost, type Actor, type Sort,
} from './posts';
import { computeStats } from './stats';
import { createGuest, upsertEmailPerson } from './people';
import { clamp, decodeCursor, encodeCursor } from './util';
import type { Board, Person, Post } from './types';

const read = requireScope('feedback:read');
const write = requireScope('feedback:write');

export function apiCtx(c: Context<AppEnv>): Ctx {
  const org = c.get('org')!;
  return { env: c.env, orgId: org.id, db: orgDb(c.env.DB, org.id), origin: new URL(c.req.url).origin };
}

export function actorOf(c: Context<AppEnv>): Actor {
  const u = c.get('user');
  return u ? { id: u.id, name: u.name || u.email } : { id: null, name: 'API key' };
}

function str(v: unknown, max = 5000): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function page<T>(items: T[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

function offsetPage<T>(rows: T[], offset: number, limit: number) {
  const more = rows.length > limit;
  return page(more ? rows.slice(0, limit) : rows, more ? encodeCursor([offset + limit]) : null);
}

async function needPortal(ctx: Ctx) {
  const portal = await getPortal(ctx);
  if (!portal) throw fbErrors.portal_missing();
  return portal;
}

async function boardOf(ctx: Ctx, id: unknown): Promise<Board> {
  const boards = await listBoards(ctx);
  const b = typeof id === 'string' ? boards.find((x) => x.id === id || x.slug === id) : boards[0];
  if (!b) throw fbErrors.board_missing();
  return b;
}

export function buildApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  // Portal
  api.get('/portal', read, async (c) => c.json(await needPortal(apiCtx(c))));
  api.put('/portal', write, async (c) => c.json(await updatePortal(apiCtx(c), await readJson(c))));
  api.post('/portal', write, async (c) => c.json(await ensurePortal(apiCtx(c), c.get('org')!.name), 201));

  // Boards, categories
  api.get('/boards', read, async (c) => c.json(page(await listBoards(apiCtx(c)))));
  api.post('/boards', write, async (c) => c.json(await createBoard(apiCtx(c), (await readJson(c)) as never), 201));
  api.put('/boards/:id', write, async (c) => c.json(await updateBoard(apiCtx(c), c.req.param('id'), (await readJson(c)) as never)));
  api.delete('/boards/:id', write, async (c) => (await deleteBoard(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.get('/categories', read, async (c) => c.json(page(await listCategories(apiCtx(c), c.req.query('board') || undefined))));
  api.post('/categories', write, async (c) => {
    const b = await readJson(c);
    return c.json(await createCategory(apiCtx(c), String(b.board_id ?? ''), String(b.name ?? '')), 201);
  });
  api.delete('/categories/:id', write, async (c) => (await deleteCategory(apiCtx(c), c.req.param('id')), c.json({ ok: true })));

  // Statuses and tags
  api.get('/statuses', read, async (c) => c.json(page(await listStatuses(apiCtx(c)))));
  api.post('/statuses', write, async (c) => c.json(await createStatus(apiCtx(c), (await readJson(c)) as never), 201));
  api.put('/statuses/:id', write, async (c) => c.json(await updateStatus(apiCtx(c), c.req.param('id'), (await readJson(c)) as never)));
  api.delete('/statuses/:id', write, async (c) => (await deleteStatus(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.get('/tags', read, async (c) => c.json(page(await listTags(apiCtx(c)))));
  api.post('/tags', write, async (c) => c.json(await createTag(apiCtx(c), (await readJson(c)) as never), 201));
  api.put('/tags/:id', write, async (c) => c.json(await updateTag(apiCtx(c), c.req.param('id'), (await readJson(c)) as never)));
  api.delete('/tags/:id', write, async (c) => (await deleteTag(apiCtx(c), c.req.param('id')), c.json({ ok: true })));

  // Posts
  api.get('/posts', read, async (c) => {
    const ctx = apiCtx(c);
    const q = c.req.query();
    const res = await listPosts(ctx, {
      boardId: q.board || undefined,
      statusId: q.status || undefined,
      tagId: q.tag || undefined,
      assignee: q.assignee || undefined,
      review: (q.review as never) || 'published',
      sort: (['top', 'new', 'trending'].includes(q.sort ?? '') ? q.sort : 'new') as Sort,
      q: q.q || undefined,
      cursor: q.cursor || null,
      limit: clamp(Number(q.limit) || 20, 1, 100),
    });
    return c.json({ items: res.items, nextCursor: res.nextCursor });
  });
  api.get('/posts/similar', read, async (c) => c.json(page(await similarPosts(apiCtx(c), c.req.query('q') ?? '', { limit: 5 }))));
  api.post('/posts', write, async (c) => {
    const ctx = apiCtx(c);
    const b = await readJson(c);
    const board = await boardOf(ctx, b.board);
    const title = str(b.title, 300) ?? '';
    if (!title.trim()) throw errors.bad_request('A post needs a title.', { title: 'Required' });
    let authorId: string | null = null;
    if (typeof b.author_email === 'string' && b.author_email) {
      const p = await upsertEmailPerson(ctx, b.author_email, { name: str(b.author_name, 100), source: 'api', verified: false });
      authorId = p.id;
    } else if (typeof b.author_name === 'string' && b.author_name) {
      authorId = (await createGuest(ctx, c.req.raw, b.author_name)).id;
    }
    const post = await insertPost(ctx, { board, title, body: str(b.body), authorId, createdBy: actorOf(c).id, categoryId: str(b.category_id) ?? null, statusId: str(b.status_id) ?? null, source: 'api', autoVote: !!authorId });
    return c.json(await getPostView(ctx, post.id), 201);
  });
  api.get('/posts/:id', read, async (c) => {
    const ctx = apiCtx(c);
    const post = await getPostView(ctx, c.req.param('id'));
    if (!post) throw fbErrors.post_missing();
    const tags = (await postTags(ctx, [post.id])).get(post.id) ?? [];
    return c.json({ ...post, tags });
  });
  api.put('/posts/:id', write, async (c) => {
    const ctx = apiCtx(c);
    const b = await readJson(c);
    const id = c.req.param('id');
    const patch: Record<string, string | null | undefined> = { title: str(b.title, 300), body: str(b.body), board_id: str(b.board_id), assignee: b.assignee === null ? null : str(b.assignee, 100), decline_reason: b.decline_reason === null ? null : str(b.decline_reason, 1000) };
    if ('category_id' in b) patch.category_id = (b.category_id as string | null) ?? null;
    let post: Post = await updatePost(ctx, id, patch);
    if (typeof b.status_id === 'string') post = await changeStatus(ctx, id, b.status_id, actorOf(c), { reason: str(b.decline_reason, 1000), silent: b.silent === true });
    if (Array.isArray(b.tag_ids)) await setPostTags(ctx, id, b.tag_ids.filter((t): t is string => typeof t === 'string'));
    return c.json(await getPostView(ctx, post.id));
  });
  api.delete('/posts/:id', write, async (c) => (await deletePost(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.post('/posts/:id/approve', write, async (c) => c.json(await approvePost(apiCtx(c), c.req.param('id'))));
  api.post('/posts/:id/reject', write, async (c) => c.json(await rejectPost(apiCtx(c), c.req.param('id'))));
  api.get('/posts/:id/merge-preview/:target', read, async (c) => c.json(await mergePreview(apiCtx(c), c.req.param('id'), c.req.param('target'))));
  api.post('/posts/:id/merge', write, async (c) => {
    const b = await readJson(c);
    return c.json(await mergePosts(apiCtx(c), c.req.param('id'), String(b.into ?? '')));
  });
  api.get('/posts/:id/comments', read, async (c) => c.json(page(await listComments(apiCtx(c), c.req.param('id'), { includeHeld: true }))));
  api.post('/posts/:id/comments', write, async (c) => {
    const b = await readJson(c);
    return c.json(await addStaffComment(apiCtx(c), c.req.param('id'), actorOf(c), str(b.body, 3000) ?? '', { notify: b.notify !== false }), 201);
  });
  api.delete('/comments/:id', write, async (c) => (await deleteComment(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.post('/comments/:id/approve', write, async (c) => (await approveComment(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.post('/comments/:id/reject', write, async (c) => (await rejectComment(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.get('/comments/pending', read, async (c) => c.json(page(await pendingComments(apiCtx(c)))));
  api.get('/posts/:id/notes', read, async (c) => c.json(page(await listNotes(apiCtx(c), c.req.param('id')))));
  api.post('/posts/:id/notes', write, async (c) => c.json(await addNote(apiCtx(c), c.req.param('id'), actorOf(c), str((await readJson(c)).body, 3000) ?? ''), 201));
  api.get('/posts/:id/votes', read, async (c) => c.json(page(await listVoters(apiCtx(c), c.req.param('id'), 200))));
  api.post('/posts/:id/votes', write, async (c) => {
    const ctx = apiCtx(c);
    const b = await readJson(c);
    let person: Person | null = null;
    if (typeof b.email === 'string' && b.email) person = await upsertEmailPerson(ctx, b.email, { name: str(b.name, 100), source: 'api', verified: false });
    if (!person) throw errors.bad_request('Send the voter email.', { email: 'Required' });
    return c.json(await addVoteFor(ctx, c.req.param('id'), person.id), 201);
  });

  // People
  api.get('/people', read, async (c) => {
    const offset = Number(decodeCursor(c.req.query('cursor'))?.[0]) || 0;
    const limit = clamp(Number(c.req.query('limit')) || 50, 1, 200);
    const rows = await listPeople(apiCtx(c), { q: c.req.query('q') || undefined, filter: (c.req.query('filter') as never) || undefined, limit: limit + 1, offset });
    return c.json(offsetPage(rows, offset, limit));
  });
  api.post('/people/:id/block', write, async (c) => c.json(await setBlocked(apiCtx(c), c.req.param('id'), true)));
  api.post('/people/:id/unblock', write, async (c) => c.json(await setBlocked(apiCtx(c), c.req.param('id'), false)));
  api.post('/people/:id/trust', write, async (c) => c.json(await setTrusted(apiCtx(c), c.req.param('id'), true)));
  api.post('/people/:id/untrust', write, async (c) => c.json(await setTrusted(apiCtx(c), c.req.param('id'), false)));

  // Changelog
  api.get('/entries', read, async (c) => {
    const ctx = apiCtx(c);
    const res = await listEntries(ctx, { state: (c.req.query('state') as never) || 'all', cursor: c.req.query('cursor') || null, limit: clamp(Number(c.req.query('limit')) || 20, 1, 100) });
    return c.json({ items: res.items.map((e) => ({ ...e, labels: entryLabels(e) })), nextCursor: res.nextCursor });
  });
  api.post('/entries', write, async (c) => c.json(await createEntry(apiCtx(c), (await readJson(c)) as never, actorOf(c)), 201));
  api.get('/entries/:id', read, async (c) => {
    const ctx = apiCtx(c);
    const e = await getEntry(ctx, c.req.param('id'));
    if (!e) throw fbErrors.entry_missing();
    return c.json({ ...e, labels: entryLabels(e), post_ids: await linkedPostIds(ctx, e.id) });
  });
  api.put('/entries/:id', write, async (c) => c.json(await updateEntry(apiCtx(c), c.req.param('id'), (await readJson(c)) as never)));
  api.delete('/entries/:id', write, async (c) => (await deleteEntry(apiCtx(c), c.req.param('id')), c.json({ ok: true })));
  api.post('/entries/:id/publish', write, async (c) => c.json(await publishEntry(apiCtx(c), c.req.param('id'), actorOf(c))));
  api.get('/subscribers', read, async (c) => {
    const ctx = apiCtx(c);
    const offset = Number(decodeCursor(c.req.query('cursor'))?.[0]) || 0;
    const limit = clamp(Number(c.req.query('limit')) || 50, 1, 200);
    const rows = await listSubscribers(ctx, { status: c.req.query('status') || undefined, limit: limit + 1, offset });
    return c.json({ ...offsetPage(rows, offset, limit), counts: await subscriberCounts(ctx) });
  });
  api.delete('/subscribers/:id', write, async (c) => (await removeSubscriber(apiCtx(c), c.req.param('id')), c.json({ ok: true })));

  // Stats, export, import
  api.get('/stats', read, async (c) => c.json(await computeStats(apiCtx(c), clamp(Number(c.req.query('days')) || 30, 7, 365))));
  api.get('/export', read, async (c) => {
    const ctx = apiCtx(c);
    if (c.req.query('format') === 'csv') return new Response(await postsCsv(ctx), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="feedback-posts.csv"' } });
    return c.json(await exportAll(ctx));
  });
  api.post('/import', write, async (c) => {
    const ctx = apiCtx(c);
    const b = await readJson(c);
    const text = str(b.csv, 5_000_000) ?? '';
    if (!text.trim()) throw fbErrors.import_invalid('Send the CSV text in the csv field.');
    if (!b.mapping) return c.json(previewCsv(text));
    return c.json(await importPosts(ctx, text, b.mapping as never, Number(b.offset) || 0));
  });
  return api;
}
