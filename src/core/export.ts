/**
 * Workspace export: everything a workspace stored, as one ZIP with a JSON and a CSV file per table.
 *
 * - `requestExport()` adds a row to `exports` and queues the `core.export` job.
 * - The job streams the ZIP into R2 at `exports/<orgId>/<id>.zip` while it reads the database one
 *   page of 500 rows at a time, so memory stays flat however big the workspace is.
 * - When it finishes it adds a notification and sends the `export-ready` email to the person who
 *   asked. The file can be downloaded for 24 hours, by admins of that workspace only.
 * - A daily schedule deletes expired files.
 *
 * What goes in: every module table (or the module's own `exportData`), workspace settings, module
 * states, the audit log, API key details without the secrets, and the member list.
 *
 * Each table is read twice (once for the JSON file, once for the CSV file). That costs about
 * `2 x ceil(rows / 500)` D1 queries per table, which matters on the Workers Free plan
 * (50 queries per invocation). See docs/export.md.
 */
import type { Env } from '../env';
import { audit } from './audit';
import { csvRow } from './csv';
import { newId } from './db';
import { sendEmail } from './email';
import { renderEmail } from './email-templates';
import { defineErrors, errors } from './errors';
import { MAX_JOB_ATTEMPTS, once, registerCoreJob, registerCoreSchedule } from './jobs';
import { notify } from './notifications';
import { enforceRateLimit } from './ratelimit';
import { allModules, moduleContext } from './registry';
import { ZipWriter } from './zip';

export const EXPORT_HOURS = 24;
export const EXPORT_PAGE_ROWS = 500;
/** An export that has not finished after this long no longer blocks a new one. */
export const EXPORT_STUCK_MS = 30 * 60_000;
/** R2 multipart parts must all be the same size (except the last) and at least 5 MiB. */
export const EXPORT_PART_BYTES = 8 * 1024 * 1024;
const KEEP_ROWS_DAYS = 90;

export const exportErrors = defineErrors('export', {
  already_running: { status: 409, message: 'An export is already running for this workspace. Wait for it to finish.' },
  not_ready: { status: 409, message: 'This export is still being prepared. Try again in a minute.' },
  expired: { status: 410, message: 'This export has expired. Start a new one.' },
  failed: { status: 409, message: 'This export didn’t finish. Start a new one.' },
});

export type ExportStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface ExportItem {
  id: string;
  status: ExportStatus;
  tablesDone: number;
  tablesTotal: number;
  size: number | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  expiresAt: number | null;
  requestedBy: string;
  /** Path to download from. Present only while the file is ready. */
  downloadPath: string | null;
}

interface ExportRow {
  id: string;
  org_id: string;
  requested_by: string;
  requested_email: string | null;
  base_url: string | null;
  status: string;
  tables_done: number;
  tables_total: number;
  size: number | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  expires_at: number | null;
}

export const exportKey = (orgId: string, id: string): string => `exports/${orgId}/${id}.zip`;

function toItem(r: ExportRow, now = Date.now()): ExportItem {
  let status = r.status as ExportStatus;
  if (status === 'done' && r.expires_at !== null && r.expires_at <= now) status = 'expired';
  return {
    id: r.id,
    status,
    tablesDone: r.tables_done,
    tablesTotal: r.tables_total,
    size: r.size,
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
    requestedBy: r.requested_by,
    downloadPath: status === 'done' ? `/api/v1/export/${r.id}/download` : null,
  };
}

// --- Asking for, listing and reading exports --------------------------------------------------

export interface ExportRequest {
  orgId: string;
  userId: string;
  /** Where the "your export is ready" email goes. Leave out to skip the email. */
  email?: string | null;
  /** Public address of the app, for the link in the email. */
  baseUrl: string;
}

/** Start an export. One at a time per workspace. Returns the new row. */
export async function requestExport(env: Env, req: ExportRequest, now = Date.now()): Promise<ExportItem> {
  await enforceRateLimit(env, `export:${req.orgId}`, { limit: 6, windowSec: 3600 }, 'You started a few exports already. Try again in a while.');
  const active = await env.DB.prepare(`SELECT id FROM exports WHERE org_id = ?1 AND status IN ('queued', 'running') AND created_at > ?2 LIMIT 1`)
    .bind(req.orgId, now - EXPORT_STUCK_MS)
    .first<{ id: string }>();
  if (active) throw exportErrors.already_running();

  const id = newId('exp', now);
  await env.DB.prepare(
    `INSERT INTO exports (id, org_id, requested_by, requested_email, base_url, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6)`,
  )
    .bind(id, req.orgId, req.userId, req.email ?? null, req.baseUrl.replace(/\/+$/, ''), now)
    .run();
  await env.JOBS.send({ name: 'core.export', payload: { exportId: id } });
  return (await getExport(env, req.orgId, id, now))!;
}

/** One export of this workspace, or null. Never returns another workspace's export. */
export async function getExport(env: Env, orgId: string, id: string, now = Date.now()): Promise<ExportItem | null> {
  const row = await env.DB.prepare('SELECT * FROM exports WHERE id = ?1 AND org_id = ?2').bind(id, orgId).first<ExportRow>();
  return row ? toItem(row, now) : null;
}

/** Newest first. */
export async function listExports(env: Env, orgId: string, limit = 20, now = Date.now()): Promise<ExportItem[]> {
  const { results } = await env.DB.prepare('SELECT * FROM exports WHERE org_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2')
    .bind(orgId, Math.max(1, Math.min(100, limit)))
    .all<ExportRow>();
  return results.map((r) => toItem(r, now));
}

/** The stored file for a finished export. Throws `not_found`, `export.not_ready`, `export.failed` or `export.expired`. */
export async function openExportFile(
  env: Env,
  orgId: string,
  id: string,
  now = Date.now(),
): Promise<{ item: ExportItem; body: ReadableStream; size: number }> {
  const item = await getExport(env, orgId, id, now);
  if (!item) throw errors.not_found('We couldn’t find that export.');
  if (item.status === 'queued' || item.status === 'running') throw exportErrors.not_ready();
  if (item.status === 'failed') throw exportErrors.failed();
  if (item.status === 'expired') throw exportErrors.expired();
  const obj = await env.FILES.get(exportKey(orgId, id));
  if (!obj) throw exportErrors.expired();
  return { item, body: obj.body, size: obj.size };
}

// --- Reading the data -------------------------------------------------------------------------

type Row = Record<string, unknown>;

export interface ExportSource {
  /** Name used in the file names, such as `links.links` or `core.audit_log`. */
  name: string;
  columns: string[];
  pages(): AsyncIterable<Row[]>;
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Core tables never export anything that looks like a secret. */
const SECRET_COLUMN = /hash|secret|token|password|private/i;
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

async function columnsOf(env: Env, table: string): Promise<string[]> {
  if (!SAFE_NAME.test(table)) return [];
  try {
    const { results } = await env.DB.prepare('SELECT name FROM pragma_table_info(?1) ORDER BY cid').bind(table).all<{ name: string }>();
    return results.map((r) => r.name);
  } catch {
    return [];
  }
}

interface TableSpec {
  name: string;
  table: string;
  /** Columns that may hold the workspace id, in order of preference. */
  orgColumns: string[];
  /** Columns to leave out. Defaults to anything that looks like a secret. */
  exclude?: RegExp;
  /** Also pull `email` and `name` from the user table. */
  withPerson?: boolean;
}

/** A table read one keyset page at a time. Returns null when the table or its workspace column is missing. */
async function tableSource(env: Env, orgId: string, spec: TableSpec): Promise<ExportSource | null> {
  const cols = await columnsOf(env, spec.table);
  if (cols.length === 0) return null;
  const orgCol = spec.orgColumns.find((c) => cols.includes(c));
  if (!orgCol) return null;
  const keep = cols.filter((c) => !(spec.exclude ?? SECRET_COLUMN).test(c));
  const extra: string[] = [];
  let join = '';
  if (spec.withPerson) {
    const userCol = ['user_id', 'userId'].find((c) => cols.includes(c));
    const userCols = await columnsOf(env, 'user');
    if (userCol && userCols.includes('id')) {
      join = ` LEFT JOIN "user" u ON u."id" = t.${q(userCol)}`;
      for (const c of ['email', 'name']) if (userCols.includes(c) && !keep.includes(c)) extra.push(c);
    }
  }
  const select = [...keep.map((c) => `t.${q(c)} AS ${q(c)}`), ...extra.map((c) => `u.${q(c)} AS ${q(c)}`)].join(', ');
  const sql = `SELECT t.rowid AS "__rowid", ${select} FROM ${q(spec.table)} t${join} WHERE t.${q(orgCol)} = ?1 AND t.rowid > ?2 ORDER BY t.rowid LIMIT ?3`;
  return {
    name: spec.name,
    columns: [...keep, ...extra],
    async *pages() {
      let after = 0;
      for (;;) {
        const { results } = await env.DB.prepare(sql).bind(orgId, after, EXPORT_PAGE_ROWS).all<Row>();
        if (results.length === 0) return;
        after = Number(results[results.length - 1]!['__rowid']);
        yield results.map((r) => {
          const { __rowid: _rowid, ...rest } = r;
          return rest;
        });
        if (results.length < EXPORT_PAGE_ROWS) return;
      }
    },
  };
}

function staticSource(name: string, columns: string[], rows: Row[]): ExportSource {
  return {
    name,
    columns,
    async *pages() {
      if (rows.length) yield rows;
    },
  };
}

function columnsFromRows(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** Every table that goes into the export, in file order. Missing core tables are skipped, not errors. */
export async function planSources(env: Env, org: { id: string; name: string; slug: string }): Promise<ExportSource[]> {
  const sources: ExportSource[] = [];

  const settings = await env.DB.prepare('SELECT key, value, updated_at FROM settings WHERE scope = ?1 ORDER BY key').bind(org.id).all<Row>();
  sources.push(staticSource('core.settings', ['key', 'value', 'updated_at'], settings.results));

  const states = await env.DB.prepare('SELECT module_id, enabled, sample, enabled_at, settings FROM module_state WHERE org_id = ?1 ORDER BY module_id')
    .bind(org.id)
    .all<Row>();
  sources.push(staticSource('core.module_state', ['module_id', 'enabled', 'sample', 'enabled_at', 'settings'], states.results));

  const core: TableSpec[] = [
    { name: 'core.audit_log', table: 'audit_log', orgColumns: ['org_id'] },
    { name: 'core.api_keys', table: 'api_keys', orgColumns: ['org_id'] },
    { name: 'core.members', table: 'member', orgColumns: ['organization_id', 'organizationId', 'org_id'], withPerson: true },
  ];
  for (const spec of core) {
    const s = await tableSource(env, org.id, spec);
    if (s) sources.push(s);
  }

  const ctx = await moduleContext(env, org);
  for (const m of allModules()) {
    if (m.exportData) {
      const data = await m.exportData(ctx);
      for (const [table, rows] of Object.entries(data)) sources.push(staticSource(`${m.id}.${table}`, columnsFromRows(rows as Row[]), rows as Row[]));
      continue;
    }
    for (const table of m.tables ?? []) {
      // Module tables are the workspace's own data, so nothing is left out.
      const s = await tableSource(env, org.id, { name: `${m.id}.${table}`, table, orgColumns: ['org_id'], exclude: /^$/ });
      if (s) sources.push(s);
    }
  }
  return sources;
}

// --- Writing to R2 ----------------------------------------------------------------------------

/** Collects ZIP bytes and writes them to R2: multipart when the bucket supports it, one `put` otherwise. */
export class R2Sink {
  private buffer: Uint8Array[] = [];
  private buffered = 0;
  private total = 0;
  private upload: R2MultipartUpload | null = null;
  private parts: R2UploadedPart[] = [];
  private readonly canMultipart: boolean;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    private readonly partBytes = EXPORT_PART_BYTES,
  ) {
    this.canMultipart = typeof (bucket as { createMultipartUpload?: unknown }).createMultipartUpload === 'function';
  }

  get size(): number {
    return this.total;
  }

  write = async (chunk: Uint8Array): Promise<void> => {
    this.buffer.push(chunk);
    this.buffered += chunk.length;
    this.total += chunk.length;
    while (this.canMultipart && this.buffered >= this.partBytes) await this.flushPart(this.take(this.partBytes));
  };

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.buffer[0]!;
      const need = n - at;
      if (head.length <= need) {
        out.set(head, at);
        at += head.length;
        this.buffer.shift();
      } else {
        out.set(head.subarray(0, need), at);
        this.buffer[0] = head.subarray(need);
        at += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  private async flushPart(bytes: Uint8Array): Promise<void> {
    this.upload ??= await this.bucket.createMultipartUpload(this.key, { httpMetadata: { contentType: 'application/zip' } });
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, bytes));
  }

  /** Finish the upload. Call after the ZIP is complete. */
  async close(): Promise<void> {
    if (!this.upload) {
      await this.bucket.put(this.key, this.take(this.buffered), { httpMetadata: { contentType: 'application/zip' } });
      return;
    }
    if (this.buffered > 0) await this.flushPart(this.take(this.buffered));
    await this.upload.complete(this.parts);
  }

  /** Throw away a half-written upload. Never throws. */
  async abort(): Promise<void> {
    try {
      if (this.upload) await this.upload.abort();
      else await this.bucket.delete(this.key);
    } catch {
      // Nothing more to clean up.
    }
  }
}

// --- The job ----------------------------------------------------------------------------------

async function* jsonStream(source: ExportSource, count: { rows: number }): AsyncGenerator<string> {
  yield '[';
  let first = true;
  for await (const page of source.pages()) {
    let out = '';
    for (const row of page) {
      out += (first ? '\n' : ',\n') + JSON.stringify(row);
      first = false;
      count.rows++;
    }
    yield out;
  }
  yield first ? ']\n' : '\n]\n';
}

async function* csvStream(source: ExportSource): AsyncGenerator<string> {
  yield '﻿' + csvRow(source.columns);
  for await (const page of source.pages()) {
    let out = '';
    for (const row of page) out += csvRow(source.columns.map((c) => row[c]));
    yield out;
  }
}

/** Build the whole archive for one export. Exposed for tests; the queue runs it through `core.export`. */
export async function runExport(env: Env, exportId: string, now = Date.now()): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM exports WHERE id = ?1').bind(exportId).first<ExportRow>();
  if (!row || row.status === 'done' || row.status === 'expired') return;
  const orgId = row.org_id;
  const ctx = await moduleContext(env, orgId);

  const sink = new R2Sink(env.FILES, exportKey(orgId, exportId));
  try {
    await env.DB.prepare(`UPDATE exports SET status = 'running', tables_done = 0, error = NULL WHERE id = ?1`).bind(exportId).run();
    const sources = await planSources(env, ctx.org);
    await env.DB.prepare('UPDATE exports SET tables_total = ?2 WHERE id = ?1').bind(exportId, sources.length).run();

    const zip = new ZipWriter(sink.write);
    const stamp = new Date(now);
    const tables: { name: string; rows: number; json: string; csv: string }[] = [];
    let done = 0;
    for (const source of sources) {
      const count = { rows: 0 };
      await zip.addFile(`json/${source.name}.json`, jsonStream(source, count), stamp);
      await zip.addFile(`csv/${source.name}.csv`, csvStream(source), stamp);
      tables.push({ name: source.name, rows: count.rows, json: `json/${source.name}.json`, csv: `csv/${source.name}.csv` });
      await env.DB.prepare('UPDATE exports SET tables_done = ?2 WHERE id = ?1').bind(exportId, ++done).run();
    }
    const manifest = { exportedAt: stamp.toISOString(), workspace: ctx.org, tables, note: 'Each table is a JSON file and a CSV file with the same rows.' };
    await zip.addFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n', stamp);
    await zip.finish();
    await sink.close();
  } catch (err) {
    await sink.abort();
    throw err;
  }

  const finished = Date.now();
  await env.DB.prepare(`UPDATE exports SET status = 'done', size = ?2, completed_at = ?3, expires_at = ?4, error = NULL WHERE id = ?1`)
    .bind(exportId, sink.size, finished, finished + EXPORT_HOURS * 3_600_000)
    .run();
  await audit(env, {
    orgId,
    actorType: 'system',
    action: 'export.completed',
    targetType: 'export',
    targetId: exportId,
    summary: 'A workspace export finished',
    meta: { size: sink.size },
  });
  await tellRequester(env, row);
}

async function tellRequester(env: Env, row: ExportRow): Promise<void> {
  try {
    await notify(env, {
      orgId: row.org_id,
      userId: row.requested_by,
      title: 'Your export is ready',
      body: `It stays available for ${EXPORT_HOURS} hours.`,
      href: `/api/v1/export/${row.id}/download`,
      kind: 'export',
      dedupeKey: `export:${row.id}`,
    });
  } catch (err) {
    console.error('[export] notification failed', err instanceof Error ? err.message : err);
  }
  const to = row.requested_email;
  const link = `${row.base_url ?? env.APP_URL ?? ''}/api/v1/export/${row.id}/download`;
  if (!to || !/^https?:\/\//.test(link)) return;
  try {
    await once(env, `export-email:${row.id}`, 3600, async () => {
      const rendered = await renderEmail(env, { template: 'export-ready', data: { link, hours: EXPORT_HOURS }, orgId: row.org_id });
      await sendEmail(env, { to, ...rendered, template: 'export-ready', orgId: row.org_id });
    });
  } catch (err) {
    console.error('[export] email failed', err instanceof Error ? err.message : err);
  }
}

registerCoreJob('export', async (env, payload, { attempt }) => {
  const exportId = (payload as { exportId?: unknown } | null)?.exportId;
  if (typeof exportId !== 'string') return;
  try {
    await runExport(env, exportId);
  } catch (err) {
    if (attempt >= MAX_JOB_ATTEMPTS) {
      await env.DB.prepare(`UPDATE exports SET status = 'failed', error = ?2 WHERE id = ?1 AND status != 'done'`)
        .bind(exportId, 'The export could not be built. Start a new one, and contact your administrator if it keeps failing.')
        .run();
    }
    throw err;
  }
});

// --- Clean up ---------------------------------------------------------------------------------

/** Delete expired files, mark stuck exports failed and forget old rows. Returns how many files went. */
export async function cleanupExports(env: Env, now = Date.now()): Promise<number> {
  const expired = await env.DB.prepare(`SELECT id, org_id FROM exports WHERE status = 'done' AND expires_at <= ?1 LIMIT 200`)
    .bind(now)
    .all<{ id: string; org_id: string }>();
  if (expired.results.length) {
    await env.FILES.delete(expired.results.map((r) => exportKey(r.org_id, r.id)));
    await env.DB.batch(expired.results.map((r) => env.DB.prepare(`UPDATE exports SET status = 'expired' WHERE id = ?1 AND status = 'done'`).bind(r.id)));
  }
  await env.DB.prepare(`UPDATE exports SET status = 'failed', error = 'The export timed out.' WHERE status IN ('queued', 'running') AND created_at <= ?1`)
    .bind(now - 4 * EXPORT_STUCK_MS)
    .run();
  await env.DB.prepare(`DELETE FROM exports WHERE status IN ('expired', 'failed') AND created_at < ?1`)
    .bind(now - KEEP_ROWS_DAYS * 86_400_000)
    .run();
  return expired.results.length;
}

registerCoreSchedule({
  name: 'export-cleanup',
  every: 'day',
  run: async (env, at) => {
    await cleanupExports(env, at.getTime());
  },
});
