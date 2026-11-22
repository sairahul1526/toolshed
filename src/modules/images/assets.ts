/** Uploaded pictures and fonts. The files live in the shared bucket, one row each in `img_assets`. */
import { encodeRanges, FontError, parseFont } from '../../../public/m/images/engine/index.js';
import type { OrgDb } from '../../core/db';
import { newId, parseJson } from '../../core/db';
import { errors } from '../../core/errors';
import { moduleState } from '../../core/registry';
import type { Env } from '../../env';
import { imageErrors } from './errors';
import { assetKey } from './keys';
import { customFamilyId, MAX_FONT_BYTES, MAX_PICTURE_BYTES, type FontMeta } from './render';
import { sniffImage } from './sniff';
import { pageOf, type Actor, type Page } from './templates';

export const MAX_ASSETS = 200;
export const MAX_ASSET_STORAGE = 100 * 1024 * 1024;
/** A larger picture would need more memory than a Worker has once it is decoded for a PNG. */
export const MAX_PICTURE_SIDE = 4096;

export interface AssetRow {
  id: string;
  org_id: string;
  kind: 'image' | 'font';
  name: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  meta: string | null;
  sample: number;
  created_by: string | null;
  created_at: number;
}

export interface Asset {
  id: string;
  kind: 'image' | 'font';
  name: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** What a picture layer's `src` holds to use this file. */
  ref: string;
  /** Fonts only: the family as a text layer names it, and what the file covers. */
  font: (FontMeta & { id: string; variable: boolean }) | null;
  /** Path of the public copy. Anyone who has it can download the file. */
  path: string;
  createdAt: number;
}

export function toAsset(row: AssetRow): Asset {
  const meta = row.kind === 'font' ? parseJson<(FontMeta & { variable?: boolean }) | null>(row.meta, null) : null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    ref: `asset:${row.id}`,
    font: meta ? { id: customFamilyId(meta.family), family: meta.family, style: meta.style, weight: meta.weight, ranges: meta.ranges, variable: meta.variable === true } : null,
    path: `/i/a/${row.id}`,
    createdAt: row.created_at,
  };
}

function looksLikeFont(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return tag === 'OTTO' || tag === 'true' || tag === 'wOFF' || tag === 'wOF2' || tag === 'ttcf' || tag === '\u0000\u0001\u0000\u0000';
}

function cleanName(name: string | undefined, fallback: string): string {
  const text = (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^.*[\\/]/, '')
    .trim()
    .slice(0, 120);
  return text || fallback;
}

export interface Upload {
  name?: string;
  bytes: Uint8Array;
}

/**
 * Stores a picture or a font. What the file is comes from its own bytes, never from its name or
 * the type the sender claimed. Fonts are read in full first, so one that cannot be drawn is refused here.
 */
export async function uploadAsset(env: Env, db: OrgDb, upload: Upload, actor: Actor = {}, now = Date.now(), extras: { sample?: boolean } = {}): Promise<Asset> {
  const { bytes } = upload;
  if (bytes.byteLength === 0) throw errors.validation_failed('Choose a file to upload.', { file: 'Choose a file to upload.' });
  const picture = sniffImage(bytes);
  const row: Record<string, unknown> = { id: newId('imga', now), bytes: bytes.byteLength, sample: extras.sample ? 1 : 0, created_by: actor.id ?? null, created_at: now };

  if (picture) {
    if (bytes.byteLength > MAX_PICTURE_BYTES) throw errors.too_large('Pictures can be 2 MB at most. Make it smaller and try again.');
    if (picture.width > MAX_PICTURE_SIDE || picture.height > MAX_PICTURE_SIDE) throw errors.too_large(`Pictures can be ${MAX_PICTURE_SIDE} px on each side at most.`);
    Object.assign(row, { kind: 'image', name: cleanName(upload.name, `picture.${picture.ext}`), content_type: picture.type, width: picture.width, height: picture.height });
  } else if (looksLikeFont(bytes)) {
    if (bytes.byteLength > MAX_FONT_BYTES) throw errors.too_large('Font files can be 5 MB at most.');
    try {
      const font = parseFont(bytes);
      const meta: FontMeta & { variable: boolean } = { family: font.family.slice(0, 80) || 'Font', style: font.style.slice(0, 40), weight: font.weight, ranges: encodeRanges(font.coverage()), variable: font.variable };
      Object.assign(row, { kind: 'font', name: cleanName(upload.name, `${meta.family}.ttf`), content_type: 'font/ttf', meta: JSON.stringify(meta) });
    } catch (err) {
      throw imageErrors.bad_font(err instanceof FontError ? err.message : undefined);
    }
  } else {
    throw imageErrors.unsupported_file();
  }

  const used = await db.first<{ n: number; total: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS total FROM img_assets WHERE org_id = :org');
  if ((used?.n ?? 0) >= MAX_ASSETS || (used?.total ?? 0) + bytes.byteLength > MAX_ASSET_STORAGE) throw imageErrors.storage_full();

  await env.FILES.put(assetKey(db.orgId, String(row.id)), bytes, { httpMetadata: { contentType: String(row.content_type) } });
  return toAsset(await db.insert<AssetRow>('img_assets', row));
}

export async function listAssets(db: OrgDb, opts: { kind?: 'image' | 'font'; limit?: number; cursor?: string | null } = {}): Promise<Page<Asset>> {
  const page = await pageOf<AssetRow>(db, 'img_assets', { limit: opts.limit, cursor: opts.cursor, and: opts.kind ? 'kind = ?' : undefined, params: opts.kind ? [opts.kind] : [] });
  return { items: page.items.map(toAsset), nextCursor: page.nextCursor };
}

export async function getAsset(db: OrgDb, id: string): Promise<Asset> {
  const row = await db.get<AssetRow>('img_assets', id);
  if (!row) throw errors.not_found('We couldn’t find that file. It may have been deleted.');
  return toAsset(row);
}

/** Deletes a file. Templates that use it keep working and show an empty box where it was. */
export async function deleteAsset(env: Env, db: OrgDb, id: string): Promise<Asset> {
  const asset = await getAsset(db, id);
  await db.remove('img_assets', id);
  await env.FILES.delete(assetKey(db.orgId, id));
  return asset;
}

export interface PublicFile {
  body: ReadableStream;
  contentType: string;
  bytes: number;
}

/** The public copy of an uploaded file, found by its id alone. Null when it is gone or the module is off. */
export async function publicAsset(env: Env, id: string): Promise<PublicFile | null> {
  if (!/^imga_[a-z0-9]{22}$/.test(id)) return null;
  const row = await env.DB.prepare('SELECT org_id, content_type, bytes FROM img_assets WHERE id = ?1').bind(id).first<Pick<AssetRow, 'org_id' | 'content_type' | 'bytes'>>();
  if (!row || !(await moduleState(env, row.org_id, 'images')).enabled) return null;
  const object = await env.FILES.get(assetKey(row.org_id, id));
  return object ? { body: object.body, contentType: row.content_type, bytes: object.size } : null;
}
