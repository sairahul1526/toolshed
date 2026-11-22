/**
 * Making and serving images.
 *
 *   serveByUrl       GET /i/<slug>.<svg|png>: storage first, drawn on the first request
 *   renderToStorage  the API and batches: draw now, keep the file, hand back its URL
 *   bakePng          a PNG drawn in someone's browser, checked and stored under the same name
 *   previewSvg       the editor's preview of a draft: drawn every time, never stored or counted
 */
import type { OrgDb } from '../../core/db';
import { orgDb, parseJson } from '../../core/db';
import { AppError, errors } from '../../core/errors';
import { emit } from '../../core/events';
import { once } from '../../core/jobs';
import { enforceRateLimit } from '../../core/ratelimit';
import { moduleState } from '../../core/registry';
import type { Env } from '../../env';
import { imageErrors } from './errors';
import { renderKey } from './keys';
import { svgToPng } from './png';
import { drawTemplate } from './render';
import { docSchema, RESERVED_PARAMS, type TemplateDoc } from './schema';
import { getSettings, type ImageSettings } from './settings';
import { sniffImage } from './sniff';
import { templateRow, type TemplateRow } from './templates';
import { checkSignature, clampWidth, CONTENT_TYPES, describeQuery, heightFor, imageUrl, normaliseValues, positiveInt, renderHash, type Format } from './urls';
import { dayOf, recordFailure, recordHit, recordRender, rendersToday, type RenderSource } from './usage';

export const MAX_BAKE_BYTES = 5 * 1024 * 1024;
/** New images one visitor may start per minute on a template that renders without a signature. */
export const OPEN_RATE = { limit: 30, windowSec: 60 };
const HOUR = 3600;
const YEAR = 31_536_000;
const NO_IMAGE = 'There is no image at this address.';

/** A finished image never needs the network or scripts, so the browser is told to allow neither. */
const SVG_HEADERS = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };

export type Defer = (work: Promise<unknown>) => void;

export interface UrlRequest {
  slug: string;
  format: Format;
  query: URLSearchParams;
  ifNoneMatch: string | null;
  /** A hashed id for whoever is asking, worked out only when a rate limit needs it. */
  visitor: () => Promise<string>;
}

export interface ServedImage {
  status: 200 | 304;
  headers: Record<string, string>;
  body: ReadableStream | Uint8Array | string | null;
}

function publishedDoc(row: TemplateRow): TemplateDoc {
  if (row.published_doc === null) throw imageErrors.not_published();
  const checked = docSchema.safeParse(parseJson<unknown>(row.published_doc, null));
  if (!checked.success) throw imageErrors.render_failed('This template’s saved design is not valid. Open it in the editor, fix what it flags, and publish again.');
  return checked.data;
}

function queryValues(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of query) if (!(key in out) && !RESERVED_PARAMS.includes(key)) out[key] = value;
  return out;
}

async function quotaReached(env: Env, orgId: string, data: { kind: 'daily' | 'template'; limit: number; templateId?: string }, now: number): Promise<void> {
  const key = `images:quota:${orgId}:${data.kind}:${data.templateId ?? ''}:${dayOf(now)}`;
  await once(env, key, 24 * HOUR, () => emit(env, { orgId, module: 'images', name: 'quota.reached', subject: data.templateId, data, at: now }));
}

/** Refuses a new image when the workspace or the template has used up its allowance. */
async function checkCaps(env: Env, db: OrgDb, row: TemplateRow, settings: ImageSettings, defer: Defer, now: number): Promise<void> {
  if (row.max_renders !== null && row.renders >= row.max_renders) {
    defer(quotaReached(env, db.orgId, { kind: 'template', limit: row.max_renders, templateId: row.id }, now));
    throw imageErrors.template_cap();
  }
  if ((await rendersToday(db, now)) >= settings.dailyCap) {
    defer(quotaReached(env, db.orgId, { kind: 'daily', limit: settings.dailyCap }, now));
    throw imageErrors.daily_cap();
  }
}

interface Drawn {
  body: Uint8Array | string;
  bytes: number;
  warnings: string[];
  ms: number;
}

/** Draws one image. A failure is logged against the template and comes back as `render_failed`. */
async function drawImage(env: Env, db: OrgDb, row: TemplateRow, doc: TemplateDoc, values: Record<string, string>, format: Format, width: number, settings: ImageSettings, source: RenderSource, now: number): Promise<Drawn> {
  // The clock a Worker sees only moves when it waits on the network, so this is time spent waiting, not CPU time.
  const started = Date.now();
  try {
    const result = await drawTemplate(env, db, doc, values, { width: width === doc.width ? undefined : width, allowedHosts: settings.allowedHosts });
    const body = format === 'png' ? await svgToPng(result.svg, width) : result.svg;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
    return { body, bytes, warnings: [...new Set(result.warnings.map((w) => w.code))], ms: Date.now() - started };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    await recordFailure(env, { orgId: db.orgId, templateId: row.id, format, source, code: 'images.render_failed', detail }, now);
    throw imageErrors.render_failed();
  }
}

function store(env: Env, orgId: string, hash: string, format: Format, body: Uint8Array | string): Promise<unknown> {
  return env.FILES.put(renderKey(orgId, hash, format), body, { httpMetadata: { contentType: CONTENT_TYPES[format] } });
}

/**
 * One image by URL. A hit costs two database reads, one file read and one small write after the
 * response. Only a miss reads settings, checks limits and draws.
 */
export async function serveByUrl(env: Env, req: UrlRequest, defer: Defer, now = Date.now()): Promise<ServedImage> {
  const row = await env.DB.prepare('SELECT * FROM img_templates WHERE slug = ?1').bind(req.slug).first<TemplateRow>();
  if (!row || !(await moduleState(env, row.org_id, 'images')).enabled) throw errors.not_found(NO_IMAGE);
  const doc = publishedDoc(row);

  const signature = await checkSignature(env, req.slug, req.query);
  if (signature === 'bad') throw imageErrors.bad_signature();
  if (signature === 'missing' && row.open !== 1) throw imageErrors.signature_required();
  const signed = signature === 'ok';
  const expires = signed ? positiveInt(req.query.get('exp')) : null;
  if (expires !== null && expires * 1000 <= now) throw imageErrors.link_expired();

  const values = normaliseValues(doc, queryValues(req.query), { remotePictures: signed });
  const width = clampWidth(req.query.get('w'), doc.width);
  const pinned = positiveInt(req.query.get('v'));
  let version = pinned !== null && pinned <= row.version ? pinned : row.version;
  let hash = await renderHash(row.id, version, req.format, width, values);

  const headers = (age: number, cache: 'hit' | 'miss'): Record<string, string> => {
    const left = expires === null ? age : Math.max(0, Math.min(age, expires - Math.floor(now / 1000)));
    return {
      'content-type': CONTENT_TYPES[req.format],
      'cache-control': `public, max-age=${left}${left === YEAR ? ', immutable' : ''}`,
      etag: `"${hash}"`,
      'x-content-type-options': 'nosniff',
      'x-images-cache': cache,
      ...(req.format === 'svg' ? SVG_HEADERS : {}),
    };
  };
  // A URL that pins a version always shows the same picture, so it can be kept for a year.
  const age = () => (pinned !== null && pinned === version ? YEAR : HOUR);
  const hit = { orgId: row.org_id, templateId: row.id, hash, first: row.first_request_at === null };

  if (req.ifNoneMatch !== null && req.ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${hash}"`)) {
    defer(recordHit(env, hit, now));
    return { status: 304, headers: headers(age(), 'hit'), body: null };
  }

  let object = await env.FILES.get(renderKey(row.org_id, hash, req.format));
  if (!object && version < row.version) {
    // The stored file for an older version is gone and its design was not kept: draw the current one.
    version = row.version;
    hash = await renderHash(row.id, version, req.format, width, values);
    object = await env.FILES.get(renderKey(row.org_id, hash, req.format));
  }
  if (object) {
    defer(recordHit(env, { ...hit, hash }, now));
    return { status: 200, headers: { ...headers(age(), 'hit'), 'content-length': String(object.size) }, body: object.body };
  }

  const db = orgDb(env.DB, row.org_id);
  const settings = await getSettings(env, row.org_id);
  if (req.format === 'png' && !settings.serverPng) throw imageErrors.png_needs_bake();
  if (!signed) await enforceRateLimit(env, `images:new:${await req.visitor()}`, OPEN_RATE, 'Too many new images from this connection. Wait a minute, then try again.');
  await checkCaps(env, db, row, settings, defer, now);

  const drawn = await drawImage(env, db, row, doc, values, req.format, width, settings, 'url', now);
  defer(
    Promise.all([
      store(env, row.org_id, hash, req.format, drawn.body),
      recordRender(env, { orgId: row.org_id, templateId: row.id, hash, format: req.format, width, version, query: describeQuery(values, width, doc.width), bytes: drawn.bytes, source: 'url', ms: drawn.ms }, now),
    ]),
  );
  return {
    status: 200,
    headers: { ...headers(age(), 'miss'), ...(drawn.warnings.length ? { 'x-images-warnings': drawn.warnings.join(',') } : {}) },
    body: drawn.body,
  };
}

export interface StoreRequest {
  values?: Record<string, unknown>;
  format: Format;
  width?: number;
  source: 'api' | 'batch';
  /** The site address the returned URL starts with. */
  base: string;
}

export interface StoredImage {
  url: string;
  hash: string;
  format: Format;
  width: number;
  height: number;
  bytes: number;
  /** True when the image was already in storage and nothing new was drawn. */
  cached: boolean;
  warnings: string[];
}

/** Draws an image now (or finds it in storage) and returns a signed URL that always shows this version. */
export async function renderToStorage(env: Env, db: OrgDb, templateId: string, req: StoreRequest, now = Date.now()): Promise<StoredImage> {
  const row = await templateRow(db, templateId);
  const doc = publishedDoc(row);
  const values = normaliseValues(doc, req.values ?? {});
  const width = clampWidth(req.width, doc.width);
  const hash = await renderHash(row.id, row.version, req.format, width, values);
  const url = await imageUrl(env, req.base, row.slug, req.format, { values, width: width === doc.width ? undefined : width, version: row.version });
  const image = { url, hash, format: req.format, width, height: heightFor(doc, width) };

  const kept = await env.FILES.head(renderKey(db.orgId, hash, req.format));
  if (kept) return { ...image, bytes: kept.size, cached: true, warnings: [] };

  const settings = await getSettings(env, db.orgId);
  if (req.format === 'png' && !settings.serverPng) throw imageErrors.server_png_off();
  const later: Promise<unknown>[] = [];
  try {
    await checkCaps(env, db, row, settings, (work) => void later.push(work), now);
  } finally {
    await Promise.all(later);
  }
  const drawn = await drawImage(env, db, row, doc, values, req.format, width, settings, req.source, now);
  await store(env, db.orgId, hash, req.format, drawn.body);
  await recordRender(env, { orgId: db.orgId, templateId: row.id, hash, format: req.format, width, version: row.version, query: describeQuery(values, width, doc.width), bytes: drawn.bytes, source: req.source, ms: drawn.ms }, now);
  await emit(env, {
    orgId: db.orgId,
    module: 'images',
    name: 'render.completed',
    subject: row.id,
    data: { templateId: row.id, slug: row.slug, format: req.format, width, bytes: drawn.bytes, url, source: req.source },
    at: now,
  });
  return { ...image, bytes: drawn.bytes, cached: false, warnings: drawn.warnings };
}

export interface BakeRequest {
  values?: Record<string, unknown>;
  width?: number;
  base: string;
}

/**
 * Stores a PNG that was drawn in the browser, under the name the image URL already looks for.
 * This is how a workspace on the free Workers plan gets PNG share images.
 */
export async function bakePng(env: Env, db: OrgDb, templateId: string, png: Uint8Array, req: BakeRequest, now = Date.now()): Promise<StoredImage> {
  const row = await templateRow(db, templateId);
  const doc = publishedDoc(row);
  if (png.byteLength > MAX_BAKE_BYTES) throw errors.too_large('That PNG is larger than 5 MB. Use a smaller width.');
  const values = normaliseValues(doc, req.values ?? {});
  const width = clampWidth(req.width, doc.width);
  const height = heightFor(doc, width);
  const found = sniffImage(png);
  if (!found || found.type !== 'image/png' || found.width !== width || found.height !== height) {
    throw imageErrors.bad_png(`That file is not a ${width} × ${height} PNG, which is what this template needs.`);
  }
  const hash = await renderHash(row.id, row.version, 'png', width, values);
  const url = await imageUrl(env, req.base, row.slug, 'png', { values, width: width === doc.width ? undefined : width, version: row.version });
  const image = { url, hash, format: 'png' as const, width, height, bytes: png.byteLength, warnings: [] };

  if (await env.FILES.head(renderKey(db.orgId, hash, 'png'))) {
    // Making the same image again replaces the file and does not use up the day's allowance.
    await store(env, db.orgId, hash, 'png', png);
    await db.run(`UPDATE img_renders SET bytes = ?, source = 'bake' WHERE org_id = :org AND hash = ?`, png.byteLength, hash);
    return { ...image, cached: true };
  }
  const later: Promise<unknown>[] = [];
  try {
    await checkCaps(env, db, row, await getSettings(env, db.orgId), (work) => void later.push(work), now);
  } finally {
    await Promise.all(later);
  }
  await store(env, db.orgId, hash, 'png', png);
  await recordRender(env, { orgId: db.orgId, templateId: row.id, hash, format: 'png', width, version: row.version, query: describeQuery(values, width, doc.width), bytes: png.byteLength, source: 'bake', ms: 0 }, now);
  return { ...image, cached: false };
}

/** Draws a design as SVG without storing or counting it. Used for previews in the dashboard. */
export async function previewSvg(env: Env, db: OrgDb, doc: TemplateDoc, values: Record<string, unknown> = {}, width?: number): Promise<{ svg: string; warnings: { layer: string; code: string; detail?: string }[] }> {
  const settings = await getSettings(env, db.orgId);
  const result = await drawTemplate(env, db, doc, normaliseValues(doc, values), { width: width ? clampWidth(width, doc.width) : undefined, allowedHosts: settings.allowedHosts });
  return { svg: result.svg, warnings: result.warnings };
}
