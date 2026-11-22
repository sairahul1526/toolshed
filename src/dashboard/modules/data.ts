/**
 * Loading and filtering for the Modules screen. Everything here is read-only: one query for the
 * workspace's module state, plus each turned-on module's own setup check.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { parse } from '../../core/errors';
import type { ModuleCategory, ModuleDef } from '../../core/module';
import { allModules, moduleContext, moduleStates, moduleStatus } from '../../core/registry';
import type { ModuleState, ModuleStatus } from '../../core/registry';

export interface ModuleRow {
  def: ModuleDef;
  state: ModuleState;
  status: ModuleStatus;
}

export const FILTERS = ['all', 'on', 'off'] as const;
export type StateFilter = (typeof FILTERS)[number];

/** Anything unusable in the query string falls back to "show everything", so a stale link never errors. */
const listQuery = z.object({
  q: z.string().transform((s) => s.trim().slice(0, 100)).catch(''),
  filter: z.enum(FILTERS).catch('all'),
});
export type ListQuery = z.infer<typeof listQuery>;

export function parseListQuery(raw: { q?: string; filter?: string }): ListQuery {
  return parse(listQuery, raw);
}

const OFF: ModuleState = { enabled: false, sample: false, enabledAt: null };

type OrgRef = { id: string; name: string; slug: string };

async function rowLoader(env: Env, org: OrgRef) {
  const [states, ctx] = await Promise.all([moduleStates(env, org.id), moduleContext(env, org)]);
  return async (def: ModuleDef): Promise<ModuleRow> => {
    const state = states.get(def.id) ?? OFF;
    return { def, state, status: await moduleStatus(ctx, def, state) };
  };
}

export async function loadRow(env: Env, org: OrgRef, def: ModuleDef): Promise<ModuleRow> {
  return (await rowLoader(env, org))(def);
}

/** Every registered module with its state in this workspace. A module whose setup check fails reads "needs setup". */
export async function loadRows(env: Env, org: OrgRef): Promise<ModuleRow[]> {
  return Promise.all(allModules().map(await rowLoader(env, org)));
}

export function countRows(rows: ModuleRow[]): Record<StateFilter, number> {
  const on = rows.filter((r) => r.state.enabled).length;
  return { all: rows.length, on, off: rows.length - on };
}

/** Every word typed must appear in the name, id, description or category. */
export function filterRows(rows: ModuleRow[], { q, filter }: ListQuery): ModuleRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (filter === 'on' && !r.state.enabled) return false;
    if (filter === 'off' && r.state.enabled) return false;
    if (words.length === 0) return true;
    const hay = `${r.def.name} ${r.def.id} ${r.def.description} ${r.def.category}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const CATEGORY_LABEL: Record<ModuleCategory, string> = {
  growth: 'Growth',
  support: 'Support',
  product: 'Product',
  insights: 'Insights',
  operations: 'Operations',
  content: 'Content',
  messaging: 'Messaging',
  files: 'Files',
};

export type StateLabel = 'On' | 'Off' | 'Needs setup';

export function stateLabel(row: ModuleRow): StateLabel {
  if (!row.state.enabled) return 'Off';
  return row.status.status === 'needs_setup' ? 'Needs setup' : 'On';
}

/** Whether a module can show and clear sample data. Both halves are needed to be able to undo it. */
export function hasSampleData(def: ModuleDef): boolean {
  return Boolean(def.sampleData && def.clearSampleData);
}

/** Only same-site paths and web links from a module's setup status become links. */
export function safeHref(href: string): string | null {
  return /^(\/(?!\/)|https?:\/\/)/.test(href) ? href : null;
}
