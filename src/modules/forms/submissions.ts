/**
 * Reading and managing the responses a form has collected. Everything takes a workspace-scoped db.
 * Marking spam or deleting a response also takes its numbers back out of the stats rollups, so the
 * summary stays true without scanning every row.
 */
import { newId, parseJson, type OrgDb } from '../../core/db';
import { csvRow } from '../../core/csv';
import { emit } from '../../core/events';
import { formErrors } from './errors';
import { displayValue, type Answers, type FileRef } from './logic';
import { allFields, definitionSchema, DISPLAY_TYPES, type Definition } from './schema';
import { getFormRow, toForm, type Ctx, type Form } from './service';
import { bump, responseEntries } from './stats';
import { deleteUploadsOf } from './uploads';

export interface SubmissionRow {
  id: string;
  org_id: string;
  form_id: string;
  version_id: string;
  status: 'complete' | 'partial' | 'spam';
  answers: string;
  score: number | null;
  calcs: string;
  ending_id: string | null;
  respondent_email: string | null;
  search_text: string;
  meta: string;
  visitor_id: string | null;
  client_id: string | null;
  content_hash: string | null;
  starred: number;
  read_at: number | null;
  sample: number;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface Submission {
  id: string;
  formId: string;
  versionId: string;
  status: SubmissionRow['status'];
  answers: Answers;
  score: number | null;
  calcs: Record<string, number>;
  endingId: string | null;
  email: string | null;
  meta: Record<string, string>;
  starred: boolean;
  read: boolean;
  sample: boolean;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  submissionId: string;
  body: string;
  authorId: string | null;
  authorLabel: string;
  createdAt: number;
}

export function toSubmission(r: SubmissionRow): Submission {
  return {
    id: r.id,
    formId: r.form_id,
    versionId: r.version_id,
    status: r.status,
    answers: parseJson<Answers>(r.answers, {}),
    score: r.score,
    calcs: parseJson<Record<string, number>>(r.calcs, {}),
    endingId: r.ending_id,
    email: r.respondent_email,
    meta: parseJson<Record<string, string>>(r.meta, {}),
    starred: r.starred === 1,
    read: r.read_at !== null,
    sample: r.sample === 1,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ListQuery {
  status?: 'complete' | 'partial' | 'spam' | 'all';
  q?: string;
  from?: number;
  to?: number;
  starred?: boolean;
  unread?: boolean;
  /** Show only responses where this question has this answer. Matched against the stored value. */
  field?: string;
  value?: string;
  email?: string;
  limit?: number;
  offset?: number;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function where(formId: string, q: ListQuery): { sql: string; args: (string | number)[] } {
  const parts = ['org_id = :org', 'form_id = ?'];
  const args: (string | number)[] = [formId];
  const status = q.status ?? 'complete';
  if (status !== 'all') {
    parts.push('status = ?');
    args.push(status);
  }
  if (q.q?.trim()) {
    parts.push("search_text LIKE ? ESCAPE '\\'");
    args.push(`%${likeEscape(q.q.trim().toLowerCase())}%`);
  }
  if (q.from) {
    parts.push('created_at >= ?');
    args.push(q.from);
  }
  if (q.to) {
    parts.push('created_at < ?');
    args.push(q.to);
  }
  if (q.starred) parts.push('starred = 1');
  if (q.unread) parts.push('read_at IS NULL');
  if (q.email) {
    parts.push('respondent_email = ?');
    args.push(q.email.trim().toLowerCase());
  }
  if (q.field && /^[a-z][a-z0-9_]{0,40}$/.test(q.field) && q.value !== undefined) {
    // json_each covers both a single value and a list of picked choices.
    parts.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(answers, '$.${q.field}') = 'array' THEN json_extract(answers, '$.${q.field}') ELSE json_array(json_extract(answers, '$.${q.field}')) END) WHERE CAST(value AS TEXT) = ?)`);
    args.push(q.value);
  }
  return { sql: parts.join(' AND '), args };
}

export async function listSubmissions(db: OrgDb, formId: string, q: ListQuery = {}): Promise<{ items: Submission[]; total: number }> {
  const w = where(formId, q);
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const [rows, count] = await Promise.all([
    db.all<SubmissionRow>(`SELECT * FROM forms_submissions WHERE ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, ...w.args),
    db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM forms_submissions WHERE ${w.sql}`, ...w.args),
  ]);
  return { items: rows.map(toSubmission), total: count?.n ?? 0 };
}

/** How many responses sit in each folder, for the tabs above the list. */
export async function folderCounts(db: OrgDb, formId: string): Promise<{ complete: number; partial: number; spam: number }> {
  const rows = await db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM forms_submissions WHERE org_id = :org AND form_id = ? GROUP BY status', formId);
  const out = { complete: 0, partial: 0, spam: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.n;
  return out;
}

async function rowOf(db: OrgDb, formId: string, id: string): Promise<SubmissionRow> {
  const row = await db.first<SubmissionRow>('SELECT * FROM forms_submissions WHERE org_id = :org AND form_id = ? AND id = ?', formId, id);
  if (!row) throw formErrors.submission_not_found();
  return row;
}

export async function getSubmission(db: OrgDb, formId: string, id: string): Promise<{ submission: Submission; notes: Note[]; files: (FileRef & { fieldId: string })[] }> {
  const row = await rowOf(db, formId, id);
  const [notes, files] = await Promise.all([
    db.all<{ id: string; submission_id: string; body: string; author_id: string | null; author_label: string; created_at: number }>('SELECT * FROM forms_notes WHERE org_id = :org AND submission_id = ? ORDER BY created_at', id),
    db.all<{ id: string; name: string; size: number; type: string; field_id: string }>('SELECT id, name, size, type, field_id FROM forms_files WHERE org_id = :org AND submission_id = ?', id),
  ]);
  return {
    submission: toSubmission(row),
    notes: notes.map((n) => ({ id: n.id, submissionId: n.submission_id, body: n.body, authorId: n.author_id, authorLabel: n.author_label, createdAt: n.created_at })),
    files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type, fieldId: f.field_id })),
  };
}

export async function definitionFor(db: OrgDb, versionId: string): Promise<Definition> {
  const v = await db.get<{ definition: string }>('forms_versions', versionId);
  return definitionSchema.parse(parseJson(v?.definition, {}));
}

export async function markRead(db: OrgDb, formId: string, ids: string[], read: boolean, now = Date.now()): Promise<number> {
  const clean = ids.slice(0, 500);
  if (clean.length === 0) return 0;
  const res = await db.run(`UPDATE forms_submissions SET read_at = ? WHERE org_id = :org AND form_id = ? AND id IN (${clean.map(() => '?').join(',')})`, read ? now : null, formId, ...clean);
  return res.changes;
}

export async function setStarred(db: OrgDb, formId: string, ids: string[], starred: boolean): Promise<number> {
  const clean = ids.slice(0, 500);
  if (clean.length === 0) return 0;
  const res = await db.run(`UPDATE forms_submissions SET starred = ? WHERE org_id = :org AND form_id = ? AND id IN (${clean.map(() => '?').join(',')})`, starred ? 1 : 0, formId, ...clean);
  return res.changes;
}

export async function addNote(db: OrgDb, formId: string, submissionId: string, body: string, actor: { id?: string | null; email?: string | null }, now = Date.now()): Promise<Note> {
  await rowOf(db, formId, submissionId);
  const text = body.trim();
  if (!text) throw formErrors.answers_invalid('Write something before you add the note.', { body: 'Write something before you add the note.' });
  if (text.length > 4000) throw formErrors.answers_invalid('Keep notes under 4,000 characters.', { body: 'Keep notes under 4,000 characters.' });
  const id = newId('not', now);
  const label = actor.email ?? 'Someone on the team';
  await db.insert('forms_notes', { id, submission_id: submissionId, body: text, author_id: actor.id ?? null, author_label: label, created_at: now });
  return { id, submissionId, body: text, authorId: actor.id ?? null, authorLabel: label, createdAt: now };
}

export async function deleteNote(db: OrgDb, submissionId: string, noteId: string): Promise<void> {
  const res = await db.run('DELETE FROM forms_notes WHERE org_id = :org AND submission_id = ? AND id = ?', submissionId, noteId);
  if (!res.changes) throw formErrors.submission_not_found('We couldn’t find that note.');
}

async function loadMany(db: OrgDb, formId: string, ids: string[]): Promise<SubmissionRow[]> {
  const clean = [...new Set(ids)].slice(0, 500);
  if (clean.length === 0) return [];
  return db.all<SubmissionRow>(`SELECT * FROM forms_submissions WHERE org_id = :org AND form_id = ? AND id IN (${clean.map(() => '?').join(',')})`, formId, ...clean);
}

/** The numbers a response added to the rollups, so they can be added or taken back. */
async function adjust(ctx: Ctx, form: Form, rows: SubmissionRow[], sign: 1 | -1, now: number): Promise<void> {
  const defs = new Map<string, Definition>();
  for (const r of rows) {
    if (r.status === 'partial') continue;
    let def = defs.get(r.version_id);
    if (!def) {
      def = await definitionFor(ctx.db, r.version_id);
      defs.set(r.version_id, def);
    }
    const answers = parseJson<Answers>(r.answers, {});
    await bump(ctx.env, form.orgId, form.id, r.completed_at ?? r.created_at, responseEntries(def, answers, r.duration_ms, sign));
  }
}

/** Move responses into or out of the spam folder. Returns how many changed. */
export async function setSpam(ctx: Ctx, formId: string, ids: string[], spam: boolean, now = Date.now()): Promise<number> {
  const form = toForm(await getFormRow(ctx.db, formId));
  const rows = (await loadMany(ctx.db, formId, ids)).filter((r) => (spam ? r.status === 'complete' : r.status === 'spam'));
  if (rows.length === 0) return 0;
  const marks = rows.map(() => '?').join(',');
  await ctx.db.run(`UPDATE forms_submissions SET status = ?, updated_at = ? WHERE org_id = :org AND form_id = ? AND id IN (${marks})`, spam ? 'spam' : 'complete', now, formId, ...rows.map((r) => r.id));
  if (spam) {
    await ctx.db.run('UPDATE forms_forms SET response_count = MAX(0, response_count - ?) WHERE org_id = :org AND id = ?', rows.length, formId);
    await adjust(ctx, form, rows, -1, now);
    await bump(ctx.env, form.orgId, formId, now, [['spam', '', rows.length]]);
    for (const r of rows) {
      await emit(ctx.env, { orgId: form.orgId, module: 'forms', name: 'submission.spam', subject: formId, data: { formId, slug: form.slug, submissionId: r.id, reason: 'marked' }, at: now });
    }
  } else {
    await ctx.db.run('UPDATE forms_forms SET response_count = response_count + ? WHERE org_id = :org AND id = ?', rows.length, formId);
    await adjust(ctx, form, rows, 1, now);
    await bump(ctx.env, form.orgId, formId, now, [['spam', '', -rows.length]]);
  }
  return rows.length;
}

/** Delete responses for good, with their notes and uploaded files. */
export async function deleteSubmissions(ctx: Ctx, formId: string, ids: string[], now = Date.now()): Promise<number> {
  const form = toForm(await getFormRow(ctx.db, formId));
  const rows = await loadMany(ctx.db, formId, ids);
  if (rows.length === 0) return 0;
  const gone = rows.map((r) => r.id);
  await deleteUploadsOf(ctx, gone);
  const marks = gone.map(() => '?').join(',');
  await ctx.db.run(`DELETE FROM forms_notes WHERE org_id = :org AND submission_id IN (${marks})`, ...gone);
  await ctx.db.run(`DELETE FROM forms_submissions WHERE org_id = :org AND form_id = ? AND id IN (${marks})`, formId, ...gone);
  const complete = rows.filter((r) => r.status === 'complete');
  if (complete.length) {
    await ctx.db.run('UPDATE forms_forms SET response_count = MAX(0, response_count - ?) WHERE org_id = :org AND id = ?', complete.length, formId);
    await adjust(ctx, form, complete, -1, now);
  }
  return rows.length;
}

/** Everything one person has sent across all forms in the workspace, for a data request. */
export async function exportByEmail(db: OrgDb, email: string): Promise<Record<string, unknown>[]> {
  const rows = await db.all<SubmissionRow & { form_name: string }>(
    `SELECT s.*, f.name AS form_name FROM forms_submissions s JOIN forms_forms f ON f.id = s.form_id
     WHERE s.org_id = :org AND s.respondent_email = ? ORDER BY s.created_at DESC LIMIT 1000`,
    email.trim().toLowerCase(),
  );
  return rows.map((r) => ({ id: r.id, form: r.form_name, formId: r.form_id, status: r.status, receivedAt: new Date(r.created_at).toISOString(), answers: parseJson(r.answers, {}), score: r.score }));
}

export async function deleteByEmail(ctx: Ctx, email: string, now = Date.now()): Promise<number> {
  const rows = await ctx.db.all<{ id: string; form_id: string }>('SELECT id, form_id FROM forms_submissions WHERE org_id = :org AND respondent_email = ? LIMIT 2000', email.trim().toLowerCase());
  const byForm = new Map<string, string[]>();
  for (const r of rows) byForm.set(r.form_id, [...(byForm.get(r.form_id) ?? []), r.id]);
  let n = 0;
  for (const [formId, ids] of byForm) n += await deleteSubmissions(ctx, formId, ids, now);
  return n;
}

/** Remove spam and partial rows nobody looked at for a month, so the folders do not grow forever. */
export async function purgeOldJunk(env: Ctx['env'], now = Date.now()): Promise<number> {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare("SELECT id, org_id FROM forms_submissions WHERE status IN ('spam','partial') AND updated_at < ?1 LIMIT 300").bind(cutoff).all<{ id: string; org_id: string }>();
  const byOrg = new Map<string, string[]>();
  for (const r of results) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r.id]);
  for (const [orgId, ids] of byOrg) {
    const keys = await env.DB.prepare(`SELECT r2_key FROM forms_files WHERE org_id = ?1 AND submission_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`).bind(orgId, ...ids).all<{ r2_key: string }>();
    if (keys.results.length) await env.FILES.delete(keys.results.map((k) => k.r2_key));
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM forms_files WHERE org_id = ?1 AND submission_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`).bind(orgId, ...ids),
      env.DB.prepare(`DELETE FROM forms_notes WHERE org_id = ?1 AND submission_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`).bind(orgId, ...ids),
      env.DB.prepare(`DELETE FROM forms_submissions WHERE org_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`).bind(orgId, ...ids),
    ]);
  }
  return results.length;
}

export interface Column {
  key: string;
  label: string;
}

/** The columns a spreadsheet of responses has: when, status, each question, score, email. */
export function exportColumns(def: Definition): Column[] {
  return allFields(def)
    .filter((f) => !DISPLAY_TYPES.includes(f.type))
    .map((f) => ({ key: f.id, label: f.label || f.key }));
}

export function responseRow(def: Definition, s: Submission, tz?: string): (string | number)[] {
  const fields = allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type));
  return [
    s.id,
    new Date(s.createdAt).toISOString(),
    s.status,
    ...fields.map((f) => {
      const v = s.answers[f.id];
      if (Array.isArray(v) && typeof v[0] === 'object') return (v as FileRef[]).map((x) => x.name).join('; ');
      return displayValue(f, v);
    }),
    s.score ?? '',
  ];
}

/** All matching responses as CSV. Capped so one request stays inside the free plan. */
export async function exportCsv(db: OrgDb, formId: string, def: Definition, q: ListQuery = {}, cap = 5000): Promise<string> {
  const header = ['Response id', 'Received', 'Status', ...exportColumns(def).map((c) => c.label), 'Score'];
  const rows: (string | number)[][] = [];
  for (let offset = 0; offset < cap; offset += 200) {
    const { items } = await listSubmissions(db, formId, { ...q, limit: Math.min(200, cap - offset), offset });
    for (const s of items) rows.push(responseRow(def, s));
    if (items.length < 200) break;
  }
  return `\uFEFF${[header, ...rows].map((r) => csvRow(r)).join('')}`;
}
