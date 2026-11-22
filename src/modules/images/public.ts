/**
 * Public addresses, all under /i. No sign-in and no cookies.
 *
 *   /i/<slug>.svg|png        one image, from storage or drawn on the first request
 *   /i/a/<assetId>           an uploaded picture or font
 *   /i/<slug>/image?src=     a picture the template itself uses, for the generator page's preview
 *   /i/<slug>/make           the generator page (see generator.tsx)
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { parseJson } from '../../core/db';
import { AppError, errors, wantsJson } from '../../core/errors';
import { visitorId } from '../../core/net';
import { enforceRateLimit } from '../../core/ratelimit';
import { moduleState } from '../../core/registry';
import type { AppEnv } from '../../env';
import { publicAsset } from './assets';
import { generator } from './generator';
import { fileResponse } from './http';
import { loadPicture } from './render';
import type { TemplateDoc } from './schema';
import { serveByUrl } from './serve';
import { getSettings } from './settings';
import { SLUG, type TemplateRow } from './templates';
import type { Format } from './urls';

const FILE = /^([a-z0-9-]+)\.(svg|png)$/;
const YEAR = 31_536_000;
/** Pictures one visitor may ask the generator page's helper for in a minute. */
const PICTURE_RATE = { limit: 60, windowSec: 60 };

/**
 * An image address is opened by browsers, crawlers and `<img>` tags, none of which can use an
 * error page. They get one plain line, never cached, with the code in a header for scripts.
 */
function plainError(c: Context<AppEnv>, err: unknown): Response {
  if (!(err instanceof AppError) || wantsJson(c)) throw err;
  return c.text(err.message, err.status as ContentfulStatusCode, {
    ...err.headers,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-images-error': err.code,
  });
}

/** The fixed outside pictures a published design uses. Field values typed by visitors never count. */
export function fixedPictures(doc: TemplateDoc): string[] {
  const out = new Set<string>();
  for (const layer of doc.layers) if (layer.type === 'image' && layer.src.startsWith('https://')) out.add(layer.src);
  for (const field of doc.fields) if (field.type === 'image' && field.default.startsWith('https://')) out.add(field.default);
  return [...out];
}

const pub = new Hono<AppEnv>();

pub.get('/i/a/:id', async (c) => {
  try {
    const file = await publicAsset(c.env, c.req.param('id'));
    if (!file) throw errors.not_found('There is no file at this address.');
    return c.body(file.body, 200, {
      'content-type': file.contentType,
      'content-length': String(file.bytes),
      // A file never changes once uploaded: a new upload gets a new address.
      'cache-control': `public, max-age=${YEAR}, immutable`,
      'x-content-type-options': 'nosniff',
    });
  } catch (err) {
    return plainError(c, err);
  }
});

pub.get('/i/:slug/image', async (c) => {
  try {
    const slug = c.req.param('slug');
    const src = c.req.query('src') ?? '';
    const none = errors.not_found('There is no picture at this address.');
    if (!SLUG.test(slug)) throw none;
    const row = await c.env.DB.prepare('SELECT org_id, published_doc, page FROM img_templates WHERE slug = ?1').bind(slug).first<Pick<TemplateRow, 'org_id' | 'published_doc' | 'page'>>();
    if (!row || row.page !== 1 || row.published_doc === null || !(await moduleState(c.env, row.org_id, 'images')).enabled) throw none;
    const doc = parseJson<TemplateDoc | null>(row.published_doc, null);
    // Only addresses written into the design are served, so this cannot be used to fetch anything else.
    if (!doc || !fixedPictures(doc).includes(src)) throw none;
    await enforceRateLimit(c.env, `images:picture:${await visitorId(c.env, 'images', c.req.raw)}`, PICTURE_RATE);
    const settings = await getSettings(c.env, row.org_id);
    const picture = await loadPicture(c.env, row.org_id, src, settings.allowedHosts);
    if (!picture) throw none;
    return fileResponse(picture.bytes, 200, { 'content-type': picture.type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
  } catch (err) {
    return plainError(c, err);
  }
});

pub.route('/', generator);

pub.get('/i/:file', async (c) => {
  try {
    const match = FILE.exec(c.req.param('file'));
    if (!match || !SLUG.test(match[1]!)) throw errors.not_found('There is no image at this address.');
    const image = await serveByUrl(
      c.env,
      {
        slug: match[1]!,
        format: match[2] as Format,
        query: new URL(c.req.url).searchParams,
        ifNoneMatch: c.req.header('if-none-match') ?? null,
        visitor: () => visitorId(c.env, 'images', c.req.raw),
      },
      (work) => c.executionCtx.waitUntil(work),
    );
    return fileResponse(image.body, image.status, image.headers);
  } catch (err) {
    return plainError(c, err);
  }
});

export { pub };
