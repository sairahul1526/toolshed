/** REST API, mounted at /api/v1/links. Same actions as the dashboard, same checks. */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { parse, readJson } from '../../core/errors';
import { requireScope } from '../../core/guards';
import { addBlocked, listBlocked, listReports, removeBlocked, resolveReport } from './abuse';
import {
  addBlock, createBio, deleteBio, deleteBlock, getBio, listBios, reorderBlocks, updateBio, updateBlock,
} from './bios';
import { ctxOf, limitCreate } from './ctx';
import { createFolder, deleteFolder, listFolders, renameFolder } from './folders';
import { exportClicksCsv, exportDailyCsv, exportLinksCsv, previewImport, runImport } from './importexport';
import {
  bulkAction, bulkCreate, createLink, deleteLink, duplicateLink, getLink, getLinkRow, listLinks, listTags, setArchived, updateLink,
} from './links';
import { getSettings, saveSettings } from './settings';
import { getStats, topLinks } from './stats';
import { bulkCreateSchema } from './schemas';

const read = requireScope('links:read');
const write = requireScope('links:write');

const rangeSchema = z.object({
  days: z.coerce.number().int().min(1).max(400).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  top: z.coerce.number().int().min(1).max(50).optional(),
});
const importSchema = z.object({ csv: z.string().min(1).max(2_000_000), mapping: z.record(z.string(), z.number().int().nullable()).optional() });
const reportActionSchema = z.object({ action: z.enum(['dismiss', 'disable', 'delete']) });
const orderSchema = z.object({ ids: z.array(z.string()).max(60) });
const csvHeaders = (name: string): Record<string, string> => ({
  'content-type': 'text/csv; charset=utf-8',
  'content-disposition': `attachment; filename="${name}"`,
  'cache-control': 'no-store',
});

export const api = new Hono<AppEnv>();

// Links -------------------------------------------------------------------------------------------

api.get('/', read, async (c) => c.json(await listLinks(ctxOf(c), c.req.query())));

api.post('/', write, async (c) => {
  await limitCreate(c);
  const link = await createLink(ctxOf(c), await readJson(c));
  await auditFromRequest(c, { action: 'links.link.created', targetType: 'link', targetId: link.id, summary: `Created /${link.code}`, meta: { code: link.code } });
  return c.json(link, 201);
});

api.post('/bulk', write, async (c) => {
  const { links } = parse(bulkCreateSchema, await readJson(c));
  await limitCreate(c, Math.max(1, Math.ceil(links.length / 10)));
  const result = await bulkCreate(ctxOf(c), links);
  await auditFromRequest(c, { action: 'links.link.bulk_created', targetType: 'link', summary: `Created ${result.created.length} links in bulk`, meta: { created: result.created.length, failed: result.errors.length } });
  return c.json(result, 201);
});

api.post('/actions', write, async (c) => {
  const body = await readJson(c);
  const result = await bulkAction(ctxOf(c), body);
  await auditFromRequest(c, { action: `links.link.bulk_${String(body.action)}`, targetType: 'link', summary: `Bulk ${String(body.action)} on ${result.done} links`, meta: { done: result.done, skipped: result.skipped } });
  return c.json(result);
});

// Stats -------------------------------------------------------------------------------------------

api.get('/stats', read, async (c) => c.json(await getStats(ctxOf(c), parse(rangeSchema, c.req.query()))));

api.get('/stats/top', read, async (c) => {
  const { top, ...range } = parse(rangeSchema, c.req.query());
  return c.json({ items: await topLinks(ctxOf(c), { ...range, limit: top ?? 10 }) });
});

// Tags and folders --------------------------------------------------------------------------------

api.get('/tags', read, async (c) => c.json({ items: await listTags(ctxOf(c)) }));

api.get('/folders', read, async (c) => c.json({ items: await listFolders(ctxOf(c)) }));

api.post('/folders', write, async (c) => {
  const folder = await createFolder(ctxOf(c), await readJson(c));
  await auditFromRequest(c, { action: 'links.folder.created', targetType: 'folder', targetId: folder.id, summary: `Created folder ${folder.name}` });
  return c.json(folder, 201);
});

api.patch('/folders/:id', write, async (c) => {
  const ctx = ctxOf(c);
  await renameFolder(ctx, c.req.param('id'), await readJson(c));
  const folder = (await listFolders(ctx)).find((f) => f.id === c.req.param('id'));
  await auditFromRequest(c, { action: 'links.folder.updated', targetType: 'folder', targetId: c.req.param('id'), summary: `Renamed folder to ${folder?.name ?? ''}` });
  return c.json(folder ?? { id: c.req.param('id') });
});

api.delete('/folders/:id', write, async (c) => {
  await deleteFolder(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.folder.deleted', targetType: 'folder', targetId: c.req.param('id'), summary: 'Deleted a folder' });
  return c.json({ deleted: true });
});

// Bio pages ---------------------------------------------------------------------------------------

api.get('/bios', read, async (c) => c.json({ items: await listBios(ctxOf(c)) }));

api.post('/bios', write, async (c) => {
  const bio = await createBio(ctxOf(c), await readJson(c));
  await auditFromRequest(c, { action: 'links.bio.created', targetType: 'bio', targetId: bio.id, summary: `Created bio page /${bio.code}`, meta: { code: bio.code } });
  return c.json(bio, 201);
});

api.get('/bios/:id', read, async (c) => c.json(await getBio(ctxOf(c), c.req.param('id'))));

api.patch('/bios/:id', write, async (c) => {
  const bio = await updateBio(ctxOf(c), c.req.param('id'), await readJson(c));
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio', targetId: bio.id, summary: `Edited bio page /${bio.code}` });
  return c.json(bio);
});

api.delete('/bios/:id', write, async (c) => {
  await deleteBio(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.bio.deleted', targetType: 'bio', targetId: c.req.param('id'), summary: 'Deleted a bio page' });
  return c.json({ deleted: true });
});

api.get('/bios/:id/stats', read, async (c) => {
  const ctx = ctxOf(c);
  const bio = await getBio(ctx, c.req.param('id'));
  return c.json(await getStats(ctx, { ...parse(rangeSchema, c.req.query()), targetId: bio.id, kind: 'view' }));
});

api.post('/bios/:id/blocks', write, async (c) => {
  const block = await addBlock(ctxOf(c), c.req.param('id'), await readJson(c));
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio', targetId: c.req.param('id'), summary: 'Added a block' });
  return c.json(block, 201);
});

api.post('/bios/:id/order', write, async (c) => {
  const { ids } = parse(orderSchema, await readJson(c));
  await reorderBlocks(ctxOf(c), c.req.param('id'), ids);
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio', targetId: c.req.param('id'), summary: 'Reordered blocks' });
  return c.json(await getBio(ctxOf(c), c.req.param('id')));
});

api.patch('/blocks/:id', write, async (c) => {
  const block = await updateBlock(ctxOf(c), c.req.param('id'), await readJson(c));
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'block', targetId: block.id, summary: 'Edited a block' });
  return c.json(block);
});

api.delete('/blocks/:id', write, async (c) => {
  await deleteBlock(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'block', targetId: c.req.param('id'), summary: 'Deleted a block' });
  return c.json({ deleted: true });
});

// Abuse controls ----------------------------------------------------------------------------------

api.get('/blocklist', read, async (c) => c.json({ items: await listBlocked(ctxOf(c)) }));

api.post('/blocklist', write, async (c) => {
  const result = await addBlocked(ctxOf(c), await readJson(c));
  await auditFromRequest(c, { action: 'links.blocklist.added', targetType: 'domain', targetId: result.domain.id, summary: `Blocked ${result.domain.domain}`, meta: { disabledLinks: result.disabledLinks } });
  return c.json(result, 201);
});

api.delete('/blocklist/:id', write, async (c) => {
  await removeBlocked(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.blocklist.removed', targetType: 'domain', targetId: c.req.param('id'), summary: 'Removed a blocked domain' });
  return c.json({ deleted: true });
});

api.get('/reports', read, async (c) => c.json({ items: await listReports(ctxOf(c), c.req.query('status') === 'all' ? 'all' : 'open') }));

api.post('/reports/:id', write, async (c) => {
  const { action } = parse(reportActionSchema, await readJson(c));
  await resolveReport(ctxOf(c), c.req.param('id'), action);
  await auditFromRequest(c, { action: `links.report.${action}`, targetType: 'report', targetId: c.req.param('id'), summary: `Report ${action}` });
  return c.json({ resolved: true, action });
});

// Import, export, settings ------------------------------------------------------------------------

api.post('/import/preview', write, async (c) => c.json(previewImport(parse(importSchema.pick({ csv: true }), await readJson(c)).csv)));

api.post('/import', write, async (c) => {
  await limitCreate(c, 5);
  const { csv, mapping } = parse(importSchema, await readJson(c));
  const result = await runImport(ctxOf(c), csv, mapping ?? {});
  await auditFromRequest(c, { action: 'links.import.finished', targetType: 'link', summary: `Imported ${result.created} links`, meta: { created: result.created, skipped: result.skipped.length } });
  return c.json(result, 201);
});

api.get('/export/links.csv', read, async (c) => c.body(await exportLinksCsv(ctxOf(c)), 200, csvHeaders('links.csv')));
api.get('/export/daily.csv', read, async (c) => c.body(await exportDailyCsv(ctxOf(c), parse(rangeSchema, c.req.query())), 200, csvHeaders('link-clicks-by-day.csv')));
api.get('/export/clicks.csv', read, async (c) => c.body(await exportClicksCsv(ctxOf(c)), 200, csvHeaders('recent-clicks.csv')));

api.get('/settings', read, async (c) => c.json(await getSettings(c.env, ctxOf(c).orgId)));

api.patch('/settings', write, async (c) => {
  const settings = await saveSettings(c.env, ctxOf(c).orgId, await readJson(c));
  await auditFromRequest(c, { action: 'links.settings.updated', targetType: 'settings', summary: 'Changed Links settings' });
  return c.json(settings);
});

// One link by id or code. Registered last so the fixed paths above win.

api.get('/:id', read, async (c) => c.json(await getLink(ctxOf(c), c.req.param('id'))));

api.patch('/:id', write, async (c) => {
  const link = await updateLink(ctxOf(c), c.req.param('id'), await readJson(c));
  await auditFromRequest(c, { action: 'links.link.updated', targetType: 'link', targetId: link.id, summary: `Edited /${link.code}`, meta: { code: link.code } });
  return c.json(link);
});

api.delete('/:id', write, async (c) => {
  const gone = await deleteLink(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.link.deleted', targetType: 'link', targetId: gone.id, summary: `Deleted /${gone.code}`, meta: { code: gone.code } });
  return c.json({ deleted: true, id: gone.id });
});

api.post('/:id/archive', write, async (c) => {
  const link = await setArchived(ctxOf(c), c.req.param('id'), true);
  await auditFromRequest(c, { action: 'links.link.archived', targetType: 'link', targetId: link.id, summary: `Archived /${link.code}` });
  return c.json(link);
});

api.post('/:id/restore', write, async (c) => {
  const link = await setArchived(ctxOf(c), c.req.param('id'), false);
  await auditFromRequest(c, { action: 'links.link.restored', targetType: 'link', targetId: link.id, summary: `Restored /${link.code}` });
  return c.json(link);
});

api.post('/:id/duplicate', write, async (c) => {
  await limitCreate(c);
  const link = await duplicateLink(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.link.created', targetType: 'link', targetId: link.id, summary: `Duplicated into /${link.code}`, meta: { code: link.code } });
  return c.json(link, 201);
});

api.get('/:id/stats', read, async (c) => {
  const ctx = ctxOf(c);
  const row = await getLinkRow(ctx, c.req.param('id'));
  return c.json(await getStats(ctx, { ...parse(rangeSchema, c.req.query()), targetId: row.id }));
});
