/**
 * The module registry: which modules exist, and which ones each workspace has turned on.
 *
 * `src/index.ts` calls `registerModules()` once with the list that `scripts/prepare.mjs` generates.
 * Tests call it with their own list.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';
import { orgDb, parseJson } from './db';
import { errors } from './errors';
import type { ModuleContext, ModuleDef, SetupStatus } from './module';

let registered: ModuleDef[] = [];

/** Set the list of modules. Throws when two modules clash (same id, same public path). */
export function registerModules(list: ModuleDef[]): void {
  const ids = new Set<string>();
  const prefixes = new Map<string, string>();
  const tables = new Map<string, string>();
  for (const m of list) {
    if (ids.has(m.id)) throw new Error(`Two modules share the id "${m.id}"`);
    ids.add(m.id);
    for (const p of m.publicPrefixes ?? []) {
      const owner = prefixes.get(p);
      if (owner) throw new Error(`Modules "${owner}" and "${m.id}" both claim the public path ${p}`);
      prefixes.set(p, m.id);
    }
    for (const t of m.tables ?? []) {
      const owner = tables.get(t);
      if (owner) throw new Error(`Modules "${owner}" and "${m.id}" both claim the table ${t}`);
      tables.set(t, m.id);
    }
    for (const route of m.public?.routes ?? []) {
      const ok = (m.publicPrefixes ?? []).some((p) => route.path === p || route.path.startsWith(`${p}/`));
      if (!ok) {
        throw new Error(
          `Module "${m.id}" has a public route ${route.path} outside its publicPrefixes. ` +
            'Public routes must start with one of the prefixes the module declares.',
        );
      }
    }
  }
  registered = [...list].sort((a, b) => a.name.localeCompare(b.name));
}

export function allModules(): ModuleDef[] {
  return registered;
}

export function getModule(id: string): ModuleDef | undefined {
  return registered.find((m) => m.id === id);
}

export interface ModuleState {
  enabled: boolean;
  /** True while the workspace is showing this module's sample data. */
  sample: boolean;
  enabledAt: number | null;
}

interface StateRow {
  module_id: string;
  enabled: number;
  sample: number;
  enabled_at: number | null;
  settings: string;
}

const OFF: ModuleState = { enabled: false, sample: false, enabledAt: null };

/** State of every module for one workspace. Modules with no row are off. */
export async function moduleStates(env: Env, orgId: string): Promise<Map<string, ModuleState>> {
  const { results } = await env.DB.prepare('SELECT module_id, enabled, sample, enabled_at FROM module_state WHERE org_id = ?1')
    .bind(orgId)
    .all<StateRow>();
  const map = new Map<string, ModuleState>();
  for (const r of results) map.set(r.module_id, { enabled: r.enabled === 1, sample: r.sample === 1, enabledAt: r.enabled_at });
  for (const m of registered) if (!map.has(m.id)) map.set(m.id, OFF);
  return map;
}

export async function moduleState(env: Env, orgId: string, moduleId: string): Promise<ModuleState> {
  const r = await env.DB.prepare('SELECT module_id, enabled, sample, enabled_at FROM module_state WHERE org_id = ?1 AND module_id = ?2')
    .bind(orgId, moduleId)
    .first<StateRow>();
  return r ? { enabled: r.enabled === 1, sample: r.sample === 1, enabledAt: r.enabled_at } : OFF;
}

export async function setModuleEnabled(env: Env, orgId: string, moduleId: string, enabled: boolean): Promise<void> {
  if (!getModule(moduleId)) throw errors.not_found('There is no module with that name.');
  await env.DB.prepare(
    `INSERT INTO module_state (org_id, module_id, enabled, enabled_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (org_id, module_id) DO UPDATE SET enabled = excluded.enabled,
       enabled_at = CASE WHEN excluded.enabled = 1 THEN excluded.enabled_at ELSE module_state.enabled_at END`,
  )
    .bind(orgId, moduleId, enabled ? 1 : 0, enabled ? Date.now() : null)
    .run();
}

/**
 * Turns a module on only if it was off, in one statement. True for the request that did it, so two
 * presses at once cannot both run the first-time work (sample rows, the audit line).
 */
export async function enableModuleOnce(env: Env, orgId: string, moduleId: string): Promise<boolean> {
  if (!getModule(moduleId)) throw errors.not_found('There is no module with that name.');
  const res = await env.DB.prepare(
    `INSERT INTO module_state (org_id, module_id, enabled, enabled_at) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (org_id, module_id) DO UPDATE SET enabled = 1, enabled_at = excluded.enabled_at
       WHERE module_state.enabled = 0`,
  )
    .bind(orgId, moduleId, Date.now())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function setModuleSample(env: Env, orgId: string, moduleId: string, sample: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO module_state (org_id, module_id, sample) VALUES (?1, ?2, ?3)
     ON CONFLICT (org_id, module_id) DO UPDATE SET sample = excluded.sample`,
  )
    .bind(orgId, moduleId, sample ? 1 : 0)
    .run();
}

/** A module's own settings for one workspace, merged over `defaults`. */
export async function getModuleSettings<T extends Record<string, unknown>>(
  env: Env,
  orgId: string,
  moduleId: string,
  defaults: T,
): Promise<T> {
  const r = await env.DB.prepare('SELECT settings FROM module_state WHERE org_id = ?1 AND module_id = ?2')
    .bind(orgId, moduleId)
    .first<{ settings: string }>();
  return { ...defaults, ...parseJson<Partial<T>>(r?.settings, {}) };
}

export async function setModuleSettings(env: Env, orgId: string, moduleId: string, settings: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO module_state (org_id, module_id, settings) VALUES (?1, ?2, ?3)
     ON CONFLICT (org_id, module_id) DO UPDATE SET settings = excluded.settings`,
  )
    .bind(orgId, moduleId, JSON.stringify(settings))
    .run();
}

/** Build the context a module needs outside a request. Pass the org when you already have it. */
export async function moduleContext(env: Env, org: string | { id: string; name: string; slug: string }): Promise<ModuleContext> {
  let o = typeof org === 'string' ? { id: org, name: '', slug: '' } : { id: org.id, name: org.name, slug: org.slug };
  if (typeof org === 'string') {
    try {
      const row = await env.DB.prepare('SELECT id, name, slug FROM organization WHERE id = ?1')
        .bind(org)
        .first<{ id: string; name: string; slug: string | null }>();
      if (row) o = { id: row.id, name: row.name, slug: row.slug ?? '' };
    } catch {
      // The organization table belongs to auth; without it we still have the id.
    }
  }
  return { env, org: o, db: orgDb(env.DB, o.id) };
}

export type ModuleStatus = { status: 'off' } | SetupStatus;

/** What the Modules screen shows for one module: Off, Ready or Needs setup. */
export async function moduleStatus(ctx: ModuleContext, m: ModuleDef, state: ModuleState): Promise<ModuleStatus> {
  if (!state.enabled) return { status: 'off' };
  if (!m.setup) return { status: 'ready' };
  try {
    return await m.setup(ctx);
  } catch {
    return { status: 'needs_setup', reason: 'We couldn’t check this module’s setup. Open it to see why.' };
  }
}

/** Route guard: the workspace must have this module turned on. */
export function requireModule(moduleId: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const org = c.get('org');
    if (!org) throw errors.unauthorized();
    const state = await moduleState(c.env, org.id, moduleId);
    if (!state.enabled) throw errors.module_off();
    await next();
  };
}

/** Everything a workspace has stored in modules, as `<moduleId>.<table>` → rows. Used by Export. */
export async function exportModules(env: Env, org: { id: string; name: string; slug: string }): Promise<Record<string, unknown[]>> {
  const ctx = await moduleContext(env, org);
  const out: Record<string, unknown[]> = {};
  for (const m of registered) {
    const data = m.exportData
      ? await m.exportData(ctx)
      : Object.fromEntries(await Promise.all((m.tables ?? []).map(async (t) => [t, await ctx.db.list(t, { limit: 1000, orderBy: 'rowid' })] as const)));
    for (const [table, rows] of Object.entries(data)) out[`${m.id}.${table}`] = rows;
  }
  return out;
}

/**
 * Core tables with a workspace's rows, in the order they are emptied. `module_state` has to go
 * before `audit_log`: the audit log only lets go of a workspace's lines once that workspace has
 * no module state left (see `audit_guard` in the migrations).
 */
const CORE_ORG_TABLES = [
  'module_state',
  'audit_log',
  'email_log',
  'event_counts',
  'events_recent',
  'webhook_attempts',
  'webhook_deliveries',
  'webhook_endpoints',
  // Keys and service accounts are credentials: left behind, they would name a workspace that is gone.
  'api_keys',
  'service_accounts',
  'notification_reads',
  'notification_marks',
  'notifications',
  'exports',
] as const;

/** Where a workspace's export files live. The same layout as `exportKey` in export.ts, which imports this file. */
const exportPrefix = (orgId: string): string => `exports/${orgId}/`;

/**
 * The statements that delete everything modules and core services stored for a workspace. They
 * are handed out, not run, so deleting a workspace can put them in one batch with the removal of
 * its members: nobody can write into a workspace that is half gone.
 */
export function purgeOrgStatements(env: Env, orgId: string): D1PreparedStatement[] {
  if (!orgId) throw new Error('purgeOrgStatements needs a workspace id');
  const tables = registered.flatMap((m) => m.tables ?? []);
  const stmts = [...tables, ...CORE_ORG_TABLES].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE org_id = ?1`).bind(orgId));
  stmts.push(env.DB.prepare('DELETE FROM settings WHERE scope = ?1').bind(orgId));
  return stmts;
}

/**
 * Delete the files a workspace has outside the database: its exports, and everything its modules
 * stored. Modules keep their files under `<module id>/<workspace id>/`, which is what makes this
 * possible without asking each one. Safe to run again.
 */
export async function purgeOrgFiles(env: Env, orgId: string): Promise<void> {
  if (!orgId) throw new Error('purgeOrgFiles needs a workspace id');
  const prefixes = [exportPrefix(orgId), ...registered.map((m) => `${m.id}/${orgId}/`)];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix, ...(cursor ? { cursor } : {}) });
      if (page.objects.length > 0) await env.FILES.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/** Delete everything modules and core services stored for a workspace: files first, then rows. */
export async function purgeOrgData(env: Env, orgId: string): Promise<void> {
  await purgeOrgFiles(env, orgId);
  await env.DB.batch(purgeOrgStatements(env, orgId));
}
