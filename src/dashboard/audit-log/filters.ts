/** The filters in the address bar, checked and turned into what `listAudit` takes. */
import { z } from 'zod';
import type { AuditQuery } from '../../core/audit';
import { AppError, parse, type FieldErrors } from '../../core/errors';

export interface FilterState {
  actor: string;
  action: string;
  q: string;
  /** `YYYY-MM-DD`, UTC. */
  from: string;
  to: string;
  scope: 'workspace' | 'all';
  /** Cursor of the page being shown. Empty for the newest entries. */
  before: string;
}

export interface ParsedFilters {
  state: FilterState;
  /** What to pass to `listAudit`, without the workspace. */
  query: AuditQuery;
  errors: FieldErrors;
}

const DAY_MS = 86_400_000;

const text = (label: string) => z.string().trim().max(100, `${label} can be up to 100 characters.`);
const day = (label: string) => z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date like 2026-11-20.`)]);

const schema = z.object({
  actor: text('The person'),
  action: text('The action'),
  q: text('The search'),
  from: day('The start date'),
  to: day('The end date'),
  scope: z.enum(['workspace', 'all']),
  before: z.string().max(200, 'That page marker isn’t valid. Reload the list.'),
});

const EMPTY: FilterState = { actor: '', action: '', q: '', from: '', to: '', scope: 'workspace', before: '' };

/** Midnight UTC of a `YYYY-MM-DD` date, or null when the day does not exist (2026-02-31). */
function startOfDay(value: string): number | null {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
}

export function parseFilters(search: URLSearchParams): ParsedFilters {
  const raw: Record<string, string> = {};
  for (const key of Object.keys(EMPTY)) raw[key] = search.get(key) ?? EMPTY[key as keyof FilterState];
  if (raw.scope !== 'all') raw.scope = 'workspace';

  let state: FilterState = EMPTY;
  let errors: FieldErrors = {};
  try {
    state = parse(schema, raw);
  } catch (err) {
    if (!(err instanceof AppError) || !err.fields) throw err;
    errors = err.fields;
    // Keep what was typed (cut to a safe length) so the form shows it next to the message.
    state = { ...EMPTY, ...(raw as Partial<FilterState>) };
    for (const key of ['actor', 'action', 'q', 'from', 'to', 'before'] as const) state[key] = String(raw[key]).slice(0, 100);
  }

  const from = state.from ? startOfDay(state.from) : undefined;
  const to = state.to ? startOfDay(state.to) : undefined;
  if (from === null && !errors.from) errors = { ...errors, from: 'That start date doesn’t exist.' };
  if (to === null && !errors.to) errors = { ...errors, to: 'That end date doesn’t exist.' };
  if (typeof from === 'number' && typeof to === 'number' && from > to && !errors.to) {
    errors = { ...errors, to: 'The end date is before the start date.' };
  }

  const query: AuditQuery = {
    ...(state.actor ? { actorId: state.actor } : {}),
    ...(state.action ? { action: state.action } : {}),
    ...(state.q ? { q: state.q } : {}),
    ...(typeof from === 'number' ? { from } : {}),
    // Inclusive of the whole end day.
    ...(typeof to === 'number' ? { to: to + DAY_MS - 1 } : {}),
  };
  return { state, query, errors };
}

/** True when any narrowing filter is set (the scope and the page marker are not filters). */
export function isFiltered(state: FilterState): boolean {
  return Boolean(state.actor || state.action || state.q || state.from || state.to);
}

/** A link to the log with these filters. `extra` overrides, for example `{ before: cursor }`. */
export function logHref(state: FilterState, extra: Partial<FilterState> = {}, path = '/app/audit-log'): string {
  const merged = { ...state, before: '', ...extra };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value && !(key === 'scope' && value === 'workspace')) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
