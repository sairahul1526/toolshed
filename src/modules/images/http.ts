/** Small request helpers shared by the API, the dashboard and the public routes. */
import type { Context } from 'hono';
import type { OrgDb } from '../../core/db';
import { orgDb } from '../../core/db';
import { errors } from '../../core/errors';
import { baseUrl } from '../../core/net';
import type { AppEnv, Env } from '../../env';
import { MAX_FONT_BYTES } from './render';
import type { Actor } from './templates';
import type { Upload } from './assets';

export interface Scope {
  env: Env;
  db: OrgDb;
  actor: Actor;
  /** The site address image URLs start with. */
  base: string;
}

/** The signed-in caller's workspace. Only for routes behind `requireOrg`. */
export function scopeOf(c: Context<AppEnv>): Scope {
  return { env: c.env, db: orgDb(c.env.DB, c.get('org')!.id), actor: { id: c.get('user')?.id ?? null }, base: baseUrl(c) };
}

/**
 * Reads a request body up to `max` bytes and stops as soon as it is larger, so a sender cannot
 * make the Worker hold more than it agreed to.
 */
export async function readBytes(req: Request, max: number, message: string): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) throw errors.too_large(message);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw errors.too_large(message);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const UPLOAD_MESSAGE = 'That file is too large. Pictures can be 2 MB and fonts 5 MB.';

/** An uploaded file, sent either as a form with a `file` field or as the raw request body with `?name=`. */
export async function readUpload(c: Context<AppEnv>): Promise<Upload> {
  const type = c.req.header('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) {
    return { name: c.req.query('name'), bytes: await readBytes(c.req.raw, MAX_FONT_BYTES, UPLOAD_MESSAGE) };
  }
  // The form adds a few hundred bytes of its own around the file.
  const body = await readBytes(c.req.raw, MAX_FONT_BYTES + 64 * 1024, UPLOAD_MESSAGE);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': type } }).formData();
  } catch {
    throw errors.bad_request('That upload could not be read. Choose the file again.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw errors.validation_failed('Choose a file to upload.', { file: 'Choose a file to upload.' });
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Field values taken from a query string: every parameter that is not one of the URL's own. */
export function queryFields(query: URLSearchParams, skip: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of query) if (!(key in out) && !skip.includes(key)) out[key] = value;
  return out;
}

export function intParam(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[0-9]{1,6}$/.test(raw) ? Number(raw) : undefined;
}

/** A response whose body is bytes, a stream, text or nothing. Hono's `c.body` is typed too narrowly for byte arrays that come from storage. */
export function fileResponse(body: ReadableStream | Uint8Array | string | null, status: number, headers: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

/** An SVG drawn for a signed-in person. The policy stops the file doing anything but draw, even opened in its own tab. */
export function svgResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
