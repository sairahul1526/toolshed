/** Newsletters, custom fields and saved segments. */
import { z } from 'zod';
import { newId, parseJson, randomToken } from '../../core/db';
import { errors, parse } from '../../core/errors';
import type { Env } from '../../env';
import { mailErrors } from './errors';
import { EMPTY_FILTER, filterSchema, parseFilter, type Filter } from './segments';
import type { Ctx, List } from './types';

/** Public paths under /n that are not newsletters. */
const RESERVED_SLUGS = new Set(['u', 'c', 'o', 'confirm', 'hook', 'embed', 'archive', 'api']);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3 to 40 lowercase letters, numbers or dashes.');

export const listInput = z.object({
  name: z.string().trim().min(1, 'Give the newsletter a name.').max(80),
  slug: slugSchema.optional(),
  description: z.string().trim().max(300).default(''),
  double_opt_in: z.boolean().default(true),
  reply_to: z.string().trim().email().or(z.literal('')).default(''),
  thanks_text: z.string().trim().max(300).default(''),
  archive_public: z.boolean().default(false),
});
export type ListInput = z.infer<typeof listInput>;

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base.length >= 3 ? base : `news-${base}`.replace(/-$/, '');
}

async function slugFree(env: Env, slug: string, exceptId = ''): Promise<boolean> {
  if (RESERVED_SLUGS.has(slug)) return false;
  const row = await env.DB.prepare('SELECT id FROM mail_lists WHERE slug = ?1').bind(slug).first<{ id: string }>();
  return !row || row.id === exceptId;
}

export async function createList(ctx: Ctx, raw: unknown, now = Date.now()): Promise<List> {
  const input = parse(listInput, raw);
  let slug = input.slug ?? slugify(input.name);
  if (!(await slugFree(ctx.env, slug))) {
    if (input.slug) throw mailErrors.slug_taken();
    slug = `${slug.slice(0, 30)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4)}`;
    if (!(await slugFree(ctx.env, slug))) throw mailErrors.slug_taken();
  }
  return ctx.db.insert<List>('mail_lists', { id: newId('mls', now), name: input.name, slug, description: input.description, double_opt_in: input.double_opt_in ? 1 : 0, reply_to: input.reply_to, thanks_text: input.thanks_text, archive_public: input.archive_public ? 1 : 0, created_at: now, updated_at: now });
}

export async function updateList(ctx: Ctx, id: string, raw: unknown, now = Date.now()): Promise<List> {
  const existing = await getList(ctx, id);
  const input = parse(listInput.partial(), raw);
  if (input.slug && input.slug !== existing.slug && !(await slugFree(ctx.env, input.slug, id))) throw mailErrors.slug_taken();
  const patch: Record<string, string | number> = { updated_at: now };
  for (const [k, v] of Object.entries(input)) patch[k] = typeof v === 'boolean' ? (v ? 1 : 0) : (v as string);
  return (await ctx.db.update<List>('mail_lists', id, patch))!;
}

export async function getList(ctx: Ctx, id: string): Promise<List> {
  const list = await ctx.db.get<List>('mail_lists', id);
  if (!list) throw mailErrors.list_not_found();
  return list;
}

/** Public pages start from a slug with no workspace, so this reads across workspaces. */
export async function listBySlug(env: Env, slug: string): Promise<List | null> {
  return env.DB.prepare('SELECT * FROM mail_lists WHERE slug = ?1').bind(slug.toLowerCase()).first<List>();
}

export interface ListSummary extends List {
  active: number;
  pending: number;
}

export async function listLists(ctx: Ctx): Promise<ListSummary[]> {
  return ctx.db.all<ListSummary>(
    `SELECT l.*,
       (SELECT COUNT(*) FROM mail_memberships m WHERE m.org_id = l.org_id AND m.list_id = l.id AND m.status = 'active') AS active,
       (SELECT COUNT(*) FROM mail_memberships m WHERE m.org_id = l.org_id AND m.list_id = l.id AND m.status = 'pending') AS pending
     FROM mail_lists l WHERE l.org_id = :org ORDER BY l.created_at, l.id`,
  );
}

export async function deleteList(ctx: Ctx, id: string): Promise<void> {
  await getList(ctx, id);
  const d1 = ctx.db.d1;
  const org = ctx.org.id;
  await d1.batch([
    d1.prepare('DELETE FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id IN (SELECT id FROM mail_broadcasts WHERE org_id = ?1 AND list_id = ?2)').bind(org, id),
    d1.prepare('DELETE FROM mail_links WHERE org_id = ?1 AND broadcast_id IN (SELECT id FROM mail_broadcasts WHERE org_id = ?1 AND list_id = ?2)').bind(org, id),
    d1.prepare('DELETE FROM mail_broadcasts WHERE org_id = ?1 AND list_id = ?2').bind(org, id),
    d1.prepare('DELETE FROM mail_enrollments WHERE org_id = ?1 AND sequence_id IN (SELECT id FROM mail_sequences WHERE org_id = ?1 AND list_id = ?2)').bind(org, id),
    d1.prepare('DELETE FROM mail_sequence_steps WHERE org_id = ?1 AND sequence_id IN (SELECT id FROM mail_sequences WHERE org_id = ?1 AND list_id = ?2)').bind(org, id),
    d1.prepare('DELETE FROM mail_sequences WHERE org_id = ?1 AND list_id = ?2').bind(org, id),
    d1.prepare('DELETE FROM mail_feeds WHERE org_id = ?1 AND list_id = ?2').bind(org, id),
    d1.prepare('DELETE FROM mail_memberships WHERE org_id = ?1 AND list_id = ?2').bind(org, id),
    d1.prepare('DELETE FROM mail_lists WHERE org_id = ?1 AND id = ?2').bind(org, id),
  ]);
}

// -- custom fields -----------------------------------------------------------------------------

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: string;
}

const fieldInput = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,40}$/, 'Use lowercase letters, numbers and underscores, starting with a letter.'),
  label: z.string().trim().min(1).max(60),
  type: z.enum(['text', 'number', 'date']).default('text'),
});

const RESERVED_FIELDS = new Set(['email', 'name', 'first_name', 'list_name', 'unsubscribe_url', 'preferences_url']);

export async function createField(ctx: Ctx, raw: unknown, now = Date.now()): Promise<FieldDef> {
  const input = parse(fieldInput, raw);
  if (RESERVED_FIELDS.has(input.key)) throw errors.validation_failed('That name is used by the email itself.', { key: 'Choose another key.' });
  if (await ctx.db.findOne('mail_fields', { key: input.key })) throw errors.conflict('You already have a field with that key.');
  return ctx.db.insert<FieldDef>('mail_fields', { id: newId('mlf', now), ...input, created_at: now });
}

export const listFields = (ctx: Ctx) => ctx.db.list<FieldDef>('mail_fields', { orderBy: 'key', limit: 200 });

export async function deleteField(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.remove('mail_fields', id);
}

// -- segments ------------------------------------------------------------------------------------

export interface SegmentRow {
  id: string;
  name: string;
  filter: string;
  created_at: number;
  updated_at: number;
}

export async function saveSegment(ctx: Ctx, input: { id?: string; name: unknown; filter: unknown }, now = Date.now()): Promise<SegmentRow> {
  const name = parse(z.string().trim().min(1, 'Name the segment.').max(80), input.name);
  const filter = JSON.stringify(parse(filterSchema, input.filter ?? EMPTY_FILTER));
  if (input.id) {
    const row = await ctx.db.update<SegmentRow>('mail_segments', input.id, { name, filter, updated_at: now });
    if (!row) throw errors.not_found('We couldn’t find that segment.');
    return row;
  }
  return ctx.db.insert<SegmentRow>('mail_segments', { id: newId('mlg', now), name, filter, created_at: now, updated_at: now });
}

export const listSegments = (ctx: Ctx) => ctx.db.list<SegmentRow>('mail_segments', { orderBy: 'created_at', limit: 200 });

export async function getSegment(ctx: Ctx, id: string): Promise<SegmentRow & { parsed: Filter }> {
  const row = await ctx.db.get<SegmentRow>('mail_segments', id);
  if (!row) throw errors.not_found('We couldn’t find that segment.');
  return { ...row, parsed: parseFilter(parseJson(row.filter, EMPTY_FILTER)) };
}

export async function deleteSegment(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.remove('mail_segments', id);
}
