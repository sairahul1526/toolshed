/**
 * Bring responses in from a spreadsheet. The person picks which column feeds which question, every
 * row is checked with the same rules as a live response, and rows that fail are listed by number
 * instead of stopping the whole import. Imported rows are history: they update the numbers but do
 * not send emails or webhooks.
 */
import { newId, parseJson } from '../../core/db';
import { formErrors } from './errors';
import { computeScore, type Answers } from './logic';
import { parseCsv } from './platform';
import { allFields, definitionSchema, DISPLAY_TYPES, type Definition } from './schema';
import { getFormRow, toForm, type Ctx } from './service';
import { bump, responseEntries, type Entry } from './stats';
import { searchText, checkAnswers } from './validate';

export const IMPORT_MAX_ROWS = 500;
export const RECEIVED = '@received';

export interface ImportPreview {
  headers: string[];
  sample: string[][];
  rows: number;
  truncated: boolean;
  /** Column header to question id (or `@received`), guessed from the names. Empty string means skip. */
  mapping: Record<string, string>;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Guess which question each column belongs to, by comparing names. The person can change every guess. */
export function guessMapping(def: Definition, headers: string[]): Record<string, string> {
  const fields = allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type) && f.type !== 'file_upload');
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const h of headers) {
    const n = norm(h);
    const hit = fields.find((f) => !used.has(f.id) && (norm(f.label) === n || norm(f.key) === n || f.id === h));
    if (hit) {
      used.add(hit.id);
      out[h] = hit.id;
    } else if (['received', 'submitted', 'date', 'created', 'timestamp'].some((w) => n === w || n.startsWith(`${w} `))) out[h] = RECEIVED;
    else out[h] = '';
  }
  return out;
}

export function previewImport(def: Definition, csv: string): ImportPreview {
  if (csv.length > 2_000_000) throw formErrors.import_invalid('That file is over 2 MB. Split it and import it in parts.');
  const parsed = parseCsv(csv, { maxRows: IMPORT_MAX_ROWS });
  if (parsed.headers.length === 0 || parsed.headers.every((h) => h === '')) throw formErrors.import_invalid('The first row needs column names.');
  if (parsed.rows.length === 0) throw formErrors.import_invalid('There are no responses under the column names.');
  return { headers: parsed.headers, sample: parsed.rows.slice(0, 3), rows: parsed.rows.length, truncated: parsed.truncated, mapping: guessMapping(def, parsed.headers) };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  problems: { row: number; message: string }[];
}

function receivedAt(text: string | undefined, fallback: number): number {
  if (!text) return fallback;
  const t = Date.parse(text);
  return Number.isNaN(t) || t > fallback ? fallback : t;
}

export async function importResponses(ctx: Ctx, formId: string, csv: string, mapping: Record<string, string>, now = Date.now()): Promise<ImportResult> {
  const form = toForm(await getFormRow(ctx.db, formId));
  const versionId = form.publishedVersionId ?? form.draftVersionId;
  if (!versionId) throw formErrors.import_invalid('Publish the form once before importing responses.');
  const v = await ctx.db.get<{ definition: string }>('forms_versions', versionId);
  const def = definitionSchema.parse(parseJson(v?.definition, {}));
  const fields = new Map(allFields(def).map((f) => [f.id, f]));
  const parsed = parseCsv(csv, { maxRows: IMPORT_MAX_ROWS });
  const result: ImportResult = { imported: 0, skipped: 0, problems: [] };
  const chosen = parsed.headers.map((h) => mapping[h] ?? '');
  if (!chosen.some((c) => c && c !== RECEIVED)) throw formErrors.import_invalid('Match at least one column to a question.');
  if (new Set(chosen.filter((c) => c && c !== RECEIVED)).size !== chosen.filter((c) => c && c !== RECEIVED).length) throw formErrors.import_invalid('Each question can take only one column.');
  for (const c of chosen) if (c && c !== RECEIVED && !fields.has(c)) throw formErrors.import_invalid('One of the matches points at a question that no longer exists.');

  const statements: D1PreparedStatement[] = [];
  const entries: Entry[] = [];
  let stamp = now - parsed.rows.length;
  parsed.rows.forEach((cells, i) => {
    const raw: Record<string, unknown> = {};
    let when = now;
    chosen.forEach((target, col) => {
      const cell = (cells[col] ?? '').trim();
      if (!target || cell === '') return;
      if (target === RECEIVED) {
        when = receivedAt(cell, now);
        return;
      }
      const f = fields.get(target)!;
      raw[target] = f.type === 'multiple_choice' ? cell.split(/\s*;\s*/).filter(Boolean) : cell;
    });
    const checked = checkAnswers(def, raw, new Map(), { partial: false });
    const bad = Object.entries(checked.errors)[0];
    if (bad) {
      result.skipped++;
      if (result.problems.length < 20) result.problems.push({ row: i + 2, message: `${fields.get(bad[0])?.label || 'A question'}: ${bad[1]}` });
      return;
    }
    if (Object.keys(checked.answers).length === 0) {
      result.skipped++;
      if (result.problems.length < 20) result.problems.push({ row: i + 2, message: 'Nothing in this row matched a question.' });
      return;
    }
    const answers: Answers = checked.answers;
    const email = [...fields.values()].filter((f) => f.type === 'email').map((f) => answers[f.id]).find((a) => typeof a === 'string');
    const id = newId('sub', ++stamp);
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO forms_submissions (id, org_id, form_id, version_id, status, answers, calcs, score, respondent_email, search_text, meta, started_at, completed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'complete', ?5, ?6, ?10, ?7, ?8, '{"source":"import"}', NULL, ?9, ?9, ?9)`,
      ).bind(id, form.orgId, formId, versionId, JSON.stringify(answers), JSON.stringify(checked.calcs), typeof email === 'string' ? email : null, searchText(def, answers), when, computeScore(def, answers)),
    );
    for (const e of responseEntries(def, answers, null, 1)) entries.push(e);
    result.imported++;
  });

  for (let i = 0; i < statements.length; i += 50) await ctx.env.DB.batch(statements.slice(i, i + 50));
  if (result.imported > 0) {
    await ctx.db.run('UPDATE forms_forms SET response_count = response_count + ?, last_response_at = ? WHERE org_id = :org AND id = ?', result.imported, now, formId);
    await bump(ctx.env, form.orgId, formId, now, entries);
  }
  return result;
}
