/**
 * "Does this workspace have an active endpoint?", remembered for 30 seconds per Worker instance.
 * Every `emit()` asks, so a workspace with no webhooks must cost no database query after the first
 * look. The price is that an instance may take up to 30 seconds to notice an endpoint added
 * through another instance. The instance that makes the change forgets at once.
 */
import type { Env } from '../../env';

const TTL_MS = 30_000;
const MAX_ENTRIES = 5000;

const caches = new WeakMap<object, Map<string, { active: boolean; at: number }>>();

function cacheFor(env: Env): Map<string, { active: boolean; at: number }> {
  let cache = caches.get(env.DB);
  if (!cache) {
    cache = new Map();
    caches.set(env.DB, cache);
  }
  return cache;
}

export async function hasActiveEndpoints(env: Env, orgId: string, now = Date.now()): Promise<boolean> {
  const cache = cacheFor(env);
  const hit = cache.get(orgId);
  if (hit && now - hit.at < TTL_MS) return hit.active;
  const row = await env.DB.prepare(`SELECT 1 AS x FROM webhook_endpoints WHERE org_id = ?1 AND status = 'active' LIMIT 1`).bind(orgId).first();
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(orgId, { active: row !== null, at: now });
  return row !== null;
}

/** Call after anything that adds, turns on, turns off or removes an endpoint. */
export function forgetActiveEndpoints(env: Env, orgId: string): void {
  cacheFor(env).delete(orgId);
}
