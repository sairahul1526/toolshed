/** Posts, votes, comments, merging, notes and the triage queue. */
import { newId } from '../../core/db';
import { fbErrors } from './errors';
import { emitFb, nextMilestone } from './events';
import { mailExcerpt, queueNotice } from './notify';
import type { Ctx } from './portal';
import { initialStatus } from './portal';
import { heldMessage, holdReason, type HeldReason } from './spam';
import type { Board, Comment, Note, Page, Person, Post, Review, Status } from './types';
import { clamp, decodeCursor, encodeCursor, likeEscape, randomSuffix, slugify, titleWords } from './util';

export type Sort = 'top' | 'new' | 'trending';

export interface PostView extends Post {
  author_name: string | null;
  author_email: string | null;
  author_verified: number | null;
  status_name: string | null;
  status_tone: string | null;
  status_kind: string | null;
  status_roadmap: number | null;
  board_slug: string;
  board_name: string;
  board_visibility: string;
  board_hide_votes: number;
  category_name: string | null;
}

const SELECT = `SELECT p.*, pe.name AS author_name, pe.email AS author_email, pe.verified AS author_verified,
  s.name AS status_name, s.tone AS status_tone, s.kind AS status_kind, s.in_roadmap AS status_roadmap,
  b.slug AS board_slug, b.name AS board_name, b.visibility AS board_visibility, b.hide_votes AS board_hide_votes, c.name AS category_name
  FROM fb_posts p
  LEFT JOIN fb_people pe ON pe.id = p.author_id
  LEFT JOIN fb_statuses s ON s.id = p.status_id
  JOIN fb_boards b ON b.id = p.board_id
  LEFT JOIN fb_categories c ON c.id = p.category_id`;

export const TITLE_MAX = 140;
export const BODY_MAX = 5000;
export const COMMENT_MAX = 3000;

export interface ListOpts {
  boardId?: string;
  statusId?: string;
  tagId?: string;
  categoryId?: string;
  assignee?: string;
  authorId?: string;
  review?: Review | 'all';
  sort?: Sort;
  q?: string;
  cursor?: string | null;
  limit?: number;
  /** Public pages: only public boards. */
  publicOnly?: boolean;
  /** Triage: published posts still in the starting status with no staff reply. */
  needsReply?: boolean;
  /** Only posts in these status kinds. */
  roadmapOnly?: boolean;
}

export async function listPosts(ctx: Ctx, opts: ListOpts = {}): Promise<Page<PostView>> {
  const limit = clamp(opts.limit ?? 20, 1, 100);
  const sort: Sort = opts.sort ?? 'top';
  const where: string[] = ['p.org_id = :org'];
  const params: (string | number)[] = [];
  const review = opts.review ?? 'published';
  if (review !== 'all') {
    where.push('p.review = ?');
    params.push(review);
  }
  if (opts.boardId) (where.push('p.board_id = ?'), params.push(opts.boardId));
  if (opts.statusId) (where.push('p.status_id = ?'), params.push(opts.statusId));
  if (opts.categoryId) (where.push('p.category_id = ?'), params.push(opts.categoryId));
  if (opts.assignee) (where.push('p.assignee = ?'), params.push(opts.assignee));
  if (opts.authorId) (where.push('p.author_id = ?'), params.push(opts.authorId));
  if (opts.tagId) (where.push('p.id IN (SELECT post_id FROM fb_post_tags WHERE org_id = p.org_id AND tag_id = ?)'), params.push(opts.tagId));
  if (opts.publicOnly) where.push("b.visibility = 'public'");
  if (opts.roadmapOnly) where.push('s.in_roadmap = 1');
  if (opts.needsReply) where.push('s.is_initial = 1 AND p.first_reply_at IS NULL');
  if (opts.q && opts.q.trim()) {
    const words = titleWords(opts.q, 5);
    const terms = words.length ? words : [opts.q.trim().slice(0, 60).toLowerCase()];
    const parts = terms.map(() => "(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')");
    where.push(`(${parts.join(' AND ')})`);
    for (const t of terms) {
      const like = `%${likeEscape(t)}%`;
      params.push(like, like);
    }
  }
  const cur = decodeCursor(opts.cursor);
  let order: string;
  if (sort === 'new') {
    order = 'p.id DESC';
    if (cur && typeof cur[0] === 'string') (where.push('p.id < ?'), params.push(cur[0]));
  } else {
    const col = sort === 'top' ? 'p.vote_count' : 'p.trend';
    order = `${col} DESC, p.id DESC`;
    if (cur && typeof cur[0] === 'number' && typeof cur[1] === 'string') {
      where.push(`(${col} < ? OR (${col} = ? AND p.id < ?))`);
      params.push(cur[0], cur[0], cur[1]);
    }
  }
  const rows = await ctx.db.all<PostView>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...params, limit + 1);
  const items = rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = items[items.length - 1]!;
    nextCursor = encodeCursor(sort === 'new' ? [last.id] : [sort === 'top' ? last.vote_count : last.trend, last.id]);
  }
  return { items, nextCursor };
}

export async function getPostView(ctx: Ctx, id: string): Promise<PostView | null> {
  return ctx.db.first<PostView>(`${SELECT} WHERE p.org_id = :org AND p.id = ?`, id);
}

export async function postBySlug(ctx: Ctx, slug: string): Promise<PostView | null> {
  return ctx.db.first<PostView>(`${SELECT} WHERE p.org_id = :org AND p.slug = ?`, slug);
}

/** Which of these posts has this person voted for? */
export async function votedSet(ctx: Ctx, personId: string | null | undefined, postIds: string[]): Promise<Set<string>> {
  if (!personId || postIds.length === 0) return new Set();
  const rows = await ctx.db.all<{ post_id: string }>(
    `SELECT post_id FROM fb_votes WHERE org_id = :org AND person_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
    personId,
    ...postIds,
  );
  return new Set(rows.map((r) => r.post_id));
}

export async function postTags(ctx: Ctx, postIds: string[]): Promise<Map<string, { id: string; name: string; is_public: number }[]>> {
  const out = new Map<string, { id: string; name: string; is_public: number }[]>();
  if (postIds.length === 0) return out;
  const rows = await ctx.db.all<{ post_id: string; id: string; name: string; is_public: number }>(
    `SELECT pt.post_id, t.id, t.name, t.is_public FROM fb_post_tags pt JOIN fb_tags t ON t.id = pt.tag_id WHERE pt.org_id = :org AND pt.post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY t.name`,
    ...postIds,
  );
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push({ id: r.id, name: r.name, is_public: r.is_public });
    out.set(r.post_id, list);
  }
  return out;
}

export async function setPostTags(ctx: Ctx, postId: string, tagIds: string[]): Promise<void> {
  const valid = tagIds.length
    ? await ctx.db.all<{ id: string }>(`SELECT id FROM fb_tags WHERE org_id = :org AND id IN (${tagIds.map(() => '?').join(',')})`, ...tagIds)
    : [];
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM fb_post_tags WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, postId),
    ...valid.map((t) => ctx.env.DB.prepare('INSERT INTO fb_post_tags (org_id, post_id, tag_id) VALUES (?1, ?2, ?3)').bind(ctx.orgId, postId, t.id)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Creating posts
// ---------------------------------------------------------------------------------------------

export interface NewPost {
  board: Board;
  title: string;
  body?: string;
  authorId?: string | null;
  createdBy?: string | null;
  categoryId?: string | null;
  statusId?: string | null;
  review?: Review;
  heldReason?: HeldReason;
  source?: string;
  createdAt?: number;
  sample?: boolean;
  /** The author's own vote is added so every post starts at one. */
  autoVote?: boolean;
}

export function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length < 3) throw fbErrors.post_missing('Give the post a title of at least 3 characters.');
  if (t.length > TITLE_MAX) throw fbErrors.post_missing(`Keep the title under ${TITLE_MAX} characters.`);
  return t;
}

export function cleanBody(body: string | undefined, max = BODY_MAX): string {
  const b = (body ?? '').replace(/\r\n/g, '\n').trim();
  if (b.length > max) throw fbErrors.post_missing(`Keep it under ${max} characters.`);
  return b;
}

async function freeSlug(ctx: Ctx, title: string): Promise<string> {
  const base = slugify(title, 50, 'post');
  for (let i = 0; i < 6; i++) {
    const slug = i === 0 ? base : `${base}-${randomSuffix(4)}`;
    if (!(await ctx.db.findOne('fb_posts', { slug }))) return slug;
  }
  return `${base}-${randomSuffix(8)}`;
}

/** Insert a post with no spam checks. The portal, the API, import and sample data all go through this. */
export async function insertPost(ctx: Ctx, input: NewPost): Promise<Post> {
  const now = input.createdAt ?? Date.now();
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body);
  const status = input.statusId ? input.statusId : (await initialStatus(ctx))?.id ?? null;
  const review: Review = input.review ?? 'published';
  const slug = await freeSlug(ctx, title);
  const id = newId('fbq', now);
  const stmts = [
    ctx.env.DB.prepare(
      `INSERT INTO fb_posts (id, org_id, board_id, slug, title, body, author_id, created_by, category_id, status_id, review, held_reason, source, vote_count, comment_count, trend, voted_milestone, status_changed_at, sample, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, 0, 0, ?14, ?15, ?14, ?14)`,
    ).bind(id, ctx.orgId, input.board.id, slug, title, body, input.authorId ?? null, input.createdBy ?? null, input.categoryId ?? null, status, review, input.heldReason ?? null, input.source ?? 'portal', now, input.sample ? 1 : 0),
  ];
  if (input.autoVote !== false && input.authorId) {
    stmts.push(ctx.env.DB.prepare(`INSERT OR IGNORE INTO fb_votes (org_id, post_id, person_id, source, created_at) VALUES (?1, ?2, ?3, 'author', ?4)`).bind(ctx.orgId, id, input.authorId, now));
  }
  await ctx.env.DB.batch(stmts);
  const post = (await ctx.db.get<Post>('fb_posts', id))!;
  if (review === 'published') await publishedEffects(ctx, post);
  return post;
}

async function publishedEffects(ctx: Ctx, post: Post): Promise<void> {
  await emitFb(ctx.env, ctx.orgId, 'post.created', post.id, { title: post.title, board: post.board_id, source: post.source });
}

export interface Submission {
  post: Post | null;
  held: HeldReason;
  message: string;
  spam: boolean;
}

/** A visitor's post, with the board and person rules applied. Rate limits and form checks run before this. */
export async function submitPost(ctx: Ctx, input: { board: Board; person: Person; title: string; body?: string; categoryId?: string | null; source?: string }): Promise<Submission> {
  const { board, person } = input;
  if (!board.posting_on) throw fbErrors.posting_off();
  if (person.blocked) throw fbErrors.blocked();
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body);
  const held = holdReason(person, board, `${title}\n${body}`);
  const cat = input.categoryId ? await ctx.db.get<{ board_id: string }>('fb_categories', input.categoryId) : null;
  const post = await insertPost(ctx, {
    board,
    title,
    body,
    authorId: person.id,
    categoryId: cat && cat.board_id === board.id ? input.categoryId : null,
    review: held ? 'pending' : 'published',
    heldReason: held,
    source: input.source ?? 'portal',
  });
  return { post, held, message: held ? heldMessage(held) : '', spam: false };
}

// ---------------------------------------------------------------------------------------------
// Editing, deleting, status
// ---------------------------------------------------------------------------------------------

export interface PostPatch {
  title?: string;
  body?: string;
  board_id?: string;
  category_id?: string | null;
  assignee?: string | null;
  decline_reason?: string | null;
}

export async function updatePost(ctx: Ctx, id: string, patch: PostPatch): Promise<Post> {
  const post = await ctx.db.get<Post>('fb_posts', id);
  if (!post) throw fbErrors.post_missing();
  const data: Record<string, string | number | null> = { updated_at: Date.now() };
  if (patch.title !== undefined) data.title = cleanTitle(patch.title);
  if (patch.body !== undefined) data.body = cleanBody(patch.body);
  if (patch.board_id !== undefined && patch.board_id !== post.board_id) {
    if (!(await ctx.db.get('fb_boards', patch.board_id))) throw fbErrors.board_missing();
    data.board_id = patch.board_id;
    data.category_id = null;
  }
  if (patch.category_id !== undefined && data.board_id === undefined) data.category_id = patch.category_id || null;
  if (patch.assignee !== undefined) data.assignee = patch.assignee || null;
  if (patch.decline_reason !== undefined) data.decline_reason = patch.decline_reason ? patch.decline_reason.trim().slice(0, 1000) : null;
  return (await ctx.db.update<Post>('fb_posts', id, data))!;
}

export async function deletePost(ctx: Ctx, id: string): Promise<void> {
  const post = await ctx.db.get<Post>('fb_posts', id);
  if (!post) throw fbErrors.post_missing();
  const q = (table: string, col = 'post_id') => ctx.env.DB.prepare(`DELETE FROM ${table} WHERE org_id = ?1 AND ${col} = ?2`).bind(ctx.orgId, id);
  await ctx.env.DB.batch([q('fb_votes'), q('fb_comments'), q('fb_notes'), q('fb_post_tags'), q('fb_entry_posts'), q('fb_status_log'), q('fb_posts', 'id')]);
}

export interface Actor {
  id: string | null;
  name: string;
}

/** Change a post's status, record it, tell the people who follow it and emit the event. */
export async function changeStatus(ctx: Ctx, postId: string, statusId: string, actor: Actor, opts: { reason?: string; silent?: boolean } = {}): Promise<Post> {
  const post = await ctx.db.get<Post>('fb_posts', postId);
  if (!post) throw fbErrors.post_missing();
  const status = await ctx.db.get<Status>('fb_statuses', statusId);
  if (!status) throw fbErrors.status_missing();
  if (post.status_id === statusId && !opts.reason) return post;
  const now = Date.now();
  const reason = status.kind === 'closed' ? (opts.reason ?? post.decline_reason ?? null) : null;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE fb_posts SET status_id = ?3, status_changed_at = ?4, updated_at = ?4, decline_reason = ?5 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, postId, statusId, now, reason),
    ctx.env.DB.prepare('INSERT INTO fb_status_log (id, org_id, post_id, from_status, to_status, actor, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(newId('fbl', now), ctx.orgId, postId, post.status_id, statusId, actor.id ?? actor.name, now),
  ]);
  const changed = (await ctx.db.get<Post>('fb_posts', postId))!;
  if (post.review === 'published') {
    await emitFb(ctx.env, ctx.orgId, 'post.status_changed', postId, { from: post.status_id, to: statusId, status: status.name, kind: status.kind });
    if (!opts.silent) {
      await queueNotice(ctx.env, ctx.orgId, {
        kind: status.kind === 'closed' && reason ? 'declined' : 'status',
        postId,
        payload: { status: status.name, reason },
        origin: ctx.origin,
      });
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------------------------

export interface VoteResult {
  voted: boolean;
  count: number;
}

export async function activeVotes(ctx: Ctx, personId: string): Promise<number> {
  const row = await ctx.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM fb_votes v JOIN fb_posts p ON p.id = v.post_id LEFT JOIN fb_statuses s ON s.id = p.status_id
      WHERE v.org_id = :org AND v.person_id = ? AND p.review = 'published' AND COALESCE(s.kind, 'open') IN ('open', 'active')`,
    personId,
  );
  return row?.n ?? 0;
}

/** Toggle a person's vote. One vote per person per post is enforced by a unique index. */
export async function toggleVote(ctx: Ctx, post: Post, board: Board, person: Person, voteLimit: number): Promise<VoteResult> {
  if (person.blocked) throw fbErrors.blocked();
  if (post.review !== 'published') throw fbErrors.post_missing();
  if (!board.voting_on) throw fbErrors.voting_off();
  const existing = await ctx.db.findOne('fb_votes', { post_id: post.id, person_id: person.id });
  if (existing) {
    await ctx.env.DB.prepare('DELETE FROM fb_votes WHERE org_id = ?1 AND post_id = ?2 AND person_id = ?3').bind(ctx.orgId, post.id, person.id).run();
    const fresh = await ctx.db.get<Post>('fb_posts', post.id);
    return { voted: false, count: fresh?.vote_count ?? 0 };
  }
  if (voteLimit > 0 && (await activeVotes(ctx, person.id)) >= voteLimit) throw fbErrors.vote_limit(`You can vote on ${voteLimit} open ideas at a time. Remove a vote to use it somewhere else.`);
  await ctx.env.DB.prepare(`INSERT OR IGNORE INTO fb_votes (org_id, post_id, person_id, source, created_at) VALUES (?1, ?2, ?3, 'portal', ?4)`).bind(ctx.orgId, post.id, person.id, Date.now()).run();
  const fresh = (await ctx.db.get<Post>('fb_posts', post.id))!;
  await milestone(ctx, fresh);
  return { voted: true, count: fresh.vote_count };
}

async function milestone(ctx: Ctx, post: Post): Promise<void> {
  const hit = nextMilestone(post.vote_count, post.voted_milestone);
  if (hit === null) return;
  const res = await ctx.db.run('UPDATE fb_posts SET voted_milestone = ? WHERE org_id = :org AND id = ? AND voted_milestone < ?', hit, post.id, hit);
  if (res.changes > 0) await emitFb(ctx.env, ctx.orgId, 'post.voted', post.id, { votes: post.vote_count, milestone: hit, title: post.title });
}

/** Admin or API: add a vote for someone, for example a customer who asked on a call. */
export async function addVoteFor(ctx: Ctx, postId: string, personId: string): Promise<Post> {
  const post = await ctx.db.get<Post>('fb_posts', postId);
  if (!post) throw fbErrors.post_missing();
  await ctx.env.DB.prepare(`INSERT OR IGNORE INTO fb_votes (org_id, post_id, person_id, source, created_at) VALUES (?1, ?2, ?3, 'admin', ?4)`).bind(ctx.orgId, postId, personId, Date.now()).run();
  const fresh = (await ctx.db.get<Post>('fb_posts', postId))!;
  await milestone(ctx, fresh);
  return fresh;
}

export async function listVoters(ctx: Ctx, postId: string, limit = 50): Promise<{ id: string; name: string; email: string | null; created_at: number }[]> {
  return ctx.db.all(
    `SELECT pe.id, pe.name, pe.email, v.created_at FROM fb_votes v JOIN fb_people pe ON pe.id = v.person_id WHERE v.org_id = :org AND v.post_id = ? ORDER BY v.created_at DESC LIMIT ?`,
    postId,
    limit,
  );
}

// ---------------------------------------------------------------------------------------------
// Comments and notes
// ---------------------------------------------------------------------------------------------

export interface CommentView extends Comment {
  author_name: string | null;
  author_verified: number | null;
}

export async function listComments(ctx: Ctx, postId: string, opts: { includeHeld?: boolean } = {}): Promise<CommentView[]> {
  return ctx.db.all<CommentView>(
    `SELECT c.*, pe.name AS author_name, pe.verified AS author_verified FROM fb_comments c LEFT JOIN fb_people pe ON pe.id = c.author_id
      WHERE c.org_id = :org AND c.post_id = ? ${opts.includeHeld ? "AND c.review <> 'rejected'" : "AND c.review = 'published'"} ORDER BY c.created_at ASC LIMIT 500`,
    postId,
  );
}

export async function addVisitorComment(ctx: Ctx, post: Post, board: Board, person: Person, bodyInput: string): Promise<{ comment: Comment; held: HeldReason }> {
  if (person.blocked) throw fbErrors.blocked();
  if (post.review !== 'published') throw fbErrors.post_missing();
  const body = cleanBody(bodyInput, COMMENT_MAX);
  if (body.length < 1) throw fbErrors.post_missing('Write a comment first.');
  const held = holdReason(person, board, body);
  const now = Date.now();
  const comment = await ctx.db.insert<Comment>('fb_comments', {
    id: newId('fbm', now),
    post_id: post.id,
    author_id: person.id,
    staff_user: null,
    staff_name: null,
    body,
    review: held ? 'pending' : 'published',
    sample: 0,
    created_at: now,
  });
  if (!held) await emitFb(ctx.env, ctx.orgId, 'comment.created', comment.id, { post: post.id, staff: false });
  return { comment, held };
}

/** A reply from the team. Sets the first-reply time and emails the people who follow the post. */
export async function addStaffComment(ctx: Ctx, postId: string, actor: Actor, bodyInput: string, opts: { notify?: boolean } = {}): Promise<Comment> {
  const post = await ctx.db.get<Post>('fb_posts', postId);
  if (!post) throw fbErrors.post_missing();
  const body = cleanBody(bodyInput, COMMENT_MAX);
  if (!body) throw fbErrors.post_missing('Write a reply first.');
  const now = Date.now();
  const comment = await ctx.db.insert<Comment>('fb_comments', {
    id: newId('fbm', now),
    post_id: postId,
    author_id: null,
    staff_user: actor.id,
    staff_name: actor.name,
    body,
    review: 'published',
    sample: 0,
    created_at: now,
  });
  if (post.first_reply_at === null) await ctx.db.run('UPDATE fb_posts SET first_reply_at = ? WHERE org_id = :org AND id = ?', now, postId);
  await emitFb(ctx.env, ctx.orgId, 'comment.created', comment.id, { post: postId, staff: true });
  if (opts.notify !== false && post.review === 'published') {
    await queueNotice(ctx.env, ctx.orgId, { kind: 'reply', postId, payload: { who: actor.name || 'The team', excerpt: mailExcerpt(body) }, origin: ctx.origin });
  }
  return comment;
}

export async function deleteComment(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.remove('fb_comments', id);
}

export async function listNotes(ctx: Ctx, postId: string): Promise<Note[]> {
  return ctx.db.list<Note>('fb_notes', { where: { post_id: postId }, orderBy: 'created_at ASC', limit: 200 });
}

export async function addNote(ctx: Ctx, postId: string, actor: Actor, body: string): Promise<Note> {
  if (!(await ctx.db.get('fb_posts', postId))) throw fbErrors.post_missing();
  const text = cleanBody(body, 2000);
  if (!text) throw fbErrors.post_missing('Write a note first.');
  return ctx.db.insert<Note>('fb_notes', { id: newId('fbn'), post_id: postId, user_id: actor.id, user_name: actor.name, body: text, created_at: Date.now() });
}

// ---------------------------------------------------------------------------------------------
// Triage: approve, reject, merge, similar posts
// ---------------------------------------------------------------------------------------------

export async function approvePost(ctx: Ctx, id: string): Promise<Post> {
  const post = await ctx.db.get<Post>('fb_posts', id);
  if (!post) throw fbErrors.post_missing();
  if (post.review === 'published') return post;
  if (post.review === 'merged') throw fbErrors.merge_invalid();
  const row = (await ctx.db.update<Post>('fb_posts', id, { review: 'published', held_reason: null, updated_at: Date.now() }))!;
  await publishedEffects(ctx, row);
  return row;
}

export async function rejectPost(ctx: Ctx, id: string): Promise<Post> {
  const row = await ctx.db.update<Post>('fb_posts', id, { review: 'rejected', updated_at: Date.now() });
  if (!row) throw fbErrors.post_missing();
  return row;
}

export async function approveComment(ctx: Ctx, id: string): Promise<void> {
  const c = await ctx.db.get<Comment>('fb_comments', id);
  if (!c) throw fbErrors.post_missing('We couldn’t find that comment.');
  await ctx.db.update('fb_comments', id, { review: 'published' });
  await emitFb(ctx.env, ctx.orgId, 'comment.created', id, { post: c.post_id, staff: false });
}

export async function rejectComment(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.update('fb_comments', id, { review: 'rejected' });
}

export async function pendingComments(ctx: Ctx, limit = 50): Promise<(CommentView & { post_title: string; post_slug: string })[]> {
  return ctx.db.all(
    `SELECT c.*, pe.name AS author_name, pe.verified AS author_verified, p.title AS post_title, p.slug AS post_slug
       FROM fb_comments c LEFT JOIN fb_people pe ON pe.id = c.author_id JOIN fb_posts p ON p.id = c.post_id
      WHERE c.org_id = :org AND c.review = 'pending' ORDER BY c.created_at ASC LIMIT ?`,
    limit,
  );
}

export interface InboxCounts {
  pendingPosts: number;
  pendingComments: number;
  needsReply: number;
  total: number;
}

export async function inboxCounts(ctx: Ctx): Promise<InboxCounts> {
  const row = await ctx.db.first<{ pp: number; pc: number; nr: number; total: number }>(
    `SELECT
       (SELECT COUNT(*) FROM fb_posts WHERE org_id = :org AND review = 'pending') AS pp,
       (SELECT COUNT(*) FROM fb_comments WHERE org_id = :org AND review = 'pending') AS pc,
       (SELECT COUNT(*) FROM fb_posts p LEFT JOIN fb_statuses s ON s.id = p.status_id WHERE p.org_id = :org AND p.review = 'published' AND s.is_initial = 1 AND p.first_reply_at IS NULL) AS nr,
       (SELECT COUNT(*) FROM fb_posts WHERE org_id = :org AND review = 'published') AS total`,
  );
  return { pendingPosts: row?.pp ?? 0, pendingComments: row?.pc ?? 0, needsReply: row?.nr ?? 0, total: row?.total ?? 0 };
}

export interface MergePreview {
  source: PostView;
  target: PostView;
  votesMoved: number;
  votesAlready: number;
  commentsMoved: number;
  resultVotes: number;
}

export async function mergePreview(ctx: Ctx, sourceId: string, targetId: string): Promise<MergePreview> {
  if (sourceId === targetId) throw fbErrors.merge_invalid('Pick a different post to merge into.');
  const [source, target] = await Promise.all([getPostView(ctx, sourceId), getPostView(ctx, targetId)]);
  if (!source || !target) throw fbErrors.post_missing();
  if (source.review === 'merged' || target.review === 'merged' || target.review !== 'published') throw fbErrors.merge_invalid();
  const dup = await ctx.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM fb_votes a WHERE a.org_id = :org AND a.post_id = ? AND EXISTS (SELECT 1 FROM fb_votes b WHERE b.post_id = ? AND b.person_id = a.person_id)`,
    sourceId,
    targetId,
  );
  const votesAlready = dup?.n ?? 0;
  const votesMoved = source.vote_count - votesAlready;
  return { source, target, votesMoved, votesAlready, commentsMoved: source.comment_count, resultVotes: target.vote_count + votesMoved };
}

/** Merge `source` into `target`. Votes are deduplicated per person, comments and tags move across. */
export async function mergePosts(ctx: Ctx, sourceId: string, targetId: string): Promise<Post> {
  const preview = await mergePreview(ctx, sourceId, targetId);
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO fb_votes (org_id, post_id, person_id, source, created_at)
       SELECT org_id, ?3, person_id, source, created_at FROM fb_votes WHERE org_id = ?1 AND post_id = ?2`,
    ).bind(ctx.orgId, sourceId, targetId),
    ctx.env.DB.prepare('DELETE FROM fb_votes WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, sourceId),
    ctx.env.DB.prepare('UPDATE fb_comments SET post_id = ?3 WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, sourceId, targetId),
    ctx.env.DB.prepare('INSERT OR IGNORE INTO fb_post_tags (org_id, post_id, tag_id) SELECT org_id, ?3, tag_id FROM fb_post_tags WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, sourceId, targetId),
    ctx.env.DB.prepare('DELETE FROM fb_post_tags WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, sourceId),
    ctx.env.DB.prepare('UPDATE fb_notes SET post_id = ?3 WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, sourceId, targetId),
    ctx.env.DB.prepare('INSERT OR IGNORE INTO fb_entry_posts (org_id, entry_id, post_id) SELECT org_id, entry_id, ?3 FROM fb_entry_posts WHERE org_id = ?1 AND post_id = ?2').bind(ctx.orgId, sourceId, targetId),
    ctx.env.DB.prepare("UPDATE fb_posts SET review = 'merged', merged_into = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2").bind(ctx.orgId, sourceId, targetId, now),
    ctx.env.DB.prepare('UPDATE fb_posts SET first_reply_at = COALESCE(first_reply_at, (SELECT first_reply_at FROM fb_posts WHERE id = ?3)) WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, targetId, sourceId),
  ]);
  const target = (await ctx.db.get<Post>('fb_posts', targetId))!;
  await emitFb(ctx.env, ctx.orgId, 'post.merged', sourceId, { into: targetId, votesMoved: preview.votesMoved });
  await milestone(ctx, target);
  return target;
}

/** Posts with words in common with what someone is typing. SQLite LIKE over title words. */
export async function similarPosts(ctx: Ctx, text: string, opts: { boardId?: string; limit?: number; publicOnly?: boolean; excludeId?: string } = {}): Promise<PostView[]> {
  const words = titleWords(text, 6);
  if (words.length === 0) return [];
  const likes = words.map((w) => `%${likeEscape(w)}%`);
  const score = words.map(() => "(CASE WHEN p.title LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END + CASE WHEN p.body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join(' + ');
  const any = words.map(() => "(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')").join(' OR ');
  const where = ["p.org_id = :org", "p.review = 'published'", `(${any})`];
  const params: (string | number)[] = [];
  for (const l of likes) params.push(l, l);
  for (const l of likes) params.push(l, l);
  if (opts.boardId) (where.push('p.board_id = ?'), params.push(opts.boardId));
  if (opts.publicOnly) where.push("b.visibility = 'public'");
  if (opts.excludeId) (where.push('p.id <> ?'), params.push(opts.excludeId));
  const sql = `${SELECT.replace('SELECT p.*,', `SELECT p.*, (${score}) AS score,`)} WHERE ${where.join(' AND ')} ORDER BY score DESC, p.vote_count DESC LIMIT ?`;
  // Parameter order in the SQL text: score placeholders come first, then the WHERE ones.
  return ctx.db.all<PostView>(sql, ...params, clamp(opts.limit ?? 5, 1, 10));
}
