/**
 * Batches: many images from one template, drawn in the background a few at a time so no single
 * run goes over a Worker's limits. Rows come as JSON or as CSV text whose header row names the
 * template's fields.
 */
import { z } from 'zod';
import type { OrgDb } from '../../core/db';
import { newId, orgDb, parseJson } from '../../core/db';
import { parseCsv, rowsToObjects } from '../../core/csv-parse';
import { toCsv } from '../../core/csv';
import { AppError, errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { enqueue } from '../../core/jobs';
import { ZipWriter } from '../../core/zip';
import type { Env } from '../../env';
import { imageErrors } from './errors';
import { renderKey } from './keys';
import type { TemplateDoc } from './schema';
import { renderToStorage } from './serve';
import { getTemplate, pageOf, type Actor, type Page } from './templates';
import { FORMATS, normaliseValues, type Format } from './urls';

export const MAX_BATCH_ROWS = 100;
const MAX_INPUT_BYTES = 256 * 1024;
/** Rows drawn per background run. A PNG costs far more CPU than an SVG, so it gets a run to itself. */
const CHUNK: Record<Format, number> = { svg: 5, png: 1 };

export type BatchStatus = 'queued' | 'running' | 'done' | 'failed';

export interface BatchResult {
  /** 1 for the first data row. */
  row: number;
  url?: string;
  hash?: string;
  bytes?: number;
  /** Set instead of `url` when the row could not be drawn. */
  error?: string;
  message?: string;
}

interface BatchRow {
  id: string;
  org_id: string;
  template_id: string;
  name: string;
  format: Format;
  width: number | null;
  base_url: string;
  status: BatchStatus;
  total: number;
  done: number;
  failed: number;
  input: string;
  results: string;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface BatchSummary {
  id: string;
  templateId: string;
  name: string;
  format: Format;
  width: number | null;
  status: BatchStatus;
  total: number;
  done: number;
  failed: number;
  createdAt: number;
  finishedAt: number | null;
}

export interface Batch extends BatchSummary {
  results: BatchResult[];
}

function toSummary(row: BatchRow): BatchSummary {
  return {
    id: row.id,
    templateId: row.template_id,
    name: row.name,
    format: row.format,
    width: row.width,
    status: row.status,
    total: row.total,
    done: row.done,
    failed: row.failed,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toBatch(row: BatchRow): Batch {
  return { ...toSummary(row), results: parseJson<BatchResult[]>(row.results, []) };
}

const createSchema = z.object({
  templateId: z.string().min(1, 'Pick a template.').max(80),
  name: z.string().trim().max(80).optional(),
  format: z.enum(FORMATS).default('svg'),
  width: z.number().int().positive().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  csv: z.string().max(MAX_INPUT_BYTES, 'That file is too large. A batch can hold 100 rows at most.').optional(),
});

/** Rows from CSV text. Column names are matched to field names without regard to case. */
function rowsFromCsv(doc: TemplateDoc, text: string): Record<string, string>[] {
  const csv = parseCsv(text, { maxRows: MAX_BATCH_ROWS + 1 });
  const names = new Map(doc.fields.map((field) => [field.name.toLowerCase(), field.name]));
  const headers = csv.headers.map((header) => names.get(header.trim().toLowerCase()) ?? '');
  if (!headers.some(Boolean)) {
    const wanted = doc.fields.map((field) => field.name).join(', ');
    throw errors.validation_failed('The first row must name the template’s fields.', { csv: `Start with a header row that names this template’s fields: ${wanted}.` });
  }
  return rowsToObjects(headers, csv.rows);
}

/** Checks the rows, stores the batch and starts it in the background. */
export async function createBatch(env: Env, db: OrgDb, input: unknown, base: string, actor: Actor = {}, now = Date.now()): Promise<Batch> {
  const data = parse(createSchema, input);
  const template = await getTemplate(db, data.templateId);
  if (!template.publishedDoc) throw imageErrors.not_published();
  const raw: Record<string, unknown>[] = data.rows ?? (data.csv !== undefined ? rowsFromCsv(template.publishedDoc, data.csv) : []);
  if (raw.length === 0) throw imageErrors.batch_empty();
  if (raw.length > MAX_BATCH_ROWS) throw imageErrors.batch_too_large();
  const rows = raw.map((row) => normaliseValues(template.publishedDoc!, row));
  const stored = JSON.stringify(rows);
  if (stored.length > MAX_INPUT_BYTES) throw errors.too_large('These rows hold too much text for one batch. Split them into smaller batches.');

  const row = await db.insert<BatchRow>('img_batches', {
    id: newId('imgb', now),
    template_id: template.id,
    name: data.name || `${template.name}, ${rows.length} ${rows.length === 1 ? 'image' : 'images'}`,
    format: data.format,
    width: data.width ?? null,
    base_url: base,
    status: 'queued',
    total: rows.length,
    input: stored,
    created_by: actor.id ?? null,
    created_at: now,
  });
  await enqueue(env, 'images.batch', { orgId: db.orgId, batchId: row.id });
  return toBatch(row);
}

export async function listBatches(db: OrgDb, opts: { limit?: number; cursor?: string | null } = {}): Promise<Page<BatchSummary>> {
  const page = await pageOf<BatchRow>(db, 'img_batches', opts);
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}

async function batchRow(db: OrgDb, id: string): Promise<BatchRow> {
  const row = await db.get<BatchRow>('img_batches', id);
  if (!row) throw errors.not_found('We couldn’t find that batch. It may have been deleted.');
  return row;
}

export async function getBatch(db: OrgDb, id: string): Promise<Batch> {
  return toBatch(await batchRow(db, id));
}

/** Removes a finished batch from the list. Its images stay in storage and keep working. */
export async function deleteBatch(db: OrgDb, id: string): Promise<void> {
  const row = await batchRow(db, id);
  if (row.status === 'queued' || row.status === 'running') throw imageErrors.batch_running();
  await db.remove('img_batches', id);
}

/**
 * The background job. Draws the next few rows, saves where it got to, and queues itself again
 * until every row is done. A second delivery of the same message finds nothing left to claim.
 */
export async function runBatch(env: Env, payload: unknown, now = Date.now()): Promise<void> {
  const { orgId, batchId } = parse(z.object({ orgId: z.string().min(1), batchId: z.string().min(1) }), payload);
  const db = orgDb(env.DB, orgId);
  const row = await db.get<BatchRow>('img_batches', batchId);
  if (!row || row.status === 'done' || row.status === 'failed') return;

  const rows = parseJson<Record<string, string>[]>(row.input, []);
  const results = parseJson<BatchResult[]>(row.results, []);
  const start = results.length;
  let failed = row.failed;
  for (let i = start; i < Math.min(rows.length, start + CHUNK[row.format]); i++) {
    try {
      const image = await renderToStorage(env, db, row.template_id, { values: rows[i], format: row.format, width: row.width ?? undefined, source: 'batch', base: row.base_url }, now);
      results.push({ row: i + 1, url: image.url, hash: image.hash, bytes: image.bytes });
    } catch (err) {
      const known = err instanceof AppError ? err : imageErrors.render_failed();
      if (!(err instanceof AppError)) console.error('[images] batch row failed', err);
      results.push({ row: i + 1, error: known.code, message: known.message });
      failed++;
    }
  }

  const finished = results.length >= rows.length;
  const status: BatchStatus = !finished ? 'running' : failed === rows.length ? 'failed' : 'done';
  const saved = await db.run(
    `UPDATE img_batches SET results = ?, done = ?, failed = ?, status = ?, finished_at = ?
     WHERE org_id = :org AND id = ? AND done + failed = ?`,
    JSON.stringify(results),
    results.length - failed,
    failed,
    status,
    finished ? now : null,
    row.id,
    start,
  );
  // Someone else moved this batch on while we were drawing: they own the next step.
  if (saved.changes === 0) return;
  if (!finished) {
    await enqueue(env, 'images.batch', { orgId, batchId });
    return;
  }
  await emit(env, {
    orgId,
    module: 'images',
    name: 'batch.completed',
    subject: row.id,
    data: { id: row.id, templateId: row.template_id, total: rows.length, done: results.length - failed, failed },
    at: now,
  });
}

/** The results as a spreadsheet: one line per row with its URL, or why it failed. */
export function batchCsv(batch: Batch): string {
  return toCsv(
    batch.results.map((r) => ({ row: r.row, url: r.url ?? '', error: r.error ?? '', message: r.error ? (r.message ?? '') : '' })),
    { columns: ['row', 'url', 'error', 'message'] },
  );
}

/**
 * Streams every finished image of a batch into one ZIP, read from storage one file at a time.
 * Nothing is kept: the archive is built again on each download.
 */
export async function writeBatchZip(env: Env, db: OrgDb, batch: Batch, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
  const zip = new ZipWriter(sink);
  const modified = new Date(batch.finishedAt ?? batch.createdAt);
  const seen = new Set<string>();
  for (const result of batch.results) {
    // Two rows with the same values share one image; it goes into the archive once.
    if (!result.hash || seen.has(result.hash)) continue;
    seen.add(result.hash);
    const object = await env.FILES.get(renderKey(db.orgId, result.hash, batch.format));
    if (!object) continue;
    await zip.addFile(`${String(result.row).padStart(3, '0')}.${batch.format}`, new Uint8Array(await object.arrayBuffer()), modified);
  }
  await zip.addFile('results.csv', batchCsv(batch), modified);
  await zip.finish();
}
