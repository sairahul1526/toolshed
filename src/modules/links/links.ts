/** Short links: create, read, edit, archive, duplicate, delete, list and bulk actions. */
import { hashPassword, MIN_ITERATIONS } from '../../auth/hasher';
import { likeEscape } from '../../core/audit';
import { newId, type Scalar } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { bust } from './cache';
import { isReserved, normalizeCode, randomCode } from './codes';
import { linkErrors } from './errors';
import { folderExists } from './folders';
import { createLinkSchema, normalizeRule, ruleValuesValid, toMs, updateLinkSchema, type CreateLinkInput, type ListQuery, listQuerySchema, bulkActionSchema } from './schemas';
import { getSettings } from './settings';
import { type LinkRow, type LinksCtx, type LinkView, type RuleDef, toView } from './types';
import { applyUtm, blockedDomains, checkDestination, checkImageUrl, matchBlocked, hostOf } from './validate';

type D1 = D1PreparedStatement;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const inList = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Add tags and click totals to link rows. Two queries however many rows there are. */
export async function hydrate(ctx: LinksCtx, rows: LinkRow[]): Promise<LinkView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [tags, totals] = await Promise.all([
    ctx.env.DB.prepare(`SELECT link_id, tag FROM links_link_tags WHERE org_id = ?1 AND link_id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')}) ORDER BY tag`)
      .bind(ctx.orgId, ...ids)
      .all<{ link_id: string; tag: string }>(),
    ctx.env.DB.prepare(
      `SELECT target_id, SUM(clicks) AS n FROM links_daily WHERE org_id = ?1 AND kind = 'click' AND target_id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')}) GROUP BY target_id`,
    )
      .bind(ctx.orgId, ...ids)
      .all<{ target_id: string; n: number }>(),
  ]);
  const tagMap = new Map<string, string[]>();
  for (const t of tags.results) (tagMap.get(t.link_id) ?? tagMap.set(t.link_id, []).get(t.link_id)!).push(t.tag);
  const clickMap = new Map(totals.results.map((r) => [r.target_id, r.n]));
  return rows.map((r) => toView(r, ctx.base, tagMap.get(r.id) ?? [], clickMap.get(r.id) ?? 0));
}

export async function getLinkRow(ctx: LinksCtx, idOrCode: string): Promise<LinkRow> {
  const row = await ctx.env.DB.prepare('SELECT * FROM links_links WHERE org_id = ?1 AND (id = ?2 OR code = ?3)')
    .bind(ctx.orgId, idOrCode, idOrCode.toLowerCase())
    .first<LinkRow>();
  if (!row) throw linkErrors.not_found();
  return row;
}

export async function getLink(ctx: LinksCtx, idOrCode: string): Promise<LinkView> {
  const row = await getLinkRow(ctx, idOrCode);
  return (await hydrate(ctx, [row]))[0]!;
}

export interface LinkPage {
  items: LinkView[];
  nextCursor: string | null;
}

export async function listLinks(ctx: LinksCtx, rawQuery: Partial<ListQuery> = {}): Promise<LinkPage> {
  const q = parse(listQuerySchema, rawQuery);
  const limit = q.limit ?? 50;
  const where: string[] = ['l.org_id = :org'];
  const params: Scalar[] = [];
  const status = q.status ?? 'active';
  if (status !== 'all') {
    where.push('l.status = ?');
    params.push(status);
  }
  if (q.q) {
    const like = `%${likeEscape(q.q)}%`;
    where.push(`(l.url LIKE ? ESCAPE '\\' OR l.code LIKE ? ESCAPE '\\' OR l.title LIKE ? ESCAPE '\\' OR l.notes LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  if (q.tag) {
    where.push('EXISTS (SELECT 1 FROM links_link_tags t WHERE t.link_id = l.id AND t.tag = ?)');
    params.push(q.tag);
  }
  if (q.folder === 'none') where.push('l.folder_id IS NULL');
  else if (q.folder) {
    where.push('l.folder_id = ?');
    params.push(q.folder);
  }

  const sort = q.sort ?? 'newest';
  const keyset = sort === 'newest' || sort === 'oldest';
  let order: string;
  let offset = 0;
  if (keyset) {
    if (q.cursor) {
      where.push(sort === 'newest' ? 'l.id < ?' : 'l.id > ?');
      params.push(q.cursor);
    }
    order = sort === 'newest' ? 'l.id DESC' : 'l.id ASC';
  } else {
    offset = q.cursor?.startsWith('o:') ? Math.max(0, Number(q.cursor.slice(2)) || 0) : 0;
    order =
      sort === 'clicks'
        ? `(SELECT COALESCE(SUM(d.clicks), 0) FROM links_daily d WHERE d.target_id = l.id AND d.kind = 'click') DESC, l.id DESC`
        : sort === 'title'
          ? `lower(CASE WHEN l.title = '' THEN l.code ELSE l.title END), l.id`
          : 'l.code, l.id';
  }
  const sql = `SELECT l.* FROM links_links l WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`;
  const { results } = await ctx.env.DB.prepare(sql.replace(':org', '?1').replace(/\?(?!\d)/g, (() => { let n = 1; return () => `?${++n}`; })()))
    .bind(ctx.orgId, ...params)
    .all<LinkRow>();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return {
    items: await hydrate(ctx, rows),
    nextCursor: more && last ? (keyset ? last.id : `o:${offset + limit}`) : null,
  };
}

/** Counts for the list screen's header: how many links are active, archived and disabled. */
export async function countByStatus(ctx: LinksCtx): Promise<Record<'active' | 'archived' | 'disabled', number>> {
  const { results } = await ctx.env.DB.prepare('SELECT status, COUNT(*) AS n FROM links_links WHERE org_id = ?1 GROUP BY status').bind(ctx.orgId).all<{ status: string; n: number }>();
  const out = { active: 0, archived: 0, disabled: 0 };
  for (const r of results) if (r.status in out) out[r.status as keyof typeof out] = r.n;
  return out;
}

/** Every tag in use with how many links carry it. */
export async function listTags(ctx: LinksCtx): Promise<{ tag: string; links: number }[]> {
  const { results } = await ctx.env.DB.prepare('SELECT tag, COUNT(*) AS links FROM links_link_tags WHERE org_id = ?1 GROUP BY tag ORDER BY tag').bind(ctx.orgId).all<{ tag: string; links: number }>();
  return results;
}

/** Click counts per day for the last `days` days, for the sparklines in the list. Zero-filled. */
export async function sparklines(ctx: LinksCtx, ids: string[], days = 14, now = Date.now()): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!ids.length) return out;
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) labels.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  const { results } = await ctx.env.DB.prepare(
    `SELECT target_id, day, clicks FROM links_daily WHERE org_id = ?1 AND kind = 'click' AND day >= ?2 AND target_id IN (${ids.map((_, i) => `?${i + 3}`).join(', ')})`,
  )
    .bind(ctx.orgId, labels[0]!, ...ids)
    .all<{ target_id: string; day: string; clicks: number }>();
  for (const id of ids) out.set(id, labels.map(() => 0));
  for (const r of results) {
    const idx = labels.indexOf(r.day);
    if (idx >= 0) out.get(r.target_id)![idx] = r.clicks;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

function isUnique(e: unknown): boolean {
  return /UNIQUE|constraint/i.test(String(e));
}

export type Prepared = Partial<LinkRow> & { _tags?: string[] };

/** Check and normalise the fields a request sent. Only fields that were sent come back. */
export async function prepare(
  ctx: LinksCtx,
  input: Partial<CreateLinkInput> & { status?: 'active' | 'archived' },
  blocked: readonly string[],
  existing?: LinkRow,
): Promise<Prepared> {
  const out: Prepared = {};
  const dest = { blocked, base: ctx.base, env: ctx.env };
  if (input.url !== undefined || input.utm !== undefined) {
    let url = await checkDestination(input.url ?? existing!.url, dest);
    if (input.utm) url = applyUtm(url, input.utm);
    if (url.length > 2048) throw linkErrors.url_invalid('That address is too long once the UTM values are added.', { url: 'That address is too long once the UTM values are added.' });
    out.url = url;
  }
  if (input.title !== undefined) out.title = input.title;
  if (input.notes !== undefined) out.notes = input.notes;
  if (input.redirectType !== undefined) out.redirect_type = input.redirectType;
  if (input.folderId !== undefined) {
    if (input.folderId && !(await folderExists(ctx, input.folderId))) throw linkErrors.folder_not_found();
    out.folder_id = input.folderId;
  }
  if (input.startsAt !== undefined) out.starts_at = toMs(input.startsAt, 'startsAt');
  if (input.expiresAt !== undefined) {
    out.expires_at = toMs(input.expiresAt, 'expiresAt');
    out.expired_notified = 0;
  }
  const starts = out.starts_at !== undefined ? out.starts_at : (existing?.starts_at ?? null);
  const ends = out.expires_at !== undefined ? out.expires_at : (existing?.expires_at ?? null);
  if (starts !== null && ends !== null && ends <= starts) {
    throw errors.validation_failed('The end time has to come after the start time.', { expiresAt: 'Pick an end time after the start time.' });
  }
  if (input.clickCap !== undefined) {
    out.click_cap = input.clickCap;
    out.expired_notified = 0;
  }
  if (input.password !== undefined) out.password_hash = input.password === null ? null : await hashPassword(input.password, { iterations: MIN_ITERATIONS });
  if (input.expiredUrl !== undefined) {
    out.expired_url = input.expiredUrl ? await checkDestination(input.expiredUrl, { ...dest, field: 'expiredUrl' }) : null;
  }
  if (input.forwardQuery !== undefined) out.forward_query = input.forwardQuery ? 1 : 0;
  if (input.rules !== undefined) {
    const rules: RuleDef[] = [];
    for (const [i, r] of input.rules.entries()) {
      const rule = normalizeRule(r);
      if (!ruleValuesValid(rule)) {
        throw errors.validation_failed('Check the values in your rules.', { rules: `Rule ${i + 1} has a value we don’t recognise.` });
      }
      rule.url = await checkDestination(rule.url, { ...dest, field: 'rules' });
      rules.push(rule);
    }
    out.rules = JSON.stringify(rules);
  }
  if (input.preview) {
    if (input.preview.title !== undefined) out.preview_title = input.preview.title;
    if (input.preview.description !== undefined) out.preview_description = input.preview.description;
    if (input.preview.image !== undefined) out.preview_image = checkImageUrl(input.preview.image, 'preview');
  }
  if (input.tags !== undefined) out._tags = [...new Set(input.tags)];
  if (input.status !== undefined) {
    out.status = input.status;
    if (input.status === 'active') out.disabled_reason = null;
  }
  return out;
}

const COLUMNS = [
  'id', 'org_id', 'code', 'url', 'title', 'notes', 'redirect_type', 'status', 'disabled_reason', 'folder_id', 'starts_at', 'expires_at',
  'click_cap', 'password_hash', 'expired_url', 'forward_query', 'rules', 'preview_title', 'preview_description', 'preview_image',
  'expired_notified', 'sample', 'created_by', 'created_at', 'updated_at',
] as const;

export function linkStatements(ctx: LinksCtx, row: LinkRow, tags: string[]): D1[] {
  const { DB } = ctx.env;
  return [
    DB.prepare('INSERT INTO links_slugs (code, org_id, kind, target_id) VALUES (?1, ?2, ?3, ?4)').bind(row.code, row.org_id, 'link', row.id),
    DB.prepare(`INSERT INTO links_links (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_, i) => `?${i + 1}`).join(', ')})`).bind(
      ...COLUMNS.map((c) => row[c] as Scalar),
    ),
    ...tags.map((t) => DB.prepare('INSERT INTO links_link_tags (org_id, link_id, tag) VALUES (?1, ?2, ?3)').bind(row.org_id, row.id, t)),
  ];
}

/** Build a full row from prepared fields and defaults. */
export function baseRow(ctx: LinksCtx, code: string, p: Prepared, defaults: { redirect: number }, now: number): LinkRow {
  return {
    id: newId('lnk', now),
    org_id: ctx.orgId,
    code,
    url: p.url!,
    title: p.title ?? '',
    notes: p.notes ?? '',
    redirect_type: p.redirect_type ?? defaults.redirect,
    status: p.status ?? 'active',
    disabled_reason: null,
    folder_id: p.folder_id ?? null,
    starts_at: p.starts_at ?? null,
    expires_at: p.expires_at ?? null,
    click_cap: p.click_cap ?? null,
    password_hash: p.password_hash ?? null,
    expired_url: p.expired_url ?? null,
    forward_query: p.forward_query ?? 1,
    rules: p.rules ?? '[]',
    preview_title: p.preview_title ?? '',
    preview_description: p.preview_description ?? '',
    preview_image: p.preview_image ?? '',
    expired_notified: 0,
    sample: 0,
    created_by: ctx.actorId ?? null,
    created_at: now,
    updated_at: now,
  };
}

/** Pick a free random code. Checks five candidates in one query. */
async function freeRandomCode(ctx: LinksCtx, length: number): Promise<string> {
  const candidates = Array.from({ length: 5 }, () => randomCode(length));
  const { results } = await ctx.env.DB.prepare(`SELECT code FROM links_slugs WHERE code IN (${candidates.map((_, i) => `?${i + 1}`).join(', ')})`)
    .bind(...candidates)
    .all<{ code: string }>();
  const taken = new Set(results.map((r) => r.code));
  const free = candidates.find((c) => !taken.has(c));
  return free ?? freeRandomCode(ctx, length + 1);
}

export async function createLink(ctx: LinksCtx, raw: unknown): Promise<LinkView> {
  const input = parse(createLinkSchema, raw);
  const [settings, blocked] = await Promise.all([getSettings(ctx.env, ctx.orgId), blockedDomains(ctx.env, ctx.orgId)]);
  const p = await prepare(ctx, input, blocked);
  const custom = input.code ? normalizeCode(input.code) : null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = custom ?? (await freeRandomCode(ctx, settings.codeLength));
    const row = baseRow(ctx, code, p, { redirect: settings.defaultRedirectType }, Date.now());
    try {
      await ctx.env.DB.batch(linkStatements(ctx, row, p._tags ?? []));
    } catch (e) {
      if (!isUnique(e)) throw e;
      if (custom) throw linkErrors.code_taken(undefined, { code: linkErrors.code_taken().message });
      continue;
    }
    await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.created', subject: row.id, data: { code, url: row.url } });
    return (await hydrate(ctx, [row]))[0]!;
  }
  throw errors.conflict('We couldn’t find a free short code. Try again.');
}

export async function updateLink(ctx: LinksCtx, idOrCode: string, raw: unknown): Promise<LinkView> {
  const input = parse(updateLinkSchema, raw);
  const existing = await getLinkRow(ctx, idOrCode);
  const blocked = await blockedDomains(ctx.env, ctx.orgId);
  const p = await prepare(ctx, input, blocked, existing);
  const { DB } = ctx.env;
  const now = Date.now();
  const patch: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith('_')) patch[k] = v as Scalar;
  // Changing a blocked or disabled link's address to a good one brings it back.
  if (existing.status === 'disabled' && p.url && p.status === undefined) {
    patch.status = 'active';
    patch.disabled_reason = null;
  }
  const newCode = input.code !== undefined && input.code.trim() !== '' ? normalizeCode(input.code) : existing.code;
  patch.code = newCode;
  patch.updated_at = now;
  const keys = Object.keys(patch);
  const stmts: D1[] = [];
  if (newCode !== existing.code) {
    stmts.push(DB.prepare('DELETE FROM links_slugs WHERE code = ?1 AND target_id = ?2').bind(existing.code, existing.id));
    stmts.push(DB.prepare('INSERT INTO links_slugs (code, org_id, kind, target_id) VALUES (?1, ?2, ?3, ?4)').bind(newCode, ctx.orgId, 'link', existing.id));
  }
  stmts.push(
    DB.prepare(`UPDATE links_links SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(', ')} WHERE org_id = ?1 AND id = ?2`).bind(ctx.orgId, existing.id, ...keys.map((k) => patch[k]!)),
  );
  if (p._tags) {
    stmts.push(DB.prepare('DELETE FROM links_link_tags WHERE org_id = ?1 AND link_id = ?2').bind(ctx.orgId, existing.id));
    for (const t of p._tags) stmts.push(DB.prepare('INSERT INTO links_link_tags (org_id, link_id, tag) VALUES (?1, ?2, ?3)').bind(ctx.orgId, existing.id, t));
  }
  try {
    await DB.batch(stmts);
  } catch (e) {
    if (isUnique(e)) throw linkErrors.code_taken(undefined, { code: linkErrors.code_taken().message });
    throw e;
  }
  await bust(ctx.env, existing.code, newCode);
  const row = await getLinkRow(ctx, existing.id);
  await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.updated', subject: row.id, data: { code: row.code, changed: Object.keys(input) } });
  return (await hydrate(ctx, [row]))[0]!;
}

export async function setArchived(ctx: LinksCtx, idOrCode: string, archived: boolean): Promise<LinkView> {
  return updateLink(ctx, idOrCode, { status: archived ? 'archived' : 'active' });
}

export async function duplicateLink(ctx: LinksCtx, idOrCode: string): Promise<LinkView> {
  const src = await getLinkRow(ctx, idOrCode);
  const settings = await getSettings(ctx.env, ctx.orgId);
  const tags = (await ctx.env.DB.prepare('SELECT tag FROM links_link_tags WHERE org_id = ?1 AND link_id = ?2').bind(ctx.orgId, src.id).all<{ tag: string }>()).results.map((t) => t.tag);
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = await freeRandomCode(ctx, settings.codeLength);
    const now = Date.now();
    const row: LinkRow = {
      ...src,
      id: newId('lnk', now),
      code,
      title: src.title ? `${src.title} (copy)`.slice(0, 200) : '',
      status: 'active',
      disabled_reason: null,
      expired_notified: 0,
      sample: 0,
      created_by: ctx.actorId ?? null,
      created_at: now,
      updated_at: now,
    };
    try {
      await ctx.env.DB.batch(linkStatements(ctx, row, tags));
    } catch (e) {
      if (isUnique(e)) continue;
      throw e;
    }
    await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.created', subject: row.id, data: { code, url: row.url, duplicatedFrom: src.id } });
    return (await hydrate(ctx, [row]))[0]!;
  }
  throw errors.conflict('We couldn’t find a free short code. Try again.');
}

function deleteStatements(ctx: LinksCtx, id: string): D1[] {
  const { DB } = ctx.env;
  return [
    DB.prepare('DELETE FROM links_slugs WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, id),
    DB.prepare('DELETE FROM links_link_tags WHERE org_id = ?1 AND link_id = ?2').bind(ctx.orgId, id),
    DB.prepare('DELETE FROM links_daily WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, id),
    DB.prepare('DELETE FROM links_clicks WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, id),
    DB.prepare('DELETE FROM links_rollups WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, id),
    DB.prepare('DELETE FROM links_reports WHERE org_id = ?1 AND target_id = ?2').bind(ctx.orgId, id),
    DB.prepare('DELETE FROM links_links WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
  ];
}

export async function deleteLink(ctx: LinksCtx, idOrCode: string): Promise<{ id: string; code: string }> {
  const row = await getLinkRow(ctx, idOrCode);
  await ctx.env.DB.batch(deleteStatements(ctx, row.id));
  await bust(ctx.env, row.code);
  await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.deleted', subject: row.id, data: { code: row.code } });
  return { id: row.id, code: row.code };
}

/** Switch a link off because its destination is on the blocklist (or an admin acted on a report). */
export async function disableLink(ctx: LinksCtx, id: string, reason: string): Promise<void> {
  const row = await getLinkRow(ctx, id);
  await ctx.env.DB.prepare(`UPDATE links_links SET status = 'disabled', disabled_reason = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2`)
    .bind(ctx.orgId, id, reason, Date.now())
    .run();
  await bust(ctx.env, row.code);
  await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.updated', subject: id, data: { code: row.code, changed: ['status'] } });
}

export interface BulkResult {
  done: number;
  skipped: number;
}

/** Archive, restore, delete, tag, untag or move up to 200 links at once. Ids from other workspaces are skipped. */
export async function bulkAction(ctx: LinksCtx, raw: unknown): Promise<BulkResult> {
  const input = parse(bulkActionSchema, raw);
  const ids = [...new Set(input.ids)];
  const { results } = await ctx.env.DB.prepare(`SELECT id, code FROM links_links WHERE org_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`)
    .bind(ctx.orgId, ...ids)
    .all<{ id: string; code: string }>();
  const { DB } = ctx.env;
  const found = results;
  const now = Date.now();
  const stmts: D1[] = [];
  if (input.action === 'tag' || input.action === 'untag') {
    if (!input.tag) throw errors.validation_failed('Pick a tag.', { tag: 'Pick a tag.' });
    for (const r of found) {
      stmts.push(
        input.action === 'tag'
          ? DB.prepare('INSERT OR IGNORE INTO links_link_tags (org_id, link_id, tag) VALUES (?1, ?2, ?3)').bind(ctx.orgId, r.id, input.tag)
          : DB.prepare('DELETE FROM links_link_tags WHERE org_id = ?1 AND link_id = ?2 AND tag = ?3').bind(ctx.orgId, r.id, input.tag),
      );
    }
  } else if (input.action === 'move') {
    const folder = input.folderId ?? null;
    if (folder && !(await folderExists(ctx, folder))) throw linkErrors.folder_not_found();
    for (const r of found) stmts.push(DB.prepare('UPDATE links_links SET folder_id = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, r.id, folder, now));
  } else if (input.action === 'delete') {
    for (const r of found) stmts.push(...deleteStatements(ctx, r.id));
  } else {
    const status = input.action === 'archive' ? 'archived' : 'active';
    for (const r of found) {
      stmts.push(DB.prepare(`UPDATE links_links SET status = ?3, disabled_reason = CASE WHEN ?3 = 'active' THEN NULL ELSE disabled_reason END, updated_at = ?4 WHERE org_id = ?1 AND id = ?2`).bind(ctx.orgId, r.id, status, now));
    }
  }
  // D1 batches have a limit on statements; chunk so a big delete still goes through.
  for (let i = 0; i < stmts.length; i += 90) await DB.batch(stmts.slice(i, i + 90));
  if (found.length) await bust(ctx.env, ...found.map((r) => r.code));
  const name = input.action === 'delete' ? 'link.deleted' : 'link.updated';
  for (const r of found) await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name, subject: r.id, data: { code: r.code, bulk: input.action } });
  return { done: found.length, skipped: ids.length - found.length };
}

export interface BulkCreateResult {
  created: LinkView[];
  errors: { index: number; code: string; message: string }[];
}

/** Create up to 100 links. Items that fail are reported by position; the rest are still created. */
export async function bulkCreate(ctx: LinksCtx, items: unknown[]): Promise<BulkCreateResult> {
  if (items.length > 100) throw linkErrors.bulk_too_large();
  const out: BulkCreateResult = { created: [], errors: [] };
  const settings = await getSettings(ctx.env, ctx.orgId);
  const blocked = await blockedDomains(ctx.env, ctx.orgId);
  // Check the codes people picked in one query, so a typo in item 40 doesn't cost 40 round trips.
  const wanted = items.map((i) => (typeof (i as { code?: unknown })?.code === 'string' ? String((i as { code: string }).code).trim().toLowerCase() : '')).filter(Boolean);
  const taken = new Set<string>();
  if (wanted.length) {
    const { results } = await ctx.env.DB.prepare(`SELECT code FROM links_slugs WHERE code IN (${wanted.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...wanted).all<{ code: string }>();
    for (const r of results) taken.add(r.code);
  }
  const seen = new Set<string>();
  for (const [index, raw] of items.entries()) {
    try {
      const input = parse(createLinkSchema, raw);
      const custom = input.code ? normalizeCode(input.code) : null;
      if (custom && (taken.has(custom) || seen.has(custom))) throw linkErrors.code_taken(undefined, { code: linkErrors.code_taken().message });
      const p = await prepare(ctx, input, blocked);
      const code = custom ?? (await freeRandomCode(ctx, settings.codeLength));
      const row = baseRow(ctx, code, p, { redirect: settings.defaultRedirectType }, Date.now());
      await ctx.env.DB.batch(linkStatements(ctx, row, p._tags ?? []));
      seen.add(code);
      out.created.push((await hydrate(ctx, [row]))[0]!);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      out.errors.push({ index, code: err.code ?? 'bad_request', message: err.message ?? 'That link could not be created.' });
    }
  }
  if (out.created.length) {
    await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.created', subject: out.created[0]!.id, count: out.created.length, data: { bulk: true, count: out.created.length } });
  }
  return out;
}

export { isReserved, hostOf, matchBlocked };
