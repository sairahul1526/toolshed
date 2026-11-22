import { newId } from '../../core/db';
import { z } from 'zod';
import { errors, parse } from '../../core/errors';
import { linkErrors } from './errors';
import { type LinksCtx } from './types';

export interface Folder {
  id: string;
  name: string;
  links: number;
}

const nameSchema = z.object({ name: z.string().trim().min(1, 'Give the folder a name.').max(60) });

export async function listFolders(ctx: LinksCtx): Promise<Folder[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT f.id, f.name, (SELECT COUNT(*) FROM links_links l WHERE l.folder_id = f.id AND l.status <> 'archived') AS links
     FROM links_folders f WHERE f.org_id = ?1 ORDER BY lower(f.name)`,
  )
    .bind(ctx.orgId)
    .all<Folder>();
  return results;
}

export async function createFolder(ctx: LinksCtx, raw: unknown): Promise<Folder> {
  const { name } = parse(nameSchema, raw);
  const id = newId('fld');
  try {
    await ctx.env.DB.prepare('INSERT INTO links_folders (id, org_id, name, created_at) VALUES (?1, ?2, ?3, ?4)').bind(id, ctx.orgId, name, Date.now()).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw errors.conflict('You already have a folder with that name.', { name: 'You already have a folder with that name.' });
    throw e;
  }
  return { id, name, links: 0 };
}

export async function renameFolder(ctx: LinksCtx, id: string, raw: unknown): Promise<void> {
  const { name } = parse(nameSchema, raw);
  try {
    const res = await ctx.env.DB.prepare('UPDATE links_folders SET name = ?3 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id, name).run();
    if (!res.meta.changes) throw linkErrors.folder_not_found();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw errors.conflict('You already have a folder with that name.', { name: 'You already have a folder with that name.' });
    throw e;
  }
}

/** Delete a folder. Its links stay, moved out of any folder. */
export async function deleteFolder(ctx: LinksCtx, id: string): Promise<void> {
  const [, res] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE links_links SET folder_id = NULL WHERE org_id = ?1 AND folder_id = ?2').bind(ctx.orgId, id),
    ctx.env.DB.prepare('DELETE FROM links_folders WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
  ]);
  if (!res!.meta.changes) throw linkErrors.folder_not_found();
}

export async function folderExists(ctx: LinksCtx, id: string): Promise<boolean> {
  const row = await ctx.env.DB.prepare('SELECT 1 AS x FROM links_folders WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id).first();
  return !!row;
}
