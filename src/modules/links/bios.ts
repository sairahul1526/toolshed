/** Bio pages: one page of blocks (links, headings, text, social icons) at a short address. */
import { z } from 'zod';
import { newId, parseJson, type Scalar } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { bust } from './cache';
import { normalizeCode, randomCode } from './codes';
import { linkErrors } from './errors';
import { blockTotals } from './stats';
import type { LinksCtx } from './types';
import { blockedDomains, checkDestination, checkImageUrl } from './validate';

export const PLATFORMS = ['website', 'x', 'instagram', 'youtube', 'tiktok', 'linkedin', 'github', 'facebook', 'threads', 'mastodon', 'bluesky', 'twitch', 'discord', 'email'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const BLOCK_KINDS = ['link', 'heading', 'text', 'social'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export interface BioRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  bio: string;
  avatar_url: string;
  theme: 'workspace' | 'custom';
  colors: string;
  published: number;
  noindex: number;
  seo_title: string;
  seo_description: string;
  seo_image: string;
  sample: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface BlockRow {
  id: string;
  org_id: string;
  bio_id: string;
  kind: BlockKind;
  position: number;
  title: string;
  url: string;
  body: string;
  platform: string;
  visible: number;
  created_at: number;
  updated_at: number;
}

export interface BioColors {
  background: string;
  text: string;
  accent: string;
  buttonText: string;
}

export interface BlockView {
  id: string;
  kind: BlockKind;
  position: number;
  title: string;
  url: string;
  body: string;
  platform: string;
  visible: boolean;
  /** Clicks in the last 30 days. */
  clicks: number;
}

export interface BioView {
  id: string;
  code: string;
  shortUrl: string;
  name: string;
  bio: string;
  avatarUrl: string;
  theme: 'workspace' | 'custom';
  colors: BioColors;
  published: boolean;
  noindex: boolean;
  seo: { title: string; description: string; image: string };
  blocks: BlockView[];
  views: number;
  updatedAt: string;
}

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1a2b3c.');
export const DEFAULT_COLORS: BioColors = { background: '#ffffff', text: '#1b1b1f', accent: '#2f5bea', buttonText: '#ffffff' };

const colorsSchema = z.object({ background: hex.optional(), text: hex.optional(), accent: hex.optional(), buttonText: hex.optional() });

const blockInput = z.object({
  kind: z.enum(BLOCK_KINDS),
  title: z.string().trim().max(120).optional(),
  url: z.string().trim().max(2048).optional(),
  body: z.string().trim().max(1000).optional(),
  platform: z.enum(PLATFORMS).optional(),
  visible: z.boolean().optional(),
});

const bioFields = {
  name: z.string().trim().max(80),
  bio: z.string().trim().max(500),
  avatarUrl: z.string().trim().max(2048),
  theme: z.enum(['workspace', 'custom']),
  colors: colorsSchema,
  published: z.boolean(),
  noindex: z.boolean(),
  seo: z.object({ title: z.string().trim().max(120).optional(), description: z.string().trim().max(300).optional(), image: z.string().trim().max(2048).optional() }),
};

export const createBioSchema = z.object({
  code: z.string().trim().max(64).optional(),
  name: bioFields.name.optional(),
  bio: bioFields.bio.optional(),
  avatarUrl: bioFields.avatarUrl.optional(),
  theme: bioFields.theme.optional(),
  colors: bioFields.colors.optional(),
  published: bioFields.published.optional(),
  noindex: bioFields.noindex.optional(),
  seo: bioFields.seo.optional(),
  blocks: z.array(blockInput).max(60).optional(),
});
export const updateBioSchema = createBioSchema.omit({ blocks: true });
export const updateBlockSchema = blockInput.partial();

const COLS = ['id', 'org_id', 'code', 'name', 'bio', 'avatar_url', 'theme', 'colors', 'published', 'noindex', 'seo_title', 'seo_description', 'seo_image', 'sample', 'created_by', 'created_at', 'updated_at'] as const;
const BLOCK_COLS = ['id', 'org_id', 'bio_id', 'kind', 'position', 'title', 'url', 'body', 'platform', 'visible', 'created_at', 'updated_at'] as const;

export const bioColors = (row: Pick<BioRow, 'colors'>): BioColors => ({ ...DEFAULT_COLORS, ...parseJson<Partial<BioColors>>(row.colors, {}) });

function blockView(r: BlockRow, clicks = 0): BlockView {
  return { id: r.id, kind: r.kind, position: r.position, title: r.title, url: r.url, body: r.body, platform: r.platform, visible: r.visible === 1, clicks };
}

export async function getBioRow(ctx: LinksCtx, idOrCode: string): Promise<BioRow> {
  const row = await ctx.env.DB.prepare('SELECT * FROM links_bios WHERE org_id = ?1 AND (id = ?2 OR code = ?3)').bind(ctx.orgId, idOrCode, idOrCode.toLowerCase()).first<BioRow>();
  if (!row) throw linkErrors.bio_not_found();
  return row;
}

export async function blocksOf(ctx: LinksCtx, bioId: string): Promise<BlockRow[]> {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM links_bio_blocks WHERE org_id = ?1 AND bio_id = ?2 ORDER BY position, id').bind(ctx.orgId, bioId).all<BlockRow>();
  return results;
}

async function viewOf(ctx: LinksCtx, row: BioRow, withStats: boolean): Promise<BioView> {
  const [blocks, totals, views] = await Promise.all([
    blocksOf(ctx, row.id),
    withStats ? blockTotals(ctx, row.id, { days: 30 }) : Promise.resolve(new Map<string, number>()),
    ctx.env.DB.prepare(`SELECT COALESCE(SUM(clicks), 0) AS n FROM links_daily WHERE org_id = ?1 AND target_id = ?2 AND kind = 'view'`).bind(ctx.orgId, row.id).first<{ n: number }>(),
  ]);
  return {
    id: row.id,
    code: row.code,
    shortUrl: `${ctx.base}/${row.code}`,
    name: row.name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    theme: row.theme,
    colors: bioColors(row),
    published: row.published === 1,
    noindex: row.noindex === 1,
    seo: { title: row.seo_title, description: row.seo_description, image: row.seo_image },
    blocks: blocks.map((b) => blockView(b, totals.get(b.id) ?? 0)),
    views: views?.n ?? 0,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getBio(ctx: LinksCtx, idOrCode: string): Promise<BioView> {
  return viewOf(ctx, await getBioRow(ctx, idOrCode), true);
}

export async function listBios(ctx: LinksCtx): Promise<(BioView & { blockCount: number })[]> {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM links_bios WHERE org_id = ?1 ORDER BY id DESC LIMIT 100').bind(ctx.orgId).all<BioRow>();
  const out: (BioView & { blockCount: number })[] = [];
  for (const r of results) {
    const v = await viewOf(ctx, r, false);
    out.push({ ...v, blockCount: v.blocks.length });
  }
  return out;
}

async function cleanBlock(ctx: LinksCtx, input: z.infer<typeof blockInput>, blocked: readonly string[]): Promise<{ title: string; url: string; body: string; platform: string; visible: number }> {
  const out = { title: input.title ?? '', url: input.url ?? '', body: input.body ?? '', platform: input.platform ?? '', visible: input.visible === false ? 0 : 1 };
  if (input.kind === 'link' || input.kind === 'social') {
    if (input.kind === 'social') {
      if (!out.platform) throw errors.validation_failed('Pick a platform.', { platform: 'Pick a platform.' });
      if (out.platform === 'email') {
        const addr = out.url.replace(/^mailto:/i, '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw errors.validation_failed('Enter an email address.', { url: 'Enter an email address.' });
        out.url = `mailto:${addr}`;
        return out;
      }
    }
    if (input.kind === 'link' && !out.title) throw errors.validation_failed('Give the link a label.', { title: 'Give the link a label.' });
    out.url = await checkDestination(out.url, { blocked, base: ctx.base, env: ctx.env, skipLoopCheck: true });
  } else if (input.kind === 'heading') {
    if (!out.title) throw errors.validation_failed('Write the heading.', { title: 'Write the heading.' });
  } else if (!out.body) {
    throw errors.validation_failed('Write some text.', { body: 'Write some text.' });
  }
  return out;
}

export async function createBio(ctx: LinksCtx, raw: unknown): Promise<BioView> {
  const input = parse(createBioSchema, raw);
  const blocked = await blockedDomains(ctx.env, ctx.orgId);
  const now = Date.now();
  const custom = input.code ? normalizeCode(input.code) : null;
  const colors = input.colors ? JSON.stringify(Object.fromEntries(Object.entries(input.colors).filter(([, v]) => v))) : '{}';
  const blockRows: BlockRow[] = [];
  for (const [i, b] of (input.blocks ?? []).entries()) {
    const c = await cleanBlock(ctx, b, blocked);
    blockRows.push({ id: newId('blk', now + i), org_id: ctx.orgId, bio_id: '', kind: b.kind, position: i, ...c, created_at: now, updated_at: now });
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = custom ?? randomCode(7);
    const row: BioRow = {
      id: newId('bio', now),
      org_id: ctx.orgId,
      code,
      name: input.name ?? '',
      bio: input.bio ?? '',
      avatar_url: input.avatarUrl ? checkImageUrl(input.avatarUrl, 'avatarUrl') : '',
      theme: input.theme ?? 'workspace',
      colors,
      published: input.published ? 1 : 0,
      noindex: input.noindex ? 1 : 0,
      seo_title: input.seo?.title ?? '',
      seo_description: input.seo?.description ?? '',
      seo_image: input.seo?.image ? checkImageUrl(input.seo.image, 'seo') : '',
      sample: 0,
      created_by: ctx.actorId ?? null,
      created_at: now,
      updated_at: now,
    };
    const { DB } = ctx.env;
    try {
      await DB.batch([
        DB.prepare('INSERT INTO links_slugs (code, org_id, kind, target_id) VALUES (?1, ?2, ?3, ?4)').bind(code, ctx.orgId, 'bio', row.id),
        DB.prepare(`INSERT INTO links_bios (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...COLS.map((c) => row[c] as Scalar)),
        ...blockRows.map((b) => DB.prepare(`INSERT INTO links_bio_blocks (${BLOCK_COLS.join(', ')}) VALUES (${BLOCK_COLS.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...BLOCK_COLS.map((c) => (c === 'bio_id' ? row.id : (b[c] as Scalar))))),
      ]);
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e))) throw e;
      if (custom) throw linkErrors.code_taken(undefined, { code: linkErrors.code_taken().message });
      continue;
    }
    await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'bio.updated', subject: row.id, data: { code, change: 'created' } });
    return viewOf(ctx, row, false);
  }
  throw errors.conflict('We couldn’t find a free address. Try again.');
}

export async function updateBio(ctx: LinksCtx, idOrCode: string, raw: unknown): Promise<BioView> {
  const input = parse(updateBioSchema, raw);
  const row = await getBioRow(ctx, idOrCode);
  const patch: Record<string, Scalar> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.bio !== undefined) patch.bio = input.bio;
  if (input.avatarUrl !== undefined) patch.avatar_url = input.avatarUrl ? checkImageUrl(input.avatarUrl, 'avatarUrl') : '';
  if (input.theme !== undefined) patch.theme = input.theme;
  if (input.colors !== undefined) patch.colors = JSON.stringify({ ...parseJson<Record<string, string>>(row.colors, {}), ...Object.fromEntries(Object.entries(input.colors).filter(([, v]) => v)) });
  if (input.published !== undefined) patch.published = input.published ? 1 : 0;
  if (input.noindex !== undefined) patch.noindex = input.noindex ? 1 : 0;
  if (input.seo?.title !== undefined) patch.seo_title = input.seo.title;
  if (input.seo?.description !== undefined) patch.seo_description = input.seo.description;
  if (input.seo?.image !== undefined) patch.seo_image = input.seo.image ? checkImageUrl(input.seo.image, 'seo') : '';
  const newCode = input.code ? normalizeCode(input.code) : row.code;
  patch.code = newCode;
  patch.updated_at = Date.now();
  const keys = Object.keys(patch);
  const { DB } = ctx.env;
  const stmts: D1PreparedStatement[] = [];
  if (newCode !== row.code) {
    stmts.push(DB.prepare('DELETE FROM links_slugs WHERE code = ?1 AND target_id = ?2').bind(row.code, row.id));
    stmts.push(DB.prepare('INSERT INTO links_slugs (code, org_id, kind, target_id) VALUES (?1, ?2, ?3, ?4)').bind(newCode, ctx.orgId, 'bio', row.id));
  }
  stmts.push(DB.prepare(`UPDATE links_bios SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(', ')} WHERE org_id = ?1 AND id = ?2`).bind(ctx.orgId, row.id, ...keys.map((k) => patch[k]!)));
  try {
    await DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) throw linkErrors.code_taken(undefined, { code: linkErrors.code_taken().message });
    throw e;
  }
  await bust(ctx.env, row.code, newCode);
  await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'bio.updated', subject: row.id, data: { code: newCode, change: 'settings' } });
  return getBio(ctx, row.id);
}

export async function deleteBio(ctx: LinksCtx, idOrCode: string): Promise<void> {
  const row = await getBioRow(ctx, idOrCode);
  const { DB } = ctx.env;
  await DB.batch([
    DB.prepare('DELETE FROM links_slugs WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, row.id),
    DB.prepare('DELETE FROM links_bio_blocks WHERE org_id = ?1 AND bio_id = ?2').bind(ctx.orgId, row.id),
    DB.prepare('DELETE FROM links_daily WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, row.id),
    DB.prepare('DELETE FROM links_clicks WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, row.id),
    DB.prepare('DELETE FROM links_rollups WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, row.id),
    DB.prepare('DELETE FROM links_bios WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, row.id),
  ]);
  await bust(ctx.env, row.code);
  await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'bio.updated', subject: row.id, data: { code: row.code, change: 'deleted' } });
}

async function touch(ctx: LinksCtx, bio: BioRow, change: string): Promise<void> {
  await ctx.env.DB.prepare('UPDATE links_bios SET updated_at = ?3 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, bio.id, Date.now()).run();
  await bust(ctx.env, bio.code);
  await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'bio.updated', subject: bio.id, data: { code: bio.code, change } });
}

export async function addBlock(ctx: LinksCtx, bioIdOrCode: string, raw: unknown): Promise<BlockView> {
  const bio = await getBioRow(ctx, bioIdOrCode);
  const input = parse(blockInput, raw);
  const c = await cleanBlock(ctx, input, await blockedDomains(ctx.env, ctx.orgId));
  const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS p FROM links_bio_blocks WHERE bio_id = ?1').bind(bio.id).first<{ n: number; p: number }>();
  if ((count?.n ?? 0) >= 60) throw errors.validation_failed('A bio page can have up to 60 blocks.');
  const now = Date.now();
  const row: BlockRow = { id: newId('blk', now), org_id: ctx.orgId, bio_id: bio.id, kind: input.kind, position: (count?.p ?? -1) + 1, ...c, created_at: now, updated_at: now };
  await ctx.env.DB.prepare(`INSERT INTO links_bio_blocks (${BLOCK_COLS.join(', ')}) VALUES (${BLOCK_COLS.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...BLOCK_COLS.map((k) => row[k] as Scalar)).run();
  await touch(ctx, bio, 'block_added');
  return blockView(row);
}

export async function updateBlock(ctx: LinksCtx, blockId: string, raw: unknown): Promise<BlockView> {
  const existing = await ctx.env.DB.prepare('SELECT * FROM links_bio_blocks WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, blockId).first<BlockRow>();
  if (!existing) throw linkErrors.block_not_found();
  const bio = await getBioRow(ctx, existing.bio_id);
  const input = parse(updateBlockSchema, raw);
  const merged = { title: existing.title, url: existing.url, body: existing.body, platform: (existing.platform || undefined) as Platform | undefined, visible: existing.visible === 1, ...input, kind: existing.kind };
  const c = await cleanBlock(ctx, merged, await blockedDomains(ctx.env, ctx.orgId));
  await ctx.env.DB.prepare('UPDATE links_bio_blocks SET title = ?3, url = ?4, body = ?5, platform = ?6, visible = ?7, updated_at = ?8 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, blockId, c.title, c.url, c.body, c.platform, c.visible, Date.now()).run();
  await touch(ctx, bio, 'block_updated');
  return blockView({ ...existing, ...c });
}

export async function deleteBlock(ctx: LinksCtx, blockId: string): Promise<void> {
  const existing = await ctx.env.DB.prepare('SELECT * FROM links_bio_blocks WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, blockId).first<BlockRow>();
  if (!existing) throw linkErrors.block_not_found();
  const bio = await getBioRow(ctx, existing.bio_id);
  await ctx.env.DB.prepare('DELETE FROM links_bio_blocks WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, blockId).run();
  await touch(ctx, bio, 'block_deleted');
}

/** Set the block order. `ids` lists every block id of the page in the new order. */
export async function reorderBlocks(ctx: LinksCtx, bioIdOrCode: string, ids: string[]): Promise<void> {
  const bio = await getBioRow(ctx, bioIdOrCode);
  const current = (await blocksOf(ctx, bio.id)).map((b) => b.id);
  const known = new Set(current);
  const order = [...new Set(ids)].filter((id) => known.has(id));
  const rest = current.filter((id) => !order.includes(id));
  const final = [...order, ...rest];
  await ctx.env.DB.batch(final.map((id, i) => ctx.env.DB.prepare('UPDATE links_bio_blocks SET position = ?3 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id, i)));
  await touch(ctx, bio, 'blocks_reordered');
}

/** Move one block up or down by one place. */
export async function moveBlock(ctx: LinksCtx, blockId: string, direction: 'up' | 'down'): Promise<void> {
  const existing = await ctx.env.DB.prepare('SELECT * FROM links_bio_blocks WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, blockId).first<BlockRow>();
  if (!existing) throw linkErrors.block_not_found();
  const ids = (await blocksOf(ctx, existing.bio_id)).map((b) => b.id);
  const i = ids.indexOf(blockId);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  await reorderBlocks(ctx, existing.bio_id, ids);
}
