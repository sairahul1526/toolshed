/**
 * Image URLs: which parameters count, how a URL is signed, and the key a finished image is stored
 * under. A URL looks like /i/<slug>.png?title=Hello&w=600&v=3&exp=1767225600&sig=...
 *
 *   w    output width in pixels
 *   v    template version to pin (the image then never changes)
 *   exp  Unix time in seconds after which a signed URL stops working
 *   sig  signature over the slug and every other parameter
 */
import { isColor } from '../../../public/m/images/engine/index.js';
import { sign, verify } from '../../core/signing';
import type { Env } from '../../env';
import { MAX_CANVAS, MAX_TEXT, MIN_CANVAS, type TemplateDoc } from './schema';
import { sha256Hex } from './sniff';

export const RENDER_PURPOSE = 'images.render';
export const FORMATS = ['svg', 'png'] as const;
export type Format = (typeof FORMATS)[number];
export const CONTENT_TYPES: Record<Format, string> = { svg: 'image/svg+xml; charset=utf-8', png: 'image/png' };

const PICTURE_VALUE = /^(?:asset:[a-z0-9_]{4,64}|https:\/\/[^\s"'<>]{4,580})$/;

/** The query string a stored image is listed under: its values and width, without the signature. */
export function describeQuery(values: Record<string, string>, width: number, docWidth: number): string {
  const query = new URLSearchParams(values);
  if (width !== docWidth) query.set('w', String(width));
  return query.toString();
}

/**
 * Keeps only the template's own fields, as clean strings, and drops anything equal to the default.
 * Two URLs that draw the same picture then share one stored image.
 */
export function normaliseValues(doc: TemplateDoc, input: Record<string, unknown>, opts: { remotePictures?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of doc.fields) {
    const raw = input[field.name];
    if (raw === undefined || raw === null) continue;
    let value = String(raw);
    if (field.type === 'color') {
      value = value.trim().toLowerCase();
      if (!isColor(value)) continue;
    } else if (field.type === 'image') {
      value = value.trim();
      if (value !== '' && !PICTURE_VALUE.test(value)) continue;
      // Only a signed URL may point a picture at an outside address; an open one is limited to uploads.
      if (opts.remotePictures === false && value.startsWith('https://')) continue;
    } else {
      const cap = Math.min(MAX_TEXT, field.maxLength ?? 500);
      if (value.length > cap) value = Array.from(value).slice(0, cap).join('');
    }
    if (value !== field.default) out[field.name] = value;
  }
  return out;
}

/** The output width asked for, kept inside what the module will draw. */
export function clampWidth(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_CANVAS, Math.max(MIN_CANVAS, Math.round(n)));
}

export function heightFor(doc: TemplateDoc, width: number): number {
  return Math.max(1, Math.round((width * doc.height) / doc.width));
}

/** A whole number of 1 or more, or null. Used for `v` and `exp`. */
export function positiveInt(raw: unknown): number | null {
  const text = String(raw ?? '');
  if (!/^[0-9]{1,15}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/** What gets signed: the slug and every parameter except the signature, in a fixed order. */
export function canonicalQuery(slug: string, query: URLSearchParams): string {
  const seen = new Map<string, string>();
  for (const [key, value] of query) if (key !== 'sig' && !seen.has(key)) seen.set(key, value);
  const pairs = [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${slug}?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

export async function checkSignature(env: Env, slug: string, query: URLSearchParams): Promise<'ok' | 'missing' | 'bad'> {
  const sig = query.get('sig');
  if (!sig) return 'missing';
  return (await verify(env, RENDER_PURPOSE, canonicalQuery(slug, query), sig)) ? 'ok' : 'bad';
}

export interface UrlOptions {
  values?: Record<string, string>;
  /** Leave out for the template's own width. */
  width?: number;
  /** Pin a version, so the image never changes. */
  version?: number;
  /** Unix time in seconds. */
  expires?: number;
  /** Leave the signature off. Only works while the template is open. */
  unsigned?: boolean;
}

/** A full image URL for a template. `values` must already be normalised. */
export async function imageUrl(env: Env, base: string, slug: string, format: Format, opts: UrlOptions = {}): Promise<string> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.values ?? {})) query.set(key, value);
  if (opts.width) query.set('w', String(opts.width));
  if (opts.version) query.set('v', String(opts.version));
  if (opts.expires && !opts.unsigned) query.set('exp', String(opts.expires));
  if (!opts.unsigned) query.set('sig', await sign(env, RENDER_PURPOSE, canonicalQuery(slug, query)));
  const text = query.toString();
  return `${base}/i/${slug}.${format}${text ? `?${text}` : ''}`;
}

/** The name a finished image is stored under. Changing the template's version changes every name. */
export async function renderHash(templateId: string, version: number, format: Format, width: number, values: Record<string, string>): Promise<string> {
  const sorted = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]]);
  return (await sha256Hex([templateId, version, format, width, JSON.stringify(sorted)].join('\n'))).slice(0, 40);
}
