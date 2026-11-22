/** The portal, its boards, categories, statuses and tags. One portal per workspace. */
import { z } from 'zod';
import { newId, type OrgDb } from '../../core/db';
import { parse } from '../../core/errors';
import type { Env } from '../../env';
import { fbErrors } from './errors';
import { DEFAULT_STATUSES, type Board, type Category, type Portal, type Status, type Tag } from './types';
import { PORTAL_SLUG, RESERVED_PORTAL_SLUGS, defined, randomSuffix, slugify } from './util';

export interface Ctx {
  env: Env;
  orgId: string;
  db: OrgDb;
  /** Public origin of this install, for links in emails. Read from the request, or APP_URL. */
  origin?: string;
}

export const PRESETS = ['paper', 'warm', 'cobalt', 'dusk'] as const;

// ---------------------------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------------------------

export function getPortal(ctx: Ctx): Promise<Portal | null> {
  return ctx.db.findOne<Portal>('fb_portals', {});
}

/** Public lookup: a slug is unique across the install, so no workspace is needed. */
export function portalBySlug(env: Env, slug: string): Promise<Portal | null> {
  return env.DB.prepare('SELECT * FROM fb_portals WHERE slug = ?1').bind(slug).first<Portal>();
}

export function validateSlug(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!PORTAL_SLUG.test(s) || RESERVED_PORTAL_SLUGS.has(s)) throw fbErrors.slug_invalid();
  return s;
}

async function slugFree(env: Env, slug: string, exceptOrg?: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT org_id FROM fb_portals WHERE slug = ?1').bind(slug).first<{ org_id: string }>();
  return !row || row.org_id === exceptOrg;
}

export async function pickSlug(env: Env, wanted: string): Promise<string> {
  let base = slugify(wanted, 30, 'feedback');
  if (base.length < 3) base = `${base}-hq`;
  if (RESERVED_PORTAL_SLUGS.has(base)) base = `${base}-hq`;
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? base : `${base}-${randomSuffix(3)}`;
    if (PORTAL_SLUG.test(candidate) && (await slugFree(env, candidate))) return candidate;
  }
  return `${base.slice(0, 30)}-${randomSuffix(6)}`;
}

const portalName = z.string().trim().min(1, 'Add a name.').max(80, 'Keep the name under 80 characters.');

const createSchema = z.object({
  name: portalName,
  slug: z.string().trim().optional(),
  tagline: z.string().trim().max(160, 'Keep the tagline under 160 characters.').optional(),
});

/** Create the workspace's portal with the default statuses and one board. */
export async function createPortal(ctx: Ctx, input: { name: string; slug?: string; tagline?: string }): Promise<Portal> {
  const data = parse(createSchema, input);
  if (await getPortal(ctx)) throw fbErrors.portal_exists();
  const slug = data.slug ? validateSlug(data.slug) : await pickSlug(ctx.env, data.name);
  if (!(await slugFree(ctx.env, slug))) throw fbErrors.slug_taken();
  const now = Date.now();
  const portal: Portal = {
    id: newId('fbp', now),
    org_id: ctx.orgId,
    slug,
    name: data.name,
    tagline: data.tagline ?? '',
    theme: 'paper',
    accent: null,
    show_powered: 0,
    vote_limit: 0,
    allow_anonymous: 1,
    hide_last_names: 0,
    roadmap_on: 1,
    changelog_on: 1,
    default_sort: 'top',
    reply_to: null,
    digest_emails: '',
    widget_seen_at: null,
    widget_host: null,
    created_at: now,
    updated_at: now,
  };
  const stmts = [
    ctx.env.DB.prepare(
      `INSERT INTO fb_portals (id, org_id, slug, name, tagline, theme, show_powered, vote_limit, allow_anonymous, hide_last_names, roadmap_on, changelog_on, default_sort, digest_emails, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'paper', 0, 0, 1, 0, 1, 1, 'top', '', ?6, ?6)`,
    ).bind(portal.id, ctx.orgId, slug, portal.name, portal.tagline, now),
    ...DEFAULT_STATUSES.map((s, i) =>
      ctx.env.DB.prepare('INSERT INTO fb_statuses (id, org_id, name, tone, kind, position, in_roadmap, is_initial) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(
        newId('fbs', now + i),
        ctx.orgId,
        s.name,
        s.tone,
        s.kind,
        i,
        s.in_roadmap,
        s.is_initial,
      ),
    ),
    ctx.env.DB.prepare(
      `INSERT INTO fb_boards (id, org_id, slug, name, description, position, visibility, voting_on, hide_votes, moderate, posting_on, created_at)
       VALUES (?1, ?2, 'feature-requests', 'Feature requests', 'Tell us what to build next.', 0, 'public', 1, 0, 0, 1, ?3)`,
    ).bind(newId('fbb', now), ctx.orgId, now),
  ];
  try {
    await ctx.env.DB.batch(stmts);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) throw fbErrors.slug_taken();
    throw err;
  }
  return portal;
}

const bool = z.union([z.boolean(), z.literal('on'), z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false'), z.literal(1), z.literal(0)]).transform((v) => (v === true || v === 'on' || v === '1' || v === 'true' || v === 1 ? 1 : 0));

const portalPatch = z
  .object({
    name: portalName,
    slug: z.string().trim(),
    tagline: z.string().trim().max(160, 'Keep the tagline under 160 characters.'),
    theme: z.enum(PRESETS, { error: 'Pick one of the themes.' }),
    accent: z
      .string()
      .trim()
      .refine((v) => v === '' || /^#[0-9a-fA-F]{6}$/.test(v), 'Use a color like #3f6212.')
      .transform((v) => (v === '' ? null : v.toLowerCase())),
    show_powered: bool,
    vote_limit: z.coerce.number().int('Use a whole number.').min(0).max(1000),
    allow_anonymous: bool,
    hide_last_names: bool,
    roadmap_on: bool,
    changelog_on: bool,
    default_sort: z.enum(['top', 'new', 'trending']),
    reply_to: z
      .string()
      .trim()
      .max(254)
      .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.')
      .transform((v) => (v === '' ? null : v.toLowerCase())),
    digest_emails: z
      .string()
      .trim()
      .max(1000)
      .transform((v) =>
        [...new Set(v.split(/[\s,;]+/).map((e) => e.toLowerCase()).filter(Boolean))]
          .slice(0, 20)
          .join(','),
      )
      .refine((v) => v === '' || v.split(',').every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), 'Each address must be a valid email.'),
  })
  .partial();

export type PortalPatch = z.input<typeof portalPatch>;

export async function updatePortal(ctx: Ctx, patch: PortalPatch): Promise<Portal> {
  const portal = await getPortal(ctx);
  if (!portal) throw fbErrors.portal_missing();
  const data = defined(parse(portalPatch, patch)) as z.infer<typeof portalPatch>;
  if (data.slug !== undefined && data.slug !== portal.slug) {
    data.slug = validateSlug(data.slug);
    if (!(await slugFree(ctx.env, data.slug, ctx.orgId))) throw fbErrors.slug_taken();
  } else delete data.slug;
  const row = await ctx.db.update<Portal>('fb_portals', portal.id, { ...data, updated_at: Date.now() });
  return row!;
}

// ---------------------------------------------------------------------------------------------
// Boards and categories
// ---------------------------------------------------------------------------------------------

export function listBoards(ctx: Ctx): Promise<Board[]> {
  return ctx.db.list<Board>('fb_boards', { orderBy: 'position, id', limit: 200 });
}

export function boardBySlug(ctx: Ctx, slug: string): Promise<Board | null> {
  return ctx.db.findOne<Board>('fb_boards', { slug });
}

const boardSchema = z.object({
  name: z.string().trim().min(1, 'Add a name.').max(60, 'Keep the name under 60 characters.'),
  description: z.string().trim().max(240, 'Keep the description under 240 characters.').default(''),
  visibility: z.enum(['public', 'private']).default('public'),
  voting_on: bool.default(1),
  hide_votes: bool.default(0),
  moderate: bool.default(0),
  posting_on: bool.default(1),
});

export type BoardInput = z.input<typeof boardSchema>;

export async function createBoard(ctx: Ctx, input: BoardInput): Promise<Board> {
  const data = parse(boardSchema, input);
  const existing = await listBoards(ctx);
  if (existing.length >= 20) throw fbErrors.board_missing('A portal can have up to 20 boards.');
  let slug = slugify(data.name, 40, 'board');
  const taken = new Set(existing.map((b) => b.slug));
  while (taken.has(slug)) slug = `${slugify(data.name, 34, 'board')}-${randomSuffix(3)}`;
  return ctx.db.insert<Board>('fb_boards', { id: newId('fbb'), slug, position: existing.length, created_at: Date.now(), ...data });
}

export async function updateBoard(ctx: Ctx, id: string, patch: Partial<BoardInput>): Promise<Board> {
  const board = await ctx.db.get<Board>('fb_boards', id);
  if (!board) throw fbErrors.board_missing();
  const data = defined(parse(boardSchema.partial(), patch));
  const row = await ctx.db.update<Board>('fb_boards', id, data);
  return row!;
}

export async function deleteBoard(ctx: Ctx, id: string): Promise<void> {
  const board = await ctx.db.get<Board>('fb_boards', id);
  if (!board) throw fbErrors.board_missing();
  const posts = await ctx.db.count('fb_posts', { board_id: id });
  if (posts > 0) throw fbErrors.board_missing('Move or delete the posts on this board first.');
  const boards = await ctx.db.count('fb_boards');
  if (boards <= 1) throw fbErrors.board_missing('Keep at least one board.');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM fb_categories WHERE org_id = ?1 AND board_id = ?2').bind(ctx.orgId, id),
    ctx.env.DB.prepare('DELETE FROM fb_boards WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
  ]);
}

export function listCategories(ctx: Ctx, boardId?: string): Promise<Category[]> {
  return boardId
    ? ctx.db.all<Category>('SELECT * FROM fb_categories WHERE org_id = :org AND board_id = ? ORDER BY position, id', boardId)
    : ctx.db.all<Category>('SELECT * FROM fb_categories WHERE org_id = :org ORDER BY board_id, position, id');
}

export async function createCategory(ctx: Ctx, boardId: string, name: string): Promise<Category> {
  const board = await ctx.db.get<Board>('fb_boards', boardId);
  if (!board) throw fbErrors.board_missing();
  const clean = parse(z.string().trim().min(1, 'Add a name.').max(40, 'Keep the name under 40 characters.'), name);
  const existing = await listCategories(ctx, boardId);
  if (existing.some((c) => c.name.toLowerCase() === clean.toLowerCase())) return existing.find((c) => c.name.toLowerCase() === clean.toLowerCase())!;
  if (existing.length >= 30) throw fbErrors.board_missing('A board can have up to 30 categories.');
  return ctx.db.insert<Category>('fb_categories', { id: newId('fbc'), board_id: boardId, name: clean, position: existing.length });
}

export async function deleteCategory(ctx: Ctx, id: string): Promise<void> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE fb_posts SET category_id = NULL WHERE org_id = ?1 AND category_id = ?2').bind(ctx.orgId, id),
    ctx.env.DB.prepare('DELETE FROM fb_categories WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------

export function listStatuses(ctx: Ctx): Promise<Status[]> {
  return ctx.db.list<Status>('fb_statuses', { orderBy: 'position, id', limit: 100 });
}

const TONES = ['neutral', 'good', 'warn', 'bad', 'solid'] as const;

const statusSchema = z.object({
  name: z.string().trim().min(1, 'Add a name.').max(30, 'Keep the name under 30 characters.'),
  tone: z.enum(TONES).default('neutral'),
  kind: z.enum(['open', 'active', 'done', 'closed']).default('open'),
  in_roadmap: bool.default(0),
});

export type StatusInput = z.input<typeof statusSchema>;

export async function createStatus(ctx: Ctx, input: StatusInput): Promise<Status> {
  const data = parse(statusSchema, input);
  const all = await listStatuses(ctx);
  if (all.length >= 20) throw fbErrors.status_missing('A portal can have up to 20 statuses.');
  if (all.some((s) => s.name.toLowerCase() === data.name.toLowerCase())) throw fbErrors.status_missing('A status with that name already exists.');
  return ctx.db.insert<Status>('fb_statuses', { id: newId('fbs'), position: all.length, is_initial: 0, ...data });
}

export async function updateStatus(ctx: Ctx, id: string, patch: Partial<StatusInput> & { is_initial?: boolean | number }): Promise<Status> {
  const status = await ctx.db.get<Status>('fb_statuses', id);
  if (!status) throw fbErrors.status_missing();
  const { is_initial, ...rest } = patch;
  const data = defined(parse(statusSchema.partial(), rest)) as Record<string, string | number>;
  if (data.name !== undefined) {
    const others = (await listStatuses(ctx)).filter((s) => s.id !== id);
    if (others.some((s) => s.name.toLowerCase() === String(data.name).toLowerCase())) throw fbErrors.status_missing('A status with that name already exists.');
  }
  if (is_initial) {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE fb_statuses SET is_initial = 0 WHERE org_id = ?1').bind(ctx.orgId),
      ctx.env.DB.prepare('UPDATE fb_statuses SET is_initial = 1 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
    ]);
  }
  const row = await ctx.db.update<Status>('fb_statuses', id, data);
  return row!;
}

export async function moveStatus(ctx: Ctx, id: string, direction: 'up' | 'down'): Promise<void> {
  const all = await listStatuses(ctx);
  const i = all.findIndex((s) => s.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= all.length) return;
  const a = all[i]!;
  const b = all[j]!;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE fb_statuses SET position = ?3 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, a.id, j),
    ctx.env.DB.prepare('UPDATE fb_statuses SET position = ?3 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, b.id, i),
  ]);
}

export async function deleteStatus(ctx: Ctx, id: string): Promise<void> {
  const status = await ctx.db.get<Status>('fb_statuses', id);
  if (!status) throw fbErrors.status_missing();
  const all = await listStatuses(ctx);
  if (all.length <= 2) throw fbErrors.status_missing('Keep at least two statuses.');
  if (status.is_initial) throw fbErrors.status_in_use('This is the status new posts start with. Choose another starting status first.');
  if ((await ctx.db.count('fb_posts', { status_id: id })) > 0) throw fbErrors.status_in_use();
  await ctx.db.remove('fb_statuses', id);
}

export async function initialStatus(ctx: Ctx): Promise<Status | null> {
  return (await ctx.db.findOne<Status>('fb_statuses', { is_initial: 1 })) ?? (await listStatuses(ctx))[0] ?? null;
}

export async function doneStatus(ctx: Ctx): Promise<Status | null> {
  return ctx.db.findOne<Status>('fb_statuses', { kind: 'done' });
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

export function listTags(ctx: Ctx): Promise<Tag[]> {
  return ctx.db.list<Tag>('fb_tags', { orderBy: 'name', limit: 200 });
}

export async function createTag(ctx: Ctx, input: { name: string; is_public?: boolean | number | string }): Promise<Tag> {
  const name = parse(z.string().trim().min(1, 'Add a name.').max(30, 'Keep the name under 30 characters.'), input.name);
  const existing = await ctx.db.findOne<Tag>('fb_tags', { name });
  if (existing) return existing;
  const isPublic = parse(bool.default(0), input.is_public);
  return ctx.db.insert<Tag>('fb_tags', { id: newId('fbt'), name, is_public: isPublic });
}

export async function updateTag(ctx: Ctx, id: string, patch: { name?: string; is_public?: boolean | number | string }): Promise<Tag> {
  const tag = await ctx.db.get<Tag>('fb_tags', id);
  if (!tag) throw fbErrors.status_missing('We couldn’t find that tag.');
  const data: Record<string, string | number> = {};
  if (patch.name !== undefined) data.name = parse(z.string().trim().min(1).max(30), patch.name);
  if (patch.is_public !== undefined) data.is_public = parse(bool, patch.is_public);
  return (await ctx.db.update<Tag>('fb_tags', id, data))!;
}

export async function deleteTag(ctx: Ctx, id: string): Promise<void> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM fb_post_tags WHERE org_id = ?1 AND tag_id = ?2').bind(ctx.orgId, id),
    ctx.env.DB.prepare('DELETE FROM fb_tags WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
  ]);
}

/** First run: the workspace gets a portal named after it, with the default statuses and one board. */
export async function ensurePortal(ctx: Ctx, orgName: string): Promise<Portal> {
  return (await getPortal(ctx)) ?? createPortal(ctx, { name: orgName || 'Product feedback', tagline: 'Tell us what to build next.' });
}
