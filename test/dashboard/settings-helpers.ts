/** Shared set-up for the Settings screen tests. Not a test file. */
import { createApp } from '../../src/app';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import overview from '../../src/dashboard/overview';
import settings from '../../src/dashboard/settings';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';

export const BASE = '/app/settings';

export function makeApp(): ReturnType<typeof createApp> {
  return createApp({ screens: { overview, settings } });
}

/** One module that emits events, so the event picker has something to show. */
export function useLinks(): void {
  registerModules([
    defineModule({ id: 'links', name: 'Links', description: 'Short links.', icon: 'link', category: 'growth', version: '1.0.0', permissions: [], events: { emits: ['link.created', 'link.clicked'] } }),
  ]);
}

export function newEnv(): TestEnv {
  return createTestEnv();
}

export function form(fields: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) for (const v of Array.isArray(value) ? value : [value]) params.append(name, v);
  return params.toString();
}

export function postInit(headers: Record<string, string>, fields: Record<string, string | string[]> = {}): RequestInit {
  return { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) };
}

/** The one-time message set by a response, or null. */
export function flashOf(res: Response): { kind: string; message: string } | null {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ts_flash='));
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(decodeURIComponent(raw.split(';')[0]!.slice(9)))) as { kind: string; message: string };
}

/** Turn a session into one where an install owner is "signed in as" this person. */
export async function impersonate(t: TestEnv, sessionId: string): Promise<string> {
  const owner = await createTestSession(t.env, { instanceOwner: true, orgId: 'org_owner_home', email: 'install-owner@example.com' });
  await t.env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind(owner.user.id, sessionId).run();
  return owner.user.id;
}

export async function auditRows(t: TestEnv, like: string, orgId: string | null = 'org_test') {
  const sql = orgId === null ? `SELECT action, summary, meta FROM audit_log WHERE org_id IS NULL AND action LIKE ?1 ORDER BY rowid` : `SELECT action, summary, meta FROM audit_log WHERE org_id = ?2 AND action LIKE ?1 ORDER BY rowid`;
  const stmt = t.env.DB.prepare(sql);
  const bound = orgId === null ? stmt.bind(like) : stmt.bind(like, orgId);
  return (await bound.all<{ action: string; summary: string; meta: string }>()).results;
}
