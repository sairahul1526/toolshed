/**
 * Small key/value settings store. `scope` is 'instance' for the whole install, or a workspace id.
 */
import type { Env } from '../env';
import { parseJson } from './db';

export const INSTANCE = 'instance';

export async function getSetting<T>(env: Env, scope: string, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE scope = ?1 AND key = ?2')
    .bind(scope, key)
    .first<{ value: string }>();
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export async function setSetting(env: Env, scope: string, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(scope, key, JSON.stringify(value), Date.now())
    .run();
}

export async function deleteSetting(env: Env, scope: string, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE scope = ?1 AND key = ?2').bind(scope, key).run();
}
