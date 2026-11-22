/**
 * REST API at /api/v1/forms. Every route is guarded with a scope: `forms:read` to look,
 * `forms:write` to change. Responses are JSON; errors use the shared `{ code, message, fields }` shape.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { errors, parse, readJson } from '../../core/errors';
import { needRole, requireScope } from '../../core/guards';
import type { AppEnv } from '../../env';
import { formErrors } from './errors';
import { importResponses, previewImport } from './importcsv';
import { actorOf, ctxOf, formView, intParam } from './http';
import { definitionFor, deleteByEmail, deleteNote, deleteSubmissions, addNote, exportByEmail, exportCsv, folderCounts, getSubmission, listSubmissions, markRead, setSpam, setStarred, type ListQuery } from './submissions';
import {
  closeForm, createForm, deleteForm, duplicateForm, exportForm, getDraft, getForm, getPublished, importForm, listForms, listVersions, getVersion, publish, reopenForm,
  renameForm, restoreForm, restoreVersion, saveDraft, trashForm, updateSettings, countForms,
} from './service';
import { rangeDays, summary } from './stats';
import { TEMPLATES } from './templates';
import { downloadFile, saveBrandImage } from './uploads';
import { settingsSchema } from './schema';

const READ = requireScope('forms:read');
const WRITE = requireScope('forms:write');

const createBody = z.object({
  name: z.string().max(120).optional(),
  templateId: z.string().max(40).optional(),
  definition: z.unknown().optional(),
  slug: z.string().max(60).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const bulkBody = z.object({
  action: z.enum(['spam', 'not_spam', 'delete', 'star', 'unstar', 'read', 'unread']),
  ids: z.array(z.string().max(60)).min(1).max(500),
});

function queryOf(c: { req: { query(k: string): string | undefined } }): ListQuery {
  const q = (k: string) => c.req.query(k);
  const status = q('status');
  return {
    status: status === 'partial' || status === 'spam' || status === 'all' ? status : 'complete',
    ...(q('q') ? { q: q('q')! } : {}),
    ...(q('from') && Number.isFinite(Date.parse(q('from')!)) ? { from: Date.parse(q('from')!) } : {}),
    ...(q('to') && Number.isFinite(Date.parse(q('to')!)) ? { to: Date.parse(q('to')!) } : {}),
    ...(q('starred') === '1' ? { starred: true } : {}),
    ...(q('unread') === '1' ? { unread: true } : {}),
    ...(q('field') && q('value') !== undefined ? { field: q('field')!, value: q('value')! } : {}),
    ...(q('email') ? { email: q('email')! } : {}),
    limit: intParam(q('limit'), 25, 1, 200),
    offset: intParam(q('offset'), 0, 0, 1_000_000),
  };
}

export const api = new Hono<AppEnv>();

api.get('/templates', READ, (c) => c.json({ items: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })) }));

api.get('/', READ, async (c) => {
  const ctx = ctxOf(c);
  const trashed = c.req.query('trashed') === '1';
  const status = c.req.query('status');
  const limit = intParam(c.req.query('limit'), 50, 1, 200);
  const offset = intParam(c.req.query('offset'), 0, 0, 100_000);
  const [items, total] = await Promise.all([
    listForms(ctx.db, { trashed, limit, offset, ...(status ? { status } : {}), ...(c.req.query('q') ? { q: c.req.query('q')! } : {}) }),
    countForms(ctx.db, { trashed }),
  ]);
  return c.json({ items: items.map(formView), total });
});

api.post('/', WRITE, async (c) => {
  const body = parse(createBody, await readJson(c));
  const form = await createForm(ctxOf(c), { ...body, settings: body.settings as never }, actorOf(c));
  await auditFromRequest(c, { action: 'form.created', targetType: 'form', targetId: form.id, summary: `Created the form ${form.name}` });
  return c.json(formView(form), 201);
});

api.post('/import', WRITE, async (c) => {
  const form = await importForm(ctxOf(c), await readJson(c), actorOf(c));
  await auditFromRequest(c, { action: 'form.imported', targetType: 'form', targetId: form.id, summary: `Imported the form ${form.name}` });
  return c.json(formView(form), 201);
});

// One person's data, across every form in the workspace.
api.get('/respondents', READ, async (c) => {
  const email = (c.req.query('email') ?? '').trim();
  if (!email) throw errors.validation_failed(undefined, { email: 'Enter the email address to look up.' });
  return c.json({ items: await exportByEmail(ctxOf(c).db, email) });
});

api.delete('/respondents', WRITE, async (c) => {
  needRole(c, 'admin');
  const email = (c.req.query('email') ?? '').trim();
  if (!email) throw errors.validation_failed(undefined, { email: 'Enter the email address to delete.' });
  const removed = await deleteByEmail(ctxOf(c), email);
  await auditFromRequest(c, { action: 'respondent.deleted', targetType: 'respondent', summary: `Deleted ${removed} responses for one email address` });
  return c.json({ removed });
});

api.get('/:id', READ, async (c) => {
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const draft = await getDraft(ctx.db, form);
  const published = await getPublished(ctx.db, form);
  return c.json({ ...formView(form), definition: draft, unpublishedChanges: !published || JSON.stringify(published) !== JSON.stringify(draft) });
});

api.patch('/:id', WRITE, async (c) => {
  const body = parse(z.object({ name: z.string().max(120).optional(), slug: z.string().max(60).optional() }), await readJson(c));
  const form = await renameForm(ctxOf(c), c.req.param('id'), body);
  return c.json(formView(form));
});

api.delete('/:id', WRITE, async (c) => {
  const ctx = ctxOf(c);
  const id = c.req.param('id');
  if (c.req.query('permanent') === '1') {
    needRole(c, 'admin');
    await deleteForm(ctx, id);
    await auditFromRequest(c, { action: 'form.deleted', targetType: 'form', targetId: id, summary: 'Deleted a form and its responses for good' });
  } else {
    await trashForm(ctx, id);
    await auditFromRequest(c, { action: 'form.trashed', targetType: 'form', targetId: id, summary: 'Moved a form to the trash' });
  }
  return c.json({ ok: true });
});

api.post('/:id/restore', WRITE, async (c) => c.json(formView(await restoreForm(ctxOf(c), c.req.param('id')))));
api.post('/:id/duplicate', WRITE, async (c) => c.json(formView(await duplicateForm(ctxOf(c), c.req.param('id'), actorOf(c))), 201));

api.put('/:id/draft', WRITE, async (c) => {
  const body = await readJson(c);
  const rev = typeof body.rev === 'number' ? body.rev : undefined;
  const res = await saveDraft(ctxOf(c), c.req.param('id'), body.definition, { ...(rev !== undefined ? { rev } : {}), actor: actorOf(c) });
  return c.json({ rev: res.form.rev, unpublishedChanges: res.unpublishedChanges, definition: res.definition });
});

api.get('/:id/versions', READ, async (c) => c.json({ items: await listVersions(ctxOf(c).db, c.req.param('id')) }));
api.get('/:id/versions/:vid', READ, async (c) => c.json(await getVersion(ctxOf(c).db, c.req.param('id'), c.req.param('vid'))));
api.post('/:id/versions/:vid/restore', WRITE, async (c) => {
  const res = await restoreVersion(ctxOf(c), c.req.param('id'), c.req.param('vid'), actorOf(c));
  return c.json({ rev: res.form.rev, unpublishedChanges: res.unpublishedChanges, definition: res.definition });
});

api.post('/:id/publish', WRITE, async (c) => {
  const form = await publish(ctxOf(c), c.req.param('id'), actorOf(c));
  await auditFromRequest(c, { action: 'form.published', targetType: 'form', targetId: form.id, summary: `Published ${form.name}` });
  return c.json(formView(form));
});
api.post('/:id/close', WRITE, async (c) => c.json(formView(await closeForm(ctxOf(c), c.req.param('id')))));
api.post('/:id/reopen', WRITE, async (c) => c.json(formView(await reopenForm(ctxOf(c), c.req.param('id')))));

api.patch('/:id/settings', WRITE, async (c) => {
  const body = await readJson(c);
  const { password, ...rest } = body;
  const partial = settingsSchema.omit({ passwordHash: true }).partial().safeParse(rest);
  if (!partial.success) throw formErrors.invalid_definition('Some settings need fixing.', Object.fromEntries(partial.error.issues.map((i) => [i.path.join('.') || '_', i.message])));
  const patch = { ...partial.data, ...(password === null ? { password: null } : typeof password === 'string' ? { password } : {}) };
  const form = await updateSettings(ctxOf(c), c.req.param('id'), patch as never);
  return c.json(formView(form));
});

api.post('/:id/images/:kind', WRITE, async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'logo' && kind !== 'cover') throw errors.not_found();
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const data = await c.req.formData().catch(() => null);
  const file = data?.get('file');
  if (!(file instanceof File)) throw errors.validation_failed(undefined, { file: 'Choose an image to upload.' });
  const key = await saveBrandImage(ctx, form.id, kind, file);
  const old = kind === 'logo' ? form.settings.theme.logoKey : form.settings.theme.coverKey;
  const next = await updateSettings(ctx, form.id, { theme: { ...form.settings.theme, [kind === 'logo' ? 'logoKey' : 'coverKey']: key } });
  if (old) await c.env.FILES.delete(old);
  return c.json(formView(next));
});

api.delete('/:id/images/:kind', WRITE, async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'logo' && kind !== 'cover') throw errors.not_found();
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const old = kind === 'logo' ? form.settings.theme.logoKey : form.settings.theme.coverKey;
  const next = await updateSettings(ctx, form.id, { theme: { ...form.settings.theme, [kind === 'logo' ? 'logoKey' : 'coverKey']: null } });
  if (old) await c.env.FILES.delete(old);
  return c.json(formView(next));
});

api.get('/:id/export', READ, async (c) => {
  const body = await exportForm(ctxOf(c).db, c.req.param('id'));
  return c.json(body);
});

api.get('/:id/stats', READ, async (c) => {
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const def = (await getPublished(ctx.db, form)) ?? (await getDraft(ctx.db, form));
  return c.json(await summary(ctx.db, form.id, def, rangeDays(intParam(c.req.query('days'), 30, 1, 365))));
});

api.get('/:id/submissions', READ, async (c) => {
  const ctx = ctxOf(c);
  const id = c.req.param('id');
  await getForm(ctx.db, id);
  const q = queryOf(c);
  const [{ items, total }, counts] = await Promise.all([listSubmissions(ctx.db, id, q), folderCounts(ctx.db, id)]);
  return c.json({ items, total, counts });
});

api.get('/:id/submissions/export.csv', READ, async (c) => {
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const def = (await getPublished(ctx.db, form)) ?? (await getDraft(ctx.db, form));
  const csv = await exportCsv(ctx.db, form.id, def, queryOf(c));
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${form.slug}-responses.csv"`, 'cache-control': 'private, no-store' } });
});

api.post('/:id/submissions/import/preview', WRITE, async (c) => {
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const csv = typeof (await readJson(c)).csv === 'string' ? ((await c.req.json()) as { csv: string }).csv : '';
  return c.json(previewImport((await getPublished(ctx.db, form)) ?? (await getDraft(ctx.db, form)), csv));
});

api.post('/:id/submissions/import', WRITE, async (c) => {
  const body = parse(z.object({ csv: z.string().max(2_000_000), mapping: z.record(z.string(), z.string()) }), await readJson(c));
  const res = await importResponses(ctxOf(c), c.req.param('id'), body.csv, body.mapping);
  await auditFromRequest(c, { action: 'form.responses_imported', targetType: 'form', targetId: c.req.param('id'), summary: `Imported ${res.imported} responses from a spreadsheet` });
  return c.json(res);
});

api.post('/:id/submissions/bulk', WRITE, async (c) => {
  const ctx = ctxOf(c);
  const id = c.req.param('id');
  const { action, ids } = parse(bulkBody, await readJson(c));
  let changed = 0;
  if (action === 'spam') changed = await setSpam(ctx, id, ids, true);
  else if (action === 'not_spam') changed = await setSpam(ctx, id, ids, false);
  else if (action === 'delete') {
    changed = await deleteSubmissions(ctx, id, ids);
    await auditFromRequest(c, { action: 'response.deleted', targetType: 'form', targetId: id, summary: `Deleted ${changed} responses` });
  } else if (action === 'star' || action === 'unstar') changed = await setStarred(ctx.db, id, ids, action === 'star');
  else changed = await markRead(ctx.db, id, ids, action === 'read');
  return c.json({ changed });
});

api.get('/:id/submissions/:sid', READ, async (c) => {
  const ctx = ctxOf(c);
  const res = await getSubmission(ctx.db, c.req.param('id'), c.req.param('sid'));
  return c.json(res);
});

api.post('/:id/submissions/:sid/notes', WRITE, async (c) => {
  const body = parse(z.object({ body: z.string().max(4000) }), await readJson(c));
  return c.json(await addNote(ctxOf(c).db, c.req.param('id'), c.req.param('sid'), body.body, actorOf(c)), 201);
});

api.delete('/:id/submissions/:sid/notes/:nid', WRITE, async (c) => {
  await deleteNote(ctxOf(c).db, c.req.param('sid'), c.req.param('nid'));
  return c.json({ ok: true });
});

api.get('/:id/files/:fid', READ, async (c) => {
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id'));
  const row = await ctx.db.first<{ form_id: string }>('SELECT form_id FROM forms_files WHERE org_id = :org AND id = ?', c.req.param('fid'));
  if (!row || row.form_id !== form.id) throw formErrors.not_found('We couldn’t find that file.');
  return downloadFile(ctx, c.req.param('fid'));
});

