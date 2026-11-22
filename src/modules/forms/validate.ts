/**
 * Turn what a browser or a script sent into clean answers, or into one plain message per block.
 * Only blocks that are visible under the rules are checked and kept, so a hidden required question
 * never blocks a response and a script cannot store answers to questions nobody was shown.
 */
import { isEmpty, resolve, type Answer, type Answers, type FileRef, type Path } from './logic';
import { DISPLAY_TYPES, SCALE_TYPES, allFields, type Definition, type Field } from './schema';

export const LIMITS = { short: 500, long: 10_000 };

export type RawInput = Record<string, unknown>;

export interface Checked {
  answers: Answers;
  calcs: Record<string, number>;
  path: Path;
  errors: Record<string, string>;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;

function one(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

function list(raw: unknown): unknown[] {
  if (raw === undefined || raw === null || raw === '') return [];
  return Array.isArray(raw) ? raw : [raw];
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function optionId(f: Field, v: unknown): string | null {
  const s = String(v).trim();
  const hit = f.options?.find((o) => o.id === s) ?? f.options?.find((o) => o.label.trim().toLowerCase() === s.toLowerCase());
  return hit ? hit.id : null;
}

/** One block's raw value to a clean answer, `undefined` when nothing was given, or an error sentence. */
function coerce(f: Field, raw: unknown, files: Map<string, FileRef & { fieldId: string }>): { value?: Answer; error?: string } {
  switch (f.type) {
    case 'statement':
    case 'section':
      return {};
    case 'short_text':
    case 'hidden': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      return s.length > LIMITS.short ? { error: `Keep this under ${LIMITS.short} characters.` } : { value: s };
    }
    case 'long_text': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      return s.length > LIMITS.long ? { error: `Keep this under ${LIMITS.long} characters.` } : { value: s };
    }
    case 'email': {
      const s = String(one(raw) ?? '').trim().toLowerCase();
      if (s === '') return {};
      return s.length <= 254 && EMAIL.test(s) ? { value: s } : { error: 'Enter an email address like name@example.com.' };
    }
    case 'phone': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      return /^[+\d][\d\s().-]{4,24}$/.test(s) ? { value: s } : { error: 'Enter a phone number with digits only, for example +1 555 010 0000.' };
    }
    case 'url': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.') && s.length <= 500) return { value: u.toString() };
      } catch {
        // fall through to the message
      }
      return { error: 'Enter a web address like https://example.com.' };
    }
    case 'date': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      return validDate(s) ? { value: s } : { error: 'Enter a date as year-month-day, for example 2026-03-28.' };
    }
    case 'number': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: 'Enter a number.' };
      if (f.min !== undefined && n < f.min) return { error: `Enter ${f.min} or more.` };
      if (f.max !== undefined && n > f.max) return { error: `Enter ${f.max} or less.` };
      return { value: n };
    }
    case 'single_choice':
    case 'dropdown': {
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      const id = optionId(f, s);
      return id ? { value: id } : { error: 'Pick one of the choices.' };
    }
    case 'multiple_choice': {
      const picked = list(raw).map((v) => optionId(f, v));
      if (picked.length === 0) return {};
      if (picked.some((p) => p === null)) return { error: 'Pick from the choices shown.' };
      return { value: [...new Set(picked as string[])] };
    }
    case 'yes_no': {
      const s = String(one(raw) ?? '').trim().toLowerCase();
      if (s === '') return {};
      if (['yes', 'true', 'on', '1'].includes(s)) return { value: 'yes' };
      if (['no', 'false', 'off', '0'].includes(s)) return { value: 'no' };
      return { error: 'Choose yes or no.' };
    }
    case 'consent': {
      const s = String(one(raw) ?? '').trim().toLowerCase();
      return ['yes', 'true', 'on', '1'].includes(s) ? { value: 'yes' } : {};
    }
    case 'file_upload': {
      const ids = list(raw).map(String);
      if (ids.length === 0) return {};
      const out: FileRef[] = [];
      for (const id of ids) {
        const hit = files.get(id);
        if (!hit || hit.fieldId !== f.id) return { error: 'That upload expired. Add the file again.' };
        out.push({ id: hit.id, name: hit.name, size: hit.size, type: hit.type });
      }
      if (out.length > (f.maxFiles ?? 1)) return { error: `Add up to ${f.maxFiles ?? 1} files.` };
      return { value: out };
    }
    default: {
      if (!SCALE_TYPES.includes(f.type)) return {};
      const s = String(one(raw) ?? '').trim();
      if (s === '') return {};
      const n = Number(s);
      const lo = f.min ?? 1;
      const hi = f.max ?? 5;
      return Number.isInteger(n) && n >= lo && n <= hi ? { value: n } : { error: `Pick a number from ${lo} to ${hi}.` };
    }
  }
}

/**
 * `raw` is keyed by block id (callers map names from plain HTML forms to ids first, see `mapNames`).
 * `files` are the uploads this respondent made, already looked up by the caller.
 */
export function checkAnswers(def: Definition, raw: RawInput, files: Map<string, FileRef & { fieldId: string }> = new Map(), opts: { partial?: boolean } = {}): Checked {
  const candidates: Answers = {};
  const problems: Record<string, string> = {};
  for (const f of allFields(def)) {
    if (DISPLAY_TYPES.includes(f.type)) continue;
    const res = coerce(f, raw[f.id], files);
    if (res.error) problems[f.id] = res.error;
    else if (res.value !== undefined) candidates[f.id] = res.value;
  }
  const { path, answers, calcs } = resolve(def, candidates);
  const errors: Record<string, string> = {};
  for (const f of allFields(def)) {
    if (!path.visible.has(f.id) || DISPLAY_TYPES.includes(f.type)) continue;
    if (problems[f.id]) errors[f.id] = problems[f.id]!;
    else if (!opts.partial && f.required && isEmpty(answers[f.id])) {
      errors[f.id] = f.type === 'consent' ? 'Tick this box to continue.' : f.type === 'file_upload' ? 'Add a file to continue.' : 'This question needs an answer.';
    }
  }
  return { answers, calcs, path, errors };
}

/**
 * Plain HTML forms post names, not ids. Accept a block id, its key, or `key[]`; ignore the rest.
 * Repeated names (checkboxes) become lists.
 */
export function mapNames(def: Definition, pairs: Iterable<[string, unknown]>): RawInput {
  const byName = new Map<string, Field>();
  for (const f of allFields(def)) {
    byName.set(f.id, f);
    byName.set(f.key, f);
  }
  const out: RawInput = {};
  for (const [nameRaw, value] of pairs) {
    const name = nameRaw.endsWith('[]') ? nameRaw.slice(0, -2) : nameRaw;
    const f = byName.get(name);
    if (!f) continue;
    const prior = out[f.id];
    out[f.id] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [prior]), ...(Array.isArray(value) ? value : [value])];
  }
  return out;
}

/** All the text of a response in one string, for the search box. Lower case, capped. */
export function searchText(def: Definition, answers: Answers): string {
  const parts: string[] = [];
  for (const f of allFields(def)) {
    const v = answers[f.id];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'object') parts.push(...(v as FileRef[]).map((x) => x.name));
      else parts.push(...(v as string[]).map((id) => f.options?.find((o) => o.id === id)?.label ?? id));
    } else if (f.options) parts.push(f.options.find((o) => o.id === v)?.label ?? String(v));
    else parts.push(String(v));
  }
  return parts.join(' ').toLowerCase().slice(0, 4000);
}
