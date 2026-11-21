/**
 * Scopes: what a key or token may touch. Modules declare theirs in `permissions`
 * (`links:read`, `links:write`). On top of those, `<module>:*` means everything in one module
 * and `*` means everything.
 */
import { hasScope } from '../guards';
import { allModules } from '../registry';
import { keyErrors } from './shared';

/** The scope that covers everything, including modules added later. */
export const ALL_SCOPES = '*';
/** Keeps a key's scope list, and any token made from it, a sensible size. */
export const MAX_SCOPES = 50;

export interface ScopeInfo {
  /** Module id, for grouping. */
  module: string;
  scope: string;
  /** Plain-English label the module wrote, for example "Create, edit and delete links". */
  label: string;
}

/** Every scope a module declares, in module order. `*` and `<module>:*` are accepted on top. */
export function listScopes(): ScopeInfo[] {
  return allModules().flatMap((m) => (m.permissions ?? []).map((p) => ({ module: m.id, scope: p.scope, label: p.label })));
}

function known(): Set<string> {
  const set = new Set<string>([ALL_SCOPES]);
  for (const m of allModules()) {
    if (!m.permissions?.length) continue;
    set.add(`${m.id}:*`);
    for (const p of m.permissions) set.add(p.scope);
  }
  return set;
}

/**
 * Check a list of scopes someone asked for. Returns it without repeats, sorted, and reduced to
 * `['*']` when it holds `*`. Throws `keys.unknown_scope` naming the ones that do not exist.
 */
export function checkScopes(scopes: readonly string[], field = 'scopes'): string[] {
  const valid = known();
  const unknown = [...new Set(scopes.filter((s) => !valid.has(s)))];
  if (unknown.length > 0) {
    const shown = unknown
      .slice(0, 5)
      .map((s) => s.slice(0, 60))
      .join(', ');
    const message = `${unknown.length === 1 ? 'This permission doesn’t' : 'These permissions don’t'} exist: ${shown}. Check the list and try again.`;
    throw keyErrors.unknown_scope(message, { [field]: message });
  }
  const unique = [...new Set(scopes)].sort();
  return unique.includes(ALL_SCOPES) ? [ALL_SCOPES] : unique;
}

/** The scopes in `wanted` that `held` does not cover. Empty means `wanted` is no wider than `held`. */
export function scopesBeyond(held: readonly string[], wanted: readonly string[]): string[] {
  const mine = [...held];
  return wanted.filter((scope) => !hasScope(mine, scope));
}
