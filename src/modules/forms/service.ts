/**
 * Forms, versions and publishing. Everything here takes a workspace-scoped `db`, so a query cannot
 * reach another workspace. The only cross-workspace lookup is `findPublic`, which starts from a slug.
 */
import { hashPassword } from '../../auth/hasher';
import { newId, parseJson, randomToken, type OrgDb } from '../../core/db';
import { emit } from '../../core/events';
import type { Env } from '../../env';
import { formErrors } from './errors';
import { definitionSchema, DEFAULT_SETTINGS, emptyDefinition, parseDefinition, questions, settingsSchema, type Definition, type FormSettings } from './schema';
import { template } from './templates';

export interface Ctx {
  env: Env;
  db: OrgDb;
}

export interface Actor {
  id?: string | null;
  email?: string | null;
}

export interface FormRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'closed';
  draft_version_id: string | null;
  published_version_id: string | null;
  settings: string;
  response_count: number;
  last_response_at: number | null;
  rev: number;
  sample: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  trashed_at: number | null;
}

export interface Form {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  status: FormRow['status'];
  draftVersionId: string | null;
  publishedVersionId: string | null;
  settings: FormSettings;
  responseCount: number;
  lastResponseAt: number | null;
  rev: number;
  sample: boolean;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  trashedAt: number | null;
}

export interface VersionRow {
  id: string;
  org_id: string;
  form_id: string;
  number: number;
  kind: 'draft' | 'published' | 'snapshot';
  definition: string;
  label: string | null;
  created_by: string | null;
  created_at: number;
}

export const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;
export const SNAPSHOT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function toForm(row: FormRow): Form {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    draftVersionId: row.draft_version_id,
    publishedVersionId: row.published_version_id,
    settings: settingsSchema.parse(parseJson(row.settings, {})),
    responseCount: row.response_count,
    lastResponseAt: row.last_response_at,
    rev: row.rev,
    sample: row.sample === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    trashedAt: row.trashed_at,
  };
}

/** Settings as shown to the editor and the API: the password itself is never sent back. */
export function publicSettings(s: FormSettings): Omit<FormSettings, 'passwordHash'> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = s;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

export function slugify(text: string): string {
  const base = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return base.length >= 3 ? base : `form-${base}`.replace(/-$/, '');
}

const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/;

export async function slugFree(env: Env, slug: string, exceptId?: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM forms_forms WHERE slug = ?1').bind(slug).first<{ id: string }>();
  return !row || row.id === exceptId;
}

async function freshSlug(env: Env, name: string): Promise<string> {
  const base = slugify(name);
  if (await slugFree(env, base)) return base;
  for (let i = 0; i < 6; i++) {
    const candidate = `${base.slice(0, 50)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 5)}`;
    if (await slugFree(env, candidate)) return candidate;
  }
  throw formErrors.slug_taken();
}

export async function getFormRow(db: OrgDb, id: string): Promise<FormRow> {
  const row = await db.get<FormRow>('forms_forms', id);
  if (!row) throw formErrors.not_found();
  return row;
}

export async function getForm(db: OrgDb, id: string): Promise<Form> {
  return toForm(await getFormRow(db, id));
}

export async function listForms(db: OrgDb, opts: { status?: string; q?: string; trashed?: boolean; limit?: number; offset?: number } = {}): Promise<Form[]> {
  const where = ['org_id = :org', opts.trashed ? 'trashed_at IS NOT NULL' : 'trashed_at IS NULL'];
  const params: (string | number)[] = [];
  if (opts.status && ['draft', 'live', 'closed'].includes(opts.status)) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.q) {
    where.push("name LIKE ? ESCAPE '\\'");
    params.push(`%${opts.q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const rows = await db.all<FormRow>(`SELECT * FROM forms_forms WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${Math.max(0, opts.offset ?? 0)}`, ...params);
  return rows.map(toForm);
}

export async function countForms(db: OrgDb, opts: { trashed?: boolean } = {}): Promise<number> {
  const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM forms_forms WHERE org_id = :org AND trashed_at IS ${opts.trashed ? 'NOT ' : ''}NULL`);
  return row?.n ?? 0;
}

export interface CreateInput {
  name?: string;
  templateId?: string;
  definition?: unknown;
  slug?: string;
  settings?: Partial<FormSettings>;
  sample?: boolean;
}

export async function createForm(ctx: Ctx, input: CreateInput, actor: Actor = {}, now = Date.now()): Promise<Form> {
  const tpl = input.templateId ? template(input.templateId) : undefined;
  if (input.templateId && !tpl) throw formErrors.not_found('We couldn’t find that template.');
  const name = (input.name ?? tpl?.formName ?? 'Untitled form').trim().slice(0, 120) || 'Untitled form';
  const definition = input.definition !== undefined ? parseDefinition(input.definition) : (tpl?.build() ?? emptyDefinition());
  let slug = input.slug?.trim().toLowerCase();
  if (slug) {
    if (!SLUG.test(slug)) throw formErrors.slug_taken('Use 3 to 60 lower case letters, digits and dashes for the address.');
    if (!(await slugFree(ctx.env, slug))) throw formErrors.slug_taken();
  } else slug = await freshSlug(ctx.env, name);

  const merged = { ...DEFAULT_SETTINGS, ...(tpl?.settings ?? {}), ...(input.settings ?? {}) };
  if (merged.notify.enabled && merged.notify.emails.length === 0 && actor.email) merged.notify = { enabled: true, emails: [actor.email] };
  const settings = settingsSchema.parse(merged);

  const formId = newId('frm', now);
  const versionId = newId('ver', now);
  await ctx.db.insert('forms_versions', { id: versionId, form_id: formId, number: 1, kind: 'draft', definition: JSON.stringify(definition), created_by: actor.id ?? null, created_at: now });
  try {
    const row = await ctx.db.insert<FormRow>('forms_forms', {
      id: formId, slug, name, status: 'draft', draft_version_id: versionId, published_version_id: null,
      settings: JSON.stringify(settings), response_count: 0, rev: 1, sample: input.sample ? 1 : 0, created_at: now, updated_at: now,
    });
    return toForm(row);
  } catch (err) {
    await ctx.db.remove('forms_versions', versionId);
    // The slug column is unique install-wide; a second request may have taken it since we looked.
    if (String(err).includes('UNIQUE')) throw formErrors.slug_taken();
    throw err;
  }
}

async function versionRow(db: OrgDb, id: string | null): Promise<VersionRow> {
  const row = id ? await db.get<VersionRow>('forms_versions', id) : null;
  if (!row) throw formErrors.version_not_found();
  return row;
}

export async function getDraft(db: OrgDb, form: Form): Promise<Definition> {
  return definitionSchema.parse(parseJson((await versionRow(db, form.draftVersionId)).definition, {}));
}

export async function getPublished(db: OrgDb, form: Form): Promise<Definition | null> {
  if (!form.publishedVersionId) return null;
  return definitionSchema.parse(parseJson((await versionRow(db, form.publishedVersionId)).definition, {}));
}

export interface SaveResult {
  form: Form;
  definition: Definition;
  /** True when the draft now differs from what is live. */
  unpublishedChanges: boolean;
}

export async function saveDraft(ctx: Ctx, formId: string, input: unknown, opts: { rev?: number; actor?: Actor; now?: number } = {}): Promise<SaveResult> {
  const now = opts.now ?? Date.now();
  const form = await getForm(ctx.db, formId);
  if (opts.rev !== undefined && opts.rev !== form.rev) throw formErrors.stale_draft();
  const definition = parseDefinition(input);
  const draft = await versionRow(ctx.db, form.draftVersionId);
  const next = JSON.stringify(definition);
  const changed = draft.definition !== next;
  // Claim the new revision first: of two editors saving at once, only one gets past this line.
  const row = await ctx.db.first<FormRow>(
    'UPDATE forms_forms SET rev = rev + ?, updated_at = ? WHERE org_id = :org AND id = ? AND rev = ? RETURNING *',
    changed ? 1 : 0, changed ? now : form.updatedAt, formId, form.rev,
  );
  if (!row) throw formErrors.stale_draft();
  if (changed) {
    // Keep the state before this editing session so "Version history" has something to go back to.
    const last = await ctx.db.first<{ created_at: number }>("SELECT created_at FROM forms_versions WHERE org_id = :org AND form_id = ? AND kind = 'snapshot' ORDER BY created_at DESC LIMIT 1", formId);
    if (!last || now - last.created_at >= SNAPSHOT_EVERY_MS) {
      await ctx.db.insert('forms_versions', { id: newId('ver', now), form_id: formId, number: 0, kind: 'snapshot', definition: draft.definition, created_by: opts.actor?.id ?? null, created_at: now });
    }
    await ctx.db.update('forms_versions', draft.id, { definition: next, created_at: now });
  }
  const saved = toForm(row);
  return { form: saved, definition, unpublishedChanges: await hasUnpublishedChanges(ctx.db, saved, next) };
}

async function hasUnpublishedChanges(db: OrgDb, form: Form, draftJson: string): Promise<boolean> {
  if (!form.publishedVersionId) return true;
  const pub = await db.get<VersionRow>('forms_versions', form.publishedVersionId);
  return !pub || pub.definition !== draftJson;
}

/** Whether the draft differs from what is live, for the editor's "Unpublished changes" note. */
export async function draftDiffers(db: OrgDb, form: Form): Promise<boolean> {
  return hasUnpublishedChanges(db, form, (await versionRow(db, form.draftVersionId)).definition);
}

export interface VersionInfo {
  id: string;
  kind: VersionRow['kind'];
  number: number;
  label: string | null;
  createdAt: number;
  questions: number;
}

export async function listVersions(db: OrgDb, formId: string): Promise<VersionInfo[]> {
  const rows = await db.all<VersionRow>("SELECT * FROM forms_versions WHERE org_id = :org AND form_id = ? AND kind != 'draft' ORDER BY created_at DESC LIMIT 100", formId);
  return rows.map((r) => {
    const def = definitionSchema.safeParse(parseJson(r.definition, {}));
    return { id: r.id, kind: r.kind, number: r.number, label: r.label, createdAt: r.created_at, questions: def.success ? questions(def.data).length : 0 };
  });
}

export async function getVersion(db: OrgDb, formId: string, versionId: string): Promise<{ info: VersionInfo; definition: Definition }> {
  const row = await db.get<VersionRow>('forms_versions', versionId);
  if (!row || row.form_id !== formId) throw formErrors.version_not_found();
  const definition = definitionSchema.parse(parseJson(row.definition, {}));
  return { info: { id: row.id, kind: row.kind, number: row.number, label: row.label, createdAt: row.created_at, questions: questions(definition).length }, definition };
}

/** Put an older version back as the draft. The draft it replaces is kept in history first. */
export async function restoreVersion(ctx: Ctx, formId: string, versionId: string, actor: Actor = {}, now = Date.now()): Promise<SaveResult> {
  const form = await getForm(ctx.db, formId);
  const { definition } = await getVersion(ctx.db, formId, versionId);
  const draft = await versionRow(ctx.db, form.draftVersionId);
  await ctx.db.insert('forms_versions', { id: newId('ver', now), form_id: formId, number: 0, kind: 'snapshot', label: 'Before restore', definition: draft.definition, created_by: actor.id ?? null, created_at: now });
  return saveDraft(ctx, formId, definition, { actor, now: now + 1 });
}

export async function publish(ctx: Ctx, formId: string, actor: Actor = {}, now = Date.now()): Promise<Form> {
  const form = await getForm(ctx.db, formId);
  const definition = await getDraft(ctx.db, form);
  if (questions(definition).length === 0) throw formErrors.nothing_to_publish();
  const draft = await versionRow(ctx.db, form.draftVersionId);
  const current = form.publishedVersionId ? await ctx.db.get<VersionRow>('forms_versions', form.publishedVersionId) : null;
  let publishedId = form.publishedVersionId;
  if (!current || current.definition !== draft.definition) {
    const top = await ctx.db.first<{ n: number | null }>("SELECT MAX(number) AS n FROM forms_versions WHERE org_id = :org AND form_id = ? AND kind = 'published'", formId);
    publishedId = newId('ver', now);
    await ctx.db.insert('forms_versions', { id: publishedId, form_id: formId, number: (top?.n ?? 0) + 1, kind: 'published', definition: draft.definition, created_by: actor.id ?? null, created_at: now });
  }
  const row = await ctx.db.update<FormRow>('forms_forms', formId, { status: 'live', published_version_id: publishedId, published_at: now, updated_at: now });
  const out = toForm(row!);
  await emit(ctx.env, { orgId: ctx.db.orgId, module: 'forms', name: 'form.published', subject: formId, data: { formId, slug: out.slug, name: out.name }, at: now });
  return out;
}

export async function closeForm(ctx: Ctx, formId: string, now = Date.now()): Promise<Form> {
  const form = await getForm(ctx.db, formId);
  if (form.status !== 'live') return form;
  const row = await ctx.db.update<FormRow>('forms_forms', formId, { status: 'closed', updated_at: now });
  await emit(ctx.env, { orgId: ctx.db.orgId, module: 'forms', name: 'form.closed', subject: formId, data: { formId, slug: form.slug, name: form.name, reason: 'manual' }, at: now });
  return toForm(row!);
}

export async function reopenForm(ctx: Ctx, formId: string, now = Date.now()): Promise<Form> {
  const form = await getForm(ctx.db, formId);
  if (!form.publishedVersionId) throw formErrors.nothing_to_publish('Publish the form first.');
  const row = await ctx.db.update<FormRow>('forms_forms', formId, { status: 'live', updated_at: now });
  return toForm(row!);
}

export interface SettingsPatch extends Partial<Omit<FormSettings, 'passwordHash'>> {
  /** A new password, or null to remove it. Never stored as typed. */
  password?: string | null;
}

export async function updateSettings(ctx: Ctx, formId: string, patch: SettingsPatch, now = Date.now()): Promise<Form> {
  const form = await getForm(ctx.db, formId);
  const { password, ...rest } = patch;
  const next: Record<string, unknown> = { ...form.settings, ...rest };
  if (password === null) next.passwordHash = null;
  else if (typeof password === 'string' && password !== '') {
    if (password.length < 4 || password.length > 100) throw formErrors.bad_password('Use a password of 4 to 100 characters.');
    next.passwordHash = await hashPassword(password, { iterations: 10_000 });
    next.access = 'password';
  }
  if (next.access === 'password' && !next.passwordHash) throw formErrors.bad_password('Set a password to protect this form.');
  if (next.access === 'public') next.passwordHash = null;
  const parsed = settingsSchema.safeParse(next);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw formErrors.invalid_definition('Some settings need fixing.', fields);
  }
  const s = parsed.data;
  if (s.opensAt && s.closesAt && s.closesAt <= s.opensAt) throw formErrors.invalid_definition('The close date must come after the open date.', { closesAt: 'Pick a date after the opening date.' });
  const row = await ctx.db.update<FormRow>('forms_forms', formId, { settings: JSON.stringify(s), updated_at: now });
  return toForm(row!);
}

export async function renameForm(ctx: Ctx, formId: string, input: { name?: string; slug?: string }, now = Date.now()): Promise<Form> {
  const form = await getForm(ctx.db, formId);
  const patch: Record<string, unknown> = { updated_at: now };
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 120);
    if (!name) throw formErrors.invalid_definition('Give the form a name.', { name: 'Give the form a name.' });
    patch.name = name;
  }
  if (input.slug !== undefined && input.slug !== form.slug) {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG.test(slug)) throw formErrors.slug_taken('Use 3 to 60 lower case letters, digits and dashes for the address.');
    if (!(await slugFree(ctx.env, slug, formId))) throw formErrors.slug_taken();
    patch.slug = slug;
  }
  try {
    return toForm((await ctx.db.update<FormRow>('forms_forms', formId, patch))!);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw formErrors.slug_taken();
    throw err;
  }
}

export async function trashForm(ctx: Ctx, formId: string, now = Date.now()): Promise<void> {
  const form = await getForm(ctx.db, formId);
  if (form.status === 'live') await closeForm(ctx, formId, now);
  await ctx.db.update('forms_forms', formId, { trashed_at: now, updated_at: now });
}

export async function restoreForm(ctx: Ctx, formId: string, now = Date.now()): Promise<Form> {
  await getFormRow(ctx.db, formId);
  return toForm((await ctx.db.update<FormRow>('forms_forms', formId, { trashed_at: null, updated_at: now }))!);
}

/** Remove a form and everything that belongs to it, including uploaded files. */
export async function deleteForm(ctx: Ctx, formId: string): Promise<void> {
  await getFormRow(ctx.db, formId);
  const files = await ctx.db.all<{ r2_key: string }>('SELECT r2_key FROM forms_files WHERE org_id = :org AND form_id = ?', formId);
  for (let i = 0; i < files.length; i += 100) await ctx.env.FILES.delete(files.slice(i, i + 100).map((f) => f.r2_key));
  await ctx.env.FILES.delete(await assetKeys(ctx, formId));
  await ctx.db.run('DELETE FROM forms_notes WHERE org_id = :org AND submission_id IN (SELECT id FROM forms_submissions WHERE org_id = :org AND form_id = ?)', formId);
  for (const table of ['forms_files', 'forms_submissions', 'forms_versions', 'forms_stats']) await ctx.db.run(`DELETE FROM ${table} WHERE org_id = :org AND form_id = ?`, formId);
  await ctx.db.remove('forms_forms', formId);
}

async function assetKeys(ctx: Ctx, formId: string): Promise<string[]> {
  const form = await getForm(ctx.db, formId);
  return [form.settings.theme.logoKey, form.settings.theme.coverKey].filter((k): k is string => Boolean(k));
}

export async function duplicateForm(ctx: Ctx, formId: string, actor: Actor = {}, now = Date.now()): Promise<Form> {
  const form = await getForm(ctx.db, formId);
  const definition = await getDraft(ctx.db, form);
  const { passwordHash: _hash, theme, ...rest } = form.settings;
  // Uploaded logo and cover files belong to the original; the copy starts with the default look.
  return createForm(ctx, { name: `${form.name} (copy)`.slice(0, 120), definition, settings: { ...rest, theme: { ...theme, logoKey: null, coverKey: null }, access: 'public' } }, actor, now);
}

// ---------------------------------------------------------------------------------------------
// Export and import of a form's definition as JSON
// ---------------------------------------------------------------------------------------------

export const FORM_FILE_FORMAT = 'toolshed-form';

export async function exportForm(db: OrgDb, formId: string): Promise<Record<string, unknown>> {
  const form = await getForm(db, formId);
  const { passwordHash: _hash, theme, ...settings } = form.settings;
  return {
    format: FORM_FILE_FORMAT,
    version: 1,
    name: form.name,
    definition: await getDraft(db, form),
    // Colors travel with the form; uploaded images do not, they live in this install's storage.
    settings: { ...settings, theme: { ...theme, logoKey: null, coverKey: null } },
  };
}

export async function importForm(ctx: Ctx, file: unknown, actor: Actor = {}): Promise<Form> {
  const body = file as { format?: unknown; name?: unknown; definition?: unknown; settings?: unknown };
  if (!body || body.format !== FORM_FILE_FORMAT || body.definition === undefined) {
    throw formErrors.invalid_definition('That file is not a Toolshed form. Typeform and Tally files can’t be imported yet.');
  }
  const settings = settingsSchema.partial().safeParse(body.settings ?? {});
  const { passwordHash: _hash, access: _access, ...safe } = settings.success ? settings.data : ({} as Partial<FormSettings>);
  return createForm(ctx, { name: typeof body.name === 'string' ? body.name : 'Imported form', definition: body.definition, settings: safe }, actor);
}

// ---------------------------------------------------------------------------------------------
// Public lookup, from a slug
// ---------------------------------------------------------------------------------------------

export interface PublicForm {
  form: Form;
  definition: Definition;
}

// A published version never changes, so its parsed definition can be kept for the life of the isolate.
const definitionCache = new Map<string, Definition>();

export async function findPublic(env: Env, slug: string): Promise<PublicForm | null> {
  const row = await env.DB.prepare(
    `SELECT f.*, v.definition AS v_definition FROM forms_forms f
     JOIN forms_versions v ON v.id = f.published_version_id WHERE f.slug = ?1 AND f.trashed_at IS NULL`,
  )
    .bind(slug)
    .first<FormRow & { v_definition: string }>();
  if (!row) return null;
  let definition = definitionCache.get(row.published_version_id!);
  if (!definition) {
    definition = definitionSchema.parse(parseJson(row.v_definition, {}));
    if (definitionCache.size > 200) definitionCache.clear();
    definitionCache.set(row.published_version_id!, definition);
  }
  const { v_definition: _v, ...formRow } = row;
  return { form: toForm(formRow), definition };
}

/** Whether a live form can take a response right now, and if not, why. */
export function availability(form: Form, now = Date.now()): { open: true } | { open: false; reason: 'closed' | 'not_yet' | 'full' } {
  if (form.status !== 'live') return { open: false, reason: 'closed' };
  const { opensAt, closesAt, cap } = form.settings;
  if (opensAt && now < opensAt) return { open: false, reason: 'not_yet' };
  if (closesAt && now >= closesAt) return { open: false, reason: 'closed' };
  if (cap && form.responseCount >= cap) return { open: false, reason: 'full' };
  return { open: true };
}

/** Delete history snapshots older than 30 days. Published versions are kept for good. */
export async function purgeSnapshots(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM forms_versions WHERE kind = 'snapshot' AND created_at < ?1").bind(now - SNAPSHOT_KEEP_MS).run();
}
