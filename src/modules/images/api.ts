/** REST API, mounted at /api/v1/images. Everything the dashboard does goes through the same service calls. */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { FAMILIES } from '../../../public/m/images/engine/index.js';
import { auditFromRequest } from '../../core/audit';
import { errors, readJson } from '../../core/errors';
import { needRole, requireScope } from '../../core/guards';
import type { AppEnv } from '../../env';
import { deleteAsset, getAsset, listAssets, uploadAsset } from './assets';
import { batchCsv, createBatch, deleteBatch, getBatch, listBatches, writeBatchZip } from './batch';
import { imageErrors } from './errors';
import { fileResponse, intParam, queryFields, readBytes, readUpload, scopeOf } from './http';
import { customFamilies, hostAllowed, loadPicture } from './render';
import { PRESETS, RESERVED_PARAMS } from './schema';
import { bakePng, MAX_BAKE_BYTES, previewSvg, renderToStorage, type StoredImage } from './serve';
import { getSettings, saveSettings } from './settings';
import { metaTags, shareLink } from './share';
import { STARTERS } from './starters';
import {
  clearRenders,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  exportTemplate,
  getTemplate,
  importTemplate,
  listTemplates,
  parseDoc,
  publishTemplate,
  revertTemplate,
  updateTemplate,
} from './templates';
import { FORMATS, type Format } from './urls';
import { listLog, topImages, usageSummary } from './usage';

const read = requireScope('images:read');
const write = requireScope('images:write');

const api = new Hono<AppEnv>();

function page(c: Context<AppEnv>): { limit?: number; cursor?: string | null } {
  return { limit: intParam(c.req.query('limit')), cursor: c.req.query('cursor') ?? null };
}

function formatOf(raw: unknown): Format {
  if (raw === undefined || raw === null || raw === '') return 'svg';
  if (typeof raw === 'string' && (FORMATS as readonly string[]).includes(raw)) return raw as Format;
  throw errors.validation_failed('Pick svg or png.', { format: 'Pick svg or png.' });
}

function valuesOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw errors.validation_failed('Send the field values as an object.', { values: 'Send an object such as { "title": "Hello" }.' });
  return raw as Record<string, unknown>;
}

function widthOf(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) throw errors.validation_failed('Send the width as a whole number of pixels.', { width: 'Use a whole number of pixels.' });
  return raw;
}

/** The tags that point a page's share image at a stored image, ready to paste. */
const tagsFor = (image: StoredImage): string => metaTags(image.url, image.format, image.width, image.height);

// --- Templates -----------------------------------------------------------------------------

api.get('/templates', read, async (c) => c.json(await listTemplates(scopeOf(c).db, page(c))));

api.post('/templates', write, async (c) => {
  const s = scopeOf(c);
  const template = await createTemplate(s.env, s.db, await readJson(c), s.actor);
  await auditFromRequest(c, { action: 'images.template.created', targetType: 'image_template', targetId: template.id, summary: `Created the image template "${template.name}"` });
  return c.json({ template }, 201);
});

api.post('/templates/import', write, async (c) => {
  const s = scopeOf(c);
  const template = await importTemplate(s.env, s.db, await readJson(c), s.actor);
  await auditFromRequest(c, { action: 'images.template.created', targetType: 'image_template', targetId: template.id, summary: `Imported the image template "${template.name}"` });
  return c.json({ template }, 201);
});

api.get('/templates/:id', read, async (c) => c.json({ template: await getTemplate(scopeOf(c).db, c.req.param('id')) }));

api.patch('/templates/:id', write, async (c) => {
  const s = scopeOf(c);
  const body = await readJson(c);
  const template = await updateTemplate(s.db, c.req.param('id'), body);
  // Saving a draft happens on every edit; only the settings that change who can render are worth a line.
  if ('open' in body || 'page' in body || 'slug' in body || 'maxRenders' in body) {
    await auditFromRequest(c, {
      action: 'images.template.settings_changed',
      targetType: 'image_template',
      targetId: template.id,
      summary: `Changed the settings of the image template "${template.name}"`,
      meta: { open: template.open, page: template.page, slug: template.slug, maxRenders: template.maxRenders },
    });
  }
  return c.json({ template });
});

api.delete('/templates/:id', write, async (c) => {
  const s = scopeOf(c);
  const template = await getTemplate(s.db, c.req.param('id'));
  await deleteTemplate(s.env, s.db, template.id);
  await auditFromRequest(c, { action: 'images.template.deleted', targetType: 'image_template', targetId: template.id, summary: `Deleted the image template "${template.name}"` });
  return c.json({ deleted: true });
});

api.post('/templates/:id/publish', write, async (c) => {
  const s = scopeOf(c);
  const template = await publishTemplate(s.env, s.db, c.req.param('id'));
  await auditFromRequest(c, { action: 'images.template.published', targetType: 'image_template', targetId: template.id, summary: `Published version ${template.version} of the image template "${template.name}"` });
  return c.json({ template });
});

api.post('/templates/:id/revert', write, async (c) => c.json({ template: await revertTemplate(scopeOf(c).db, c.req.param('id')) }));

api.post('/templates/:id/duplicate', write, async (c) => {
  const s = scopeOf(c);
  const template = await duplicateTemplate(s.env, s.db, c.req.param('id'), s.actor);
  return c.json({ template }, 201);
});

api.post('/templates/:id/clear', write, async (c) => {
  const s = scopeOf(c);
  await clearRenders(s.env, s.db, c.req.param('id'));
  await auditFromRequest(c, { action: 'images.template.cache_cleared', targetType: 'image_template', targetId: c.req.param('id'), summary: 'Cleared the stored images of an image template' });
  return c.json({ cleared: true }, 202);
});

api.get('/templates/:id/export', read, async (c) => {
  const template = await getTemplate(scopeOf(c).db, c.req.param('id'));
  c.header('content-disposition', `attachment; filename="${template.slug}.template.json"`);
  return c.json(exportTemplate(template));
});

/** Draws a draft without storing or counting it. Send `doc` to preview a design that has not been saved. */
api.post('/templates/:id/preview', read, async (c) => {
  const s = scopeOf(c);
  const body = await readJson(c);
  const template = await getTemplate(s.db, c.req.param('id'));
  const doc = body.doc === undefined ? template.doc : parseDoc(body.doc);
  const { svg, warnings } = await previewSvg(s.env, s.db, doc, valuesOf(body.values), widthOf(body.width));
  return c.json({ svg, warnings });
});

api.post('/templates/:id/url', write, async (c) => {
  const s = scopeOf(c);
  return c.json(await shareLink(s.env, s.db, c.req.param('id'), s.base, await readJson(c)));
});

/**
 * Stores a PNG the caller drew itself (the dashboard does this in the browser). The body is the
 * PNG; the field values and `w` go in the query string, exactly as in the image URL.
 */
api.post('/templates/:id/bake', write, async (c) => {
  const s = scopeOf(c);
  const query = new URL(c.req.url).searchParams;
  const png = await readBytes(c.req.raw, MAX_BAKE_BYTES, 'That PNG is larger than 5 MB. Use a smaller width.');
  const image = await bakePng(s.env, s.db, c.req.param('id'), png, { values: queryFields(query, RESERVED_PARAMS), width: intParam(query.get('w') ?? undefined), base: s.base });
  return c.json({ image, metaTags: tagsFor(image) }, image.cached ? 200 : 201);
});

// --- Rendering -----------------------------------------------------------------------------

api.post('/render', write, async (c) => {
  const s = scopeOf(c);
  const body = await readJson(c);
  if (typeof body.template !== 'string' || body.template === '') throw errors.validation_failed('Say which template to use.', { template: 'Send a template id.' });
  const image = await renderToStorage(s.env, s.db, body.template, { values: valuesOf(body.values), format: formatOf(body.format), width: widthOf(body.width), source: 'api', base: s.base });
  return c.json({ image, metaTags: tagsFor(image) }, image.cached ? 200 : 201);
});

// --- Starters, sizes and fonts ------------------------------------------------------------

api.get('/starters', read, (c) =>
  c.json({
    items: STARTERS.map((starter) => ({ key: starter.key, name: starter.name, description: starter.description, width: starter.doc.width, height: starter.doc.height, fields: starter.doc.fields })),
    presets: PRESETS,
  }),
);

api.get('/fonts', read, async (c) => {
  const custom = await customFamilies(scopeOf(c).db);
  return c.json({
    items: [
      ...FAMILIES.map((family) => ({ id: family.id, name: family.name, kind: family.kind, weights: family.faces.map((face) => face.weight) })),
      ...custom.map((family) => ({ id: family.id, name: family.name, kind: 'custom', weights: family.faces.map((face) => face.weight) })),
    ],
  });
});

// --- Uploaded pictures and fonts ----------------------------------------------------------

api.get('/assets', read, async (c) => {
  const kind = c.req.query('kind');
  return c.json(await listAssets(scopeOf(c).db, { ...page(c), kind: kind === 'image' || kind === 'font' ? kind : undefined }));
});

api.post('/assets', write, async (c) => {
  const s = scopeOf(c);
  const asset = await uploadAsset(s.env, s.db, await readUpload(c), s.actor);
  await auditFromRequest(c, { action: 'images.asset.uploaded', targetType: 'image_asset', targetId: asset.id, summary: `Uploaded the ${asset.kind === 'font' ? 'font' : 'picture'} "${asset.name}"` });
  return c.json({ asset }, 201);
});

api.get('/assets/:id', read, async (c) => c.json({ asset: await getAsset(scopeOf(c).db, c.req.param('id')) }));

api.delete('/assets/:id', write, async (c) => {
  const s = scopeOf(c);
  const asset = await deleteAsset(s.env, s.db, c.req.param('id'));
  await auditFromRequest(c, { action: 'images.asset.deleted', targetType: 'image_asset', targetId: asset.id, summary: `Deleted the ${asset.kind === 'font' ? 'font' : 'picture'} "${asset.name}"` });
  return c.json({ deleted: true });
});

/**
 * A picture from an allowed outside site, fetched once and kept, for the editor's preview.
 * It answers with the picture itself so the editor never talks to the outside site.
 */
api.get('/picture', write, async (c) => {
  const s = scopeOf(c);
  const src = c.req.query('src') ?? '';
  const settings = await getSettings(s.env, s.db.orgId);
  if (!src.startsWith('asset:') && !hostAllowed(src, settings.allowedHosts)) throw imageErrors.image_host_not_allowed();
  const picture = await loadPicture(s.env, s.db.orgId, src, settings.allowedHosts);
  if (!picture) throw errors.not_found('We couldn’t load a picture from that address. Check it is a PNG, JPEG, WebP or GIF under 2 MB.');
  return fileResponse(picture.bytes, 200, { 'content-type': picture.type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
});

// --- Batches -------------------------------------------------------------------------------

api.get('/batches', read, async (c) => c.json(await listBatches(scopeOf(c).db, page(c))));

api.post('/batches', write, async (c) => {
  const s = scopeOf(c);
  const batch = await createBatch(s.env, s.db, await readJson(c), s.base, s.actor);
  await auditFromRequest(c, { action: 'images.batch.started', targetType: 'image_batch', targetId: batch.id, summary: `Started a batch of ${batch.total} ${batch.total === 1 ? 'image' : 'images'}` });
  return c.json({ batch }, 202);
});

api.get('/batches/:id', read, async (c) => c.json({ batch: await getBatch(scopeOf(c).db, c.req.param('id')) }));

api.delete('/batches/:id', write, async (c) => {
  await deleteBatch(scopeOf(c).db, c.req.param('id'));
  return c.json({ deleted: true });
});

api.get('/batches/:id/results.csv', read, async (c) => {
  const batch = await getBatch(scopeOf(c).db, c.req.param('id'));
  return c.body(batchCsv(batch), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${batch.id}.csv"` });
});

api.get('/batches/:id/download.zip', read, async (c) => {
  const s = scopeOf(c);
  const batch = await getBatch(s.db, c.req.param('id'));
  if (batch.status === 'queued' || batch.status === 'running') throw imageErrors.batch_running();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  // The archive is written while it downloads, so it never sits in memory in one piece. Each
  // write waits for the reader, and the Worker stays alive for as long as the download is open.
  void writeBatchZip(s.env, s.db, batch, (chunk) => writer.write(chunk))
    .then(() => writer.close())
    .catch((err: unknown) => writer.abort(err));
  return c.body(readable, 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${batch.id}.zip"` });
});

// --- Usage ---------------------------------------------------------------------------------

api.get('/usage', read, async (c) => {
  const s = scopeOf(c);
  const [summary, top, settings] = await Promise.all([
    usageSummary(s.db, { days: intParam(c.req.query('days')), templateId: c.req.query('template') || undefined }),
    topImages(s.db, intParam(c.req.query('top')) ?? 10),
    getSettings(s.env, s.db.orgId),
  ]);
  return c.json({ ...summary, dailyCap: settings.dailyCap, top, timezone: 'UTC' });
});

api.get('/log', read, async (c) => c.json(await listLog(scopeOf(c).db, { ...page(c), errorsOnly: c.req.query('errors') === '1' })));

// --- Settings ------------------------------------------------------------------------------

api.get('/settings', read, async (c) => c.json({ settings: await getSettings(c.env, c.get('org')!.id) }));

api.put('/settings', write, async (c) => {
  needRole(c, 'admin');
  const settings = await saveSettings(c.env, c.get('org')!.id, await readJson(c));
  await auditFromRequest(c, { action: 'images.settings.changed', targetType: 'module', targetId: 'images', summary: 'Changed the Images settings', meta: { ...settings } });
  return c.json({ settings });
});

export { api };
