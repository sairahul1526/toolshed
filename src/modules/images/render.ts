/**
 * The Worker's side of the render engine: it hands the engine the fonts and pictures a template
 * asks for. Bundled fonts come from the static files, uploads from the workspace's own storage.
 * A picture is embedded in the image, never linked, so the finished file needs no network.
 */
import {
  buildCatalog,
  draw,
  parseFont,
  type Catalog,
  type CatalogFamily,
  type EngineFont,
  type RenderResult,
} from '../../../public/m/images/engine/index.js';
import type { OrgDb } from '../../core/db';
import { parseJson } from '../../core/db';
import { safeFetch } from '../../core/net';
import type { Env } from '../../env';
import { assetKey, remoteKey } from './keys';
import type { TemplateDoc } from './schema';
import { sha256Hex, sniffImage, toBase64 } from './sniff';

export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
export const MAX_FONT_BYTES = 5 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 5000;
/** Parsed fonts stay in memory between requests on the same isolate, up to this many bytes. */
const FONT_CACHE_BYTES = 24 * 1024 * 1024;
const BUNDLED_FONT = /^[a-z0-9-]+\/[a-z0-9-]+\.ttf$/;
const ASSET_REF = /^asset:([a-z0-9_]{4,64})$/;

const fontCache = new Map<string, { font: EngineFont; bytes: number }>();
let fontCacheBytes = 0;

function remember(cacheKey: string, font: EngineFont, bytes: number): void {
  fontCache.set(cacheKey, { font, bytes });
  fontCacheBytes += bytes;
  // Maps keep insertion order, so the first key is the one used longest ago.
  for (const [oldest, entry] of fontCache) {
    if (fontCacheBytes <= FONT_CACHE_BYTES || oldest === cacheKey) break;
    fontCache.delete(oldest);
    fontCacheBytes -= entry.bytes;
  }
}

async function loadFont(env: Env, orgId: string, key: string): Promise<EngineFont | null> {
  const asset = ASSET_REF.exec(key);
  const cacheKey = asset ? `${orgId}/${key}` : key;
  const hit = fontCache.get(cacheKey);
  if (hit) {
    fontCache.delete(cacheKey);
    fontCache.set(cacheKey, hit);
    return hit.font;
  }
  let data: ArrayBuffer | null = null;
  if (asset) {
    const object = await env.FILES.get(assetKey(orgId, asset[1]!));
    if (object && object.size <= MAX_FONT_BYTES) data = await object.arrayBuffer();
  } else if (BUNDLED_FONT.test(key)) {
    const res = await env.ASSETS.fetch(new Request(`https://assets.invalid/m/images/fonts/${key}`));
    if (res.ok) data = await res.arrayBuffer();
  }
  if (!data) return null;
  try {
    const font = parseFont(data);
    remember(cacheKey, font, data.byteLength);
    return font;
  } catch {
    return null;
  }
}

function dataUri(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${toBase64(bytes)}`;
}

/** True when a template may load pictures from this address: https, and a site the workspace allowed. */
export function hostAllowed(src: string, allowedHosts: string[]): boolean {
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && allowedHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface Picture {
  type: string;
  bytes: Uint8Array;
}

/**
 * One picture for a layer: an upload, or an outside address fetched once and then kept in storage.
 * Returns null when it is missing, not a picture, too large, or from a site that is not allowed.
 */
export async function loadPicture(env: Env, orgId: string, src: string, allowedHosts: string[]): Promise<Picture | null> {
  const asset = ASSET_REF.exec(src);
  if (asset) {
    const object = await env.FILES.get(assetKey(orgId, asset[1]!));
    if (!object || object.size > MAX_PICTURE_BYTES) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const kind = sniffImage(bytes);
    return kind ? { type: kind.type, bytes } : null;
  }
  if (!hostAllowed(src, allowedHosts)) return null;
  const key = remoteKey(orgId, await sha256Hex(src));
  const kept = await env.FILES.get(key);
  if (kept) {
    const bytes = new Uint8Array(await kept.arrayBuffer());
    const kind = sniffImage(bytes);
    return kind ? { type: kind.type, bytes } : null;
  }
  try {
    const res = await safeFetch(src, { timeoutMs: REMOTE_TIMEOUT_MS, maxBytes: MAX_PICTURE_BYTES, headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const kind = sniffImage(bytes);
    if (!kind) return null;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: kind.type } });
    return { type: kind.type, bytes };
  } catch {
    return null;
  }
}

interface FontAssetRow {
  id: string;
  meta: string | null;
}

export interface FontMeta {
  family: string;
  style: string;
  weight: number;
  ranges: string;
}

/** The id a template uses for an uploaded font family: every file with the same family name is one family. */
export function customFamilyId(family: string): string {
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `c:${slug || 'font'}`;
}

/** The workspace's uploaded fonts, grouped into families the engine can pick from. */
export async function customFamilies(db: OrgDb): Promise<CatalogFamily[]> {
  const rows = await db.all<FontAssetRow>(`SELECT id, meta FROM img_assets WHERE org_id = :org AND kind = 'font' ORDER BY id LIMIT 200`);
  const families = new Map<string, CatalogFamily>();
  for (const row of rows) {
    const meta = parseJson<FontMeta | null>(row.meta, null);
    if (!meta?.family || !meta.ranges) continue;
    const id = customFamilyId(meta.family);
    let family = families.get(id);
    if (!family) {
      family = { id, name: meta.family, kind: 'custom', faces: [] };
      families.set(id, family);
    }
    const file = { key: `asset:${row.id}`, ranges: meta.ranges };
    const face = family.faces.find((x) => x.weight === meta.weight);
    if (face) face.files.push(file);
    else family.faces.push({ weight: meta.weight, files: [file] });
  }
  return [...families.values()];
}

function usesCustomFont(doc: TemplateDoc): boolean {
  return doc.layers.some((layer) => layer.type === 'text' && layer.font?.startsWith('c:'));
}

/** The fonts a template can use. Uploaded fonts cost a database read, so they load only when asked for. */
export async function catalogFor(db: OrgDb, doc: TemplateDoc): Promise<Catalog> {
  return buildCatalog(usesCustomFont(doc) ? await customFamilies(db) : []);
}

export interface DrawOptions {
  /** Output width in pixels. The height follows the template's shape. */
  width?: number;
  allowedHosts: string[];
}

/** Draws a template with the given field values and returns the SVG and anything worth warning about. */
export async function drawTemplate(env: Env, db: OrgDb, doc: TemplateDoc, values: Record<string, string>, opts: DrawOptions): Promise<RenderResult> {
  const catalog = await catalogFor(db, doc);
  return draw(doc as unknown as Record<string, unknown>, values, {
    catalog,
    width: opts.width,
    font: (key) => loadFont(env, db.orgId, key),
    image: async (src) => {
      const picture = await loadPicture(env, db.orgId, src, opts.allowedHosts);
      return picture ? dataUri(picture.type, picture.bytes) : null;
    },
  });
}
