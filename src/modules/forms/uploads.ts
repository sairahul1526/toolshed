/**
 * Files people attach to a form, and the logo and cover a team adds to its look. Everything goes
 * through the Worker into the FILES bucket under `forms/<workspace>/<form>/`, with a random key.
 * Nothing is ever served from a public bucket URL: team members download through a signed-in
 * route, and the two branding images through the form's own address.
 */
import { newId, randomToken, type OrgDb } from '../../core/db';
import type { Env } from '../../env';
import { formErrors } from './errors';
import type { FileRef } from './logic';
import type { Field } from './schema';

/** What a "File upload" block may accept unless the form narrows it. SVG and anything that can run in a browser are never allowed. */
export const DEFAULT_ACCEPT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'mp3', 'mp4', 'mov'];
export const NEVER = new Set(['svg', 'html', 'htm', 'xhtml', 'js', 'mjs', 'exe', 'bat', 'cmd', 'sh', 'php', 'jar', 'apk', 'msi', 'dll', 'swf']);
export const CEILING_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime',
};

const SIGNATURES: Record<string, number[][]> = {
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  zip: [[0x50, 0x4b]],
  webp: [[0x52, 0x49, 0x46, 0x46]],
};

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** Does the start of the file look like what its extension claims? A cheap guard against a script renamed to .png. */
export function looksRight(ext: string, head: Uint8Array): boolean {
  const sigs = SIGNATURES[ext];
  if (!sigs) return true;
  return sigs.some((s) => s.every((b, i) => head[i] === b));
}

export function safeName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f"<>|:*?]/g, '').trim().slice(-120);
  return base || 'file';
}

export interface UploadCtx {
  env: Env;
  db: OrgDb;
}

export async function uploadAnswerFile(ctx: UploadCtx, formId: string, field: Field, file: File, now = Date.now()): Promise<FileRef> {
  const ext = extOf(file.name);
  const allowed = (field.accept?.length ? field.accept : DEFAULT_ACCEPT).filter((e) => !NEVER.has(e));
  if (!ext || NEVER.has(ext) || !allowed.includes(ext)) {
    throw formErrors.file_rejected(`That file type isn’t accepted here. Use ${allowed.slice(0, 6).join(', ').toUpperCase()}${allowed.length > 6 ? ' and others' : ''}.`);
  }
  const limit = Math.min((field.maxSizeMb ?? 10) * 1024 * 1024, CEILING_BYTES);
  if (file.size > limit) throw formErrors.file_too_large(`That file is over the ${Math.round(limit / 1024 / 1024)} MB limit.`);
  if (file.size === 0) throw formErrors.file_rejected('That file is empty.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksRight(ext, bytes.slice(0, 8))) throw formErrors.file_rejected('That file doesn’t look like a ' + ext.toUpperCase() + ' file.');
  const id = newId('fil', now);
  const key = `forms/${ctx.db.orgId}/${formId}/${randomToken(18)}.${ext}`;
  const type = MIME[ext] ?? 'application/octet-stream';
  await ctx.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
  await ctx.db.insert('forms_files', { id, form_id: formId, submission_id: null, field_id: field.id, r2_key: key, name: safeName(file.name), size: bytes.byteLength, type, created_at: now });
  return { id, name: safeName(file.name), size: bytes.byteLength, type };
}

export interface FileRow {
  id: string;
  form_id: string;
  submission_id: string | null;
  field_id: string;
  r2_key: string;
  name: string;
  size: number;
  type: string;
  created_at: number;
}

/** The unclaimed uploads this respondent names, so a submit can only attach files that were uploaded to this form. */
export async function lookupUploads(db: OrgDb, formId: string, ids: string[]): Promise<Map<string, FileRef & { fieldId: string }>> {
  const out = new Map<string, FileRef & { fieldId: string }>();
  const clean = [...new Set(ids.filter((i) => /^fil_[0-9a-z]{22}$/.test(i)))].slice(0, 40);
  if (clean.length === 0) return out;
  const rows = await db.all<FileRow>(`SELECT * FROM forms_files WHERE org_id = :org AND form_id = ? AND submission_id IS NULL AND id IN (${clean.map(() => '?').join(',')})`, formId, ...clean);
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name, size: r.size, type: r.type, fieldId: r.field_id });
  return out;
}

export async function claimUploads(db: OrgDb, formId: string, submissionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.run(`UPDATE forms_files SET submission_id = ? WHERE org_id = :org AND form_id = ? AND submission_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`, submissionId, formId, ...ids);
}

export async function deleteUploadsOf(ctx: UploadCtx, submissionIds: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < submissionIds.length; i += 50) {
    const chunk = submissionIds.slice(i, i + 50);
    const marks = chunk.map(() => '?').join(',');
    const rows = await ctx.db.all<{ r2_key: string }>(`SELECT r2_key FROM forms_files WHERE org_id = :org AND submission_id IN (${marks})`, ...chunk);
    if (rows.length) await ctx.env.FILES.delete(rows.map((r) => r.r2_key));
    await ctx.db.run(`DELETE FROM forms_files WHERE org_id = :org AND submission_id IN (${marks})`, ...chunk);
    removed += rows.length;
  }
  return removed;
}

/** Uploads nobody claimed within a day belong to forms that were abandoned half way. */
export async function purgeOrphanUploads(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare('SELECT id, r2_key FROM forms_files WHERE submission_id IS NULL AND created_at < ?1 LIMIT 200').bind(now - 86_400_000).all<{ id: string; r2_key: string }>();
  if (results.length === 0) return 0;
  await env.FILES.delete(results.map((r) => r.r2_key));
  await env.DB.batch(results.map((r) => env.DB.prepare('DELETE FROM forms_files WHERE id = ?1').bind(r.id)));
  return results.length;
}

/** A download for a signed-in member. Always an attachment, never rendered in the browser. */
export async function downloadFile(ctx: UploadCtx, fileId: string): Promise<Response> {
  const row = await ctx.db.get<FileRow>('forms_files', fileId);
  if (!row) throw formErrors.not_found('We couldn’t find that file.');
  const obj = await ctx.env.FILES.get(row.r2_key);
  if (!obj) throw formErrors.not_found('That file is no longer in storage.');
  const name = encodeURIComponent(row.name);
  return new Response(obj.body, {
    headers: {
      'content-type': row.type,
      'content-length': String(obj.size),
      'content-disposition': `attachment; filename="${row.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${name}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}

export const BRAND_IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const BRAND_IMAGE_MAX = 3 * 1024 * 1024;

/** Store a logo or cover. Returns the storage key to keep in the form's theme. */
export async function saveBrandImage(ctx: UploadCtx, formId: string, kind: 'logo' | 'cover', file: File): Promise<string> {
  const ext = extOf(file.name);
  if (!BRAND_IMAGE_TYPES.includes(ext)) throw formErrors.file_rejected('Use a PNG, JPG, WebP or GIF image.');
  if (file.size > BRAND_IMAGE_MAX) throw formErrors.file_too_large('Use an image under 3 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksRight(ext, bytes.slice(0, 8))) throw formErrors.file_rejected('That doesn’t look like a ' + ext.toUpperCase() + ' image.');
  const key = `forms/${ctx.db.orgId}/${formId}/${kind}-${randomToken(9)}.${ext}`;
  await ctx.env.FILES.put(key, bytes, { httpMetadata: { contentType: MIME[ext]! } });
  return key;
}

export async function readBrandImage(env: Env, key: string): Promise<Response | null> {
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  const type = MIME[extOf(key)] ?? 'application/octet-stream';
  return new Response(obj.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' } });
}
