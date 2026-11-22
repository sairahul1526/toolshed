/** Image URLs ready to paste, and the tags that point a page's share image at one. */
import type { OrgDb } from '../../core/db';
import { z } from 'zod';
import { parse } from '../../core/errors';
import type { Env } from '../../env';
import { imageErrors } from './errors';
import { getTemplate, type Template } from './templates';
import { clampWidth, FORMATS, heightFor, imageUrl, normaliseValues, type Format } from './urls';

/** A signed URL may be set to stop working after at most this long. */
export const MAX_EXPIRY_SECONDS = 366 * 24 * 3600;

const linkSchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  format: z.enum(FORMATS).default('svg'),
  width: z.number().int().positive().optional(),
  /** Seconds from now until the URL stops working. Leave out for a URL that never expires. */
  expiresIn: z.number().int().min(60, 'Use 60 seconds or more.').max(MAX_EXPIRY_SECONDS, 'Use a year or less.').optional(),
  /** Keep this URL on the look the template has now, even after it is published again. */
  pin: z.boolean().default(false),
  /** Leave the signature off. Only works while the template allows open rendering. */
  unsigned: z.boolean().default(false),
});

export interface ShareLink {
  url: string;
  format: Format;
  width: number;
  height: number;
  signed: boolean;
  /** Unix seconds, or null when the URL never expires. */
  expiresAt: number | null;
  /** The tags to paste into a page's head so that sharing the page shows this image. */
  metaTags: string;
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Social networks read these when a page is shared. They need PNG or JPEG, not SVG. */
export function metaTags(url: string, format: Format, width: number, height: number): string {
  const safe = escapeAttr(url);
  return [
    `<meta property="og:image" content="${safe}">`,
    `<meta property="og:image:type" content="${format === 'png' ? 'image/png' : 'image/svg+xml'}">`,
    `<meta property="og:image:width" content="${width}">`,
    `<meta property="og:image:height" content="${height}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${safe}">`,
  ].join('\n');
}

export async function linkFor(env: Env, template: Template, base: string, input: unknown, now = Date.now()): Promise<ShareLink> {
  const data = parse(linkSchema, input);
  if (!template.publishedDoc) throw imageErrors.not_published();
  if (data.unsigned && !template.open) throw imageErrors.signature_required('This template only draws signed URLs. Turn on open rendering in its settings to use URLs without a signature.');
  const doc = template.publishedDoc;
  const values = normaliseValues(doc, data.values, { remotePictures: !data.unsigned });
  const width = clampWidth(data.width, doc.width);
  const expiresAt = data.expiresIn && !data.unsigned ? Math.floor(now / 1000) + data.expiresIn : null;
  const url = await imageUrl(env, base, template.slug, data.format, {
    values,
    width: width === doc.width ? undefined : width,
    version: data.pin ? template.version : undefined,
    expires: expiresAt ?? undefined,
    unsigned: data.unsigned,
  });
  const height = heightFor(doc, width);
  return { url, format: data.format, width, height, signed: !data.unsigned, expiresAt, metaTags: metaTags(url, data.format, width, height) };
}

/** Makes an image URL for a template of this workspace. */
export async function shareLink(env: Env, db: OrgDb, templateId: string, base: string, input: unknown, now = Date.now()): Promise<ShareLink> {
  return linkFor(env, await getTemplate(db, templateId), base, input, now);
}
