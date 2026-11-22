/** Templates: create, edit, publish, copy, export and import. No HTTP in here. */
import { z } from 'zod';
import type { OrgDb, Row } from '../../core/db';
import { newId, parseJson, randomToken } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { enqueue } from '../../core/jobs';
import type { Env } from '../../env';
import { imageErrors } from './errors';
import { blankDoc, docSchema, MAX_CANVAS, MAX_DOC_BYTES, MIN_CANVAS, PRESETS, type TemplateDoc } from './schema';
import { starterByKey } from './starters';

export const MAX_TEMPLATES = 200;
export const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export interface TemplateRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  doc: string;
  published_doc: string | null;
  version: number;
  open: number;
  page: number;
  max_renders: number | null;
  renders: number;
  first_request_at: number | null;
  starter: string | null;
  sample: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

export interface TemplateSummary {
  id: string;
  slug: string;
  name: string;
  width: number;
  height: number;
  /** 0 until the template is published for the first time. */
  version: number;
  published: boolean;
  /** True when the editor holds changes that image URLs do not show yet. */
  unpublishedChanges: boolean;
  open: boolean;
  page: boolean;
  maxRenders: number | null;
  renders: number;
  firstRequestAt: number | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface Template extends TemplateSummary {
  doc: TemplateDoc;
  publishedDoc: TemplateDoc | null;
}

const EMPTY: TemplateDoc = blankDoc(1200, 630);

export function toTemplate(row: TemplateRow): Template {
  const doc = parseJson<TemplateDoc>(row.doc, EMPTY);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    width: doc.width,
    height: doc.height,
    version: row.version,
    published: row.published_doc !== null,
    unpublishedChanges: row.published_doc !== row.doc,
    open: row.open === 1,
    page: row.page === 1,
    maxRenders: row.max_renders,
    renders: row.renders,
    firstRequestAt: row.first_request_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    doc,
    publishedDoc: row.published_doc === null ? null : parseJson<TemplateDoc | null>(row.published_doc, null),
  };
}

function toSummary(row: TemplateRow): TemplateSummary {
  const { doc: _doc, publishedDoc: _published, ...summary } = toTemplate(row);
  return summary;
}

/** Checks a template document and its stored size. Throws `validation_failed` with a message per field. */
export function parseDoc(input: unknown): TemplateDoc {
  const doc = parse(docSchema, input);
  if (JSON.stringify(doc).length > MAX_DOC_BYTES) {
    throw errors.validation_failed('This template is too large to save. Remove some layers or shorten long text.');
  }
  return doc;
}

function slugBase(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return base || 'image';
}

function randomSuffix(): string {
  return randomToken(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .padEnd(4, '0')
    .slice(0, 4);
}

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** One page of a table, newest first. Ids sort by time, so the last id is the cursor. */
export async function pageOf<T extends { id: string }>(db: OrgDb, table: string, opts: { limit?: number; cursor?: string | null; and?: string; params?: (string | number)[] }): Promise<Page<T>> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25) || 25));
  const cursor = opts.cursor && /^[a-z0-9_]{1,80}$/.test(opts.cursor) ? opts.cursor : null;
  const rows = await db.all<T>(
    `SELECT * FROM ${table} WHERE org_id = :org${opts.and ? ` AND ${opts.and}` : ''}${cursor ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    ...(opts.params ?? []),
    ...(cursor ? [cursor] : []),
    limit + 1,
  );
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

export async function listTemplates(db: OrgDb, opts: { limit?: number; cursor?: string | null } = {}): Promise<Page<TemplateSummary>> {
  const page = await pageOf<TemplateRow>(db, 'img_templates', opts);
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}

export async function templateRow(db: OrgDb, id: string): Promise<TemplateRow> {
  const row = await db.get<TemplateRow>('img_templates', id);
  if (!row) throw errors.not_found('We couldn’t find that template. It may have been deleted.');
  return row;
}

export async function getTemplate(db: OrgDb, id: string): Promise<Template> {
  return toTemplate(await templateRow(db, id));
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name.').max(80, 'Keep the name under 80 characters.').optional(),
  starter: z.string().max(40).optional(),
  preset: z.string().max(40).optional(),
  width: z.number().int().min(MIN_CANVAS).max(MAX_CANVAS).optional(),
  height: z.number().int().min(MIN_CANVAS).max(MAX_CANVAS).optional(),
  doc: z.unknown().optional(),
  publish: z.boolean().optional(),
});

export interface Actor {
  id?: string | null;
}

interface CreateExtras {
  sample?: boolean;
}

/**
 * Makes a template from a starter, a size preset, a width and height, or a full document.
 * With `publish` it is live straight away, which is what the first-run flow uses.
 */
export async function createTemplate(env: Env, db: OrgDb, input: unknown, actor: Actor = {}, now = Date.now(), extras: CreateExtras = {}): Promise<Template> {
  const data = parse(createSchema, input);
  if ((await db.count('img_templates')) >= MAX_TEMPLATES) throw imageErrors.too_many_templates();

  let doc: TemplateDoc;
  let name = data.name;
  let starter: string | null = null;
  if (data.doc !== undefined) doc = parseDoc(data.doc);
  else if (data.starter) {
    const found = starterByKey(data.starter);
    if (!found) throw errors.validation_failed('There is no starter with that name.', { starter: 'Pick one of the starters in the list.' });
    doc = parseDoc(found.doc);
    name ??= found.name;
    starter = found.key;
  } else {
    const preset = PRESETS.find((p) => p.id === data.preset);
    if (data.preset && !preset) throw errors.validation_failed('There is no size with that name.', { preset: 'Pick one of the sizes in the list.' });
    doc = blankDoc(data.width ?? preset?.width ?? 1200, data.height ?? preset?.height ?? 630);
  }
  name ??= 'Untitled image';

  const json = JSON.stringify(doc);
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await db.insert<TemplateRow>('img_templates', {
        id: newId('imgt', now),
        slug: `${slugBase(name)}-${randomSuffix()}`,
        name,
        doc: json,
        published_doc: data.publish ? json : null,
        version: data.publish ? 1 : 0,
        starter,
        sample: extras.sample ? 1 : 0,
        created_by: actor.id ?? null,
        created_at: now,
        updated_at: now,
        published_at: data.publish ? now : null,
      });
      await emit(env, { orgId: db.orgId, module: 'images', name: 'template.created', subject: row.id, data: { id: row.id, slug: row.slug, name: row.name, width: doc.width, height: doc.height }, at: now });
      return toTemplate(row);
    } catch (err) {
      // The slug is unique across the install; a clash with the random ending is rare, so try again.
      if (!isUniqueError(err) || attempt >= 3) throw err;
    }
  }
}

const updateSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name.').max(80, 'Keep the name under 80 characters.').optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, 'Use 3 to 50 lowercase letters, numbers and dashes. Start and end with a letter or number.')
    .optional(),
  doc: z.unknown().optional(),
  open: z.boolean().optional(),
  page: z.boolean().optional(),
  maxRenders: z.number().int().min(1, 'Use 1 or more, or leave it empty for no limit.').max(10_000_000).nullable().optional(),
});

/** Changes a template's draft or its settings. Image URLs keep the published look until `publishTemplate`. */
export async function updateTemplate(db: OrgDb, id: string, input: unknown, now = Date.now()): Promise<Template> {
  const data = parse(updateSchema, input);
  const current = await templateRow(db, id);
  const patch: Row = { updated_at: now };
  if (data.name !== undefined) patch.name = data.name;
  if (data.doc !== undefined) patch.doc = JSON.stringify(parseDoc(data.doc));
  if (data.open !== undefined) patch.open = data.open ? 1 : 0;
  if (data.page !== undefined) patch.page = data.page ? 1 : 0;
  if (data.maxRenders !== undefined) patch.max_renders = data.maxRenders;
  if (data.slug !== undefined && data.slug !== current.slug) {
    const taken = await db.d1.prepare('SELECT id FROM img_templates WHERE slug = ?1').bind(data.slug).first<{ id: string }>();
    if (taken) throw imageErrors.slug_taken(undefined, { slug: 'Another template already uses that URL name.' });
    patch.slug = data.slug;
  }
  try {
    const row = await db.update<TemplateRow>('img_templates', id, patch);
    if (!row) throw errors.not_found('We couldn’t find that template. It may have been deleted.');
    return toTemplate(row);
  } catch (err) {
    if (isUniqueError(err)) throw imageErrors.slug_taken(undefined, { slug: 'Another template already uses that URL name.' });
    throw err;
  }
}

/** Makes the draft the look every image URL draws from now on. Pinned URLs keep what they already made. */
export async function publishTemplate(env: Env, db: OrgDb, id: string, now = Date.now()): Promise<Template> {
  const current = await templateRow(db, id);
  if (current.published_doc === current.doc) return toTemplate(current);
  parseDoc(parseJson<unknown>(current.doc, null));
  const row = await db.update<TemplateRow>('img_templates', id, { published_doc: current.doc, version: current.version + 1, published_at: now, updated_at: now });
  if (!row) throw errors.not_found('We couldn’t find that template. It may have been deleted.');
  await emit(env, { orgId: db.orgId, module: 'images', name: 'template.updated', subject: row.id, data: { id: row.id, slug: row.slug, name: row.name, version: row.version }, at: now });
  return toTemplate(row);
}

/** Drops unpublished changes and goes back to the published look. */
export async function revertTemplate(db: OrgDb, id: string, now = Date.now()): Promise<Template> {
  const current = await templateRow(db, id);
  if (current.published_doc === null) return toTemplate(current);
  const row = await db.update<TemplateRow>('img_templates', id, { doc: current.published_doc, updated_at: now });
  return toTemplate(row ?? current);
}

export async function duplicateTemplate(env: Env, db: OrgDb, id: string, actor: Actor = {}, now = Date.now()): Promise<Template> {
  const source = await getTemplate(db, id);
  return createTemplate(env, db, { name: `${source.name} copy`.slice(0, 80), doc: source.doc }, actor, now);
}

/** Deletes a template now and its stored images in the background. Its URLs stop working at once. */
export async function deleteTemplate(env: Env, db: OrgDb, id: string): Promise<void> {
  await templateRow(db, id);
  await db.remove('img_templates', id);
  await enqueue(env, 'images.purge', { orgId: db.orgId, templateId: id, keepBaked: false });
}

/** Empties a template's stored images, so each URL is drawn again on its next request. PNG files made in the browser are kept. */
export async function clearRenders(env: Env, db: OrgDb, id: string): Promise<void> {
  await templateRow(db, id);
  await enqueue(env, 'images.purge', { orgId: db.orgId, templateId: id, keepBaked: true });
}

export const EXPORT_KIND = 'toolshed.images.template';

export interface TemplateFile {
  kind: typeof EXPORT_KIND;
  v: 1;
  name: string;
  doc: TemplateDoc;
}

/** A template as a file someone can keep, share or import into another workspace. Uploaded pictures and fonts are not inside it. */
export function exportTemplate(template: Template): TemplateFile {
  return { kind: EXPORT_KIND, v: 1, name: template.name, doc: template.doc };
}

const fileSchema = z.object({ kind: z.literal(EXPORT_KIND), v: z.literal(1), name: z.string().trim().min(1).max(80), doc: z.unknown() });

export async function importTemplate(env: Env, db: OrgDb, input: unknown, actor: Actor = {}, now = Date.now()): Promise<Template> {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw imageErrors.bad_template();
    }
  }
  const file = fileSchema.safeParse(data);
  if (!file.success) throw imageErrors.bad_template();
  return createTemplate(env, db, { name: file.data.name, doc: file.data.doc }, actor, now);
}
