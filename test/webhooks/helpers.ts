/** Shared set-up for the webhook tests: a stubbed network, a ready endpoint, and a way to make deliveries. */
import { vi } from 'vitest';
import { createEndpoint } from '../../src/core/webhooks';
import type { WebhookEndpoint } from '../../src/core/webhooks';
import { fanOut } from '../../src/core/webhooks/fanout';
import type { FanoutJob } from '../../src/core/webhooks/fanout';
import type { Env } from '../../src/env';
import type { TestEnv } from '../helpers/d1';

export const RECEIVER = 'https://hooks.example.com/in';
export const ADMIN = { userId: 'usr_admin', label: 'admin@example.com' };

export interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

/** Replace `fetch`. Return a Response to answer, or an Error to fail the connection. Returns the list of requests made. */
export function stubFetch(answer: (sent: Sent) => Response | Error = () => new Response('ok', { status: 200 })): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const request = { url: String(url), headers: new Headers(init.headers), body: String(init.body) };
      sent.push(request);
      const out = answer(request);
      if (out instanceof Error) throw out;
      return out;
    }),
  );
  return sent;
}

export async function addEndpoint(
  t: TestEnv,
  input: Record<string, unknown> = {},
  orgId = t.org.id,
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  return createEndpoint(t.env, orgId, ADMIN, { name: 'Orders', url: RECEIVER, events: ['*'], ...input });
}

export function job(overrides: Partial<FanoutJob> = {}, orgId = 'org_test'): FanoutJob {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    orgId,
    type: 'links.link.clicked',
    subject: 'lnk_1',
    data: { slug: 'sale' },
    at: Date.UTC(2026, 0, 15, 12),
    ...overrides,
  };
}

/** Make one delivery per matching endpoint without running the queue. Returns the delivery ids, in the order they were made. */
export async function makeDeliveries(t: TestEnv, overrides: Partial<FanoutJob> = {}, now = Date.now()): Promise<string[]> {
  const j = job(overrides, overrides.orgId ?? t.org.id);
  await fanOut(t.env, j, now);
  return rows<{ id: string }>(t, 'SELECT id FROM webhook_deliveries WHERE message_id = ? ORDER BY rowid', j.id).map((r) => r.id);
}

export function row<T = Record<string, any>>(t: TestEnv, sql: string, ...params: (string | number)[]): T {
  return t.sqlite.prepare(sql).get(...params) as T;
}

export function rows<T = Record<string, any>>(t: TestEnv, sql: string, ...params: (string | number)[]): T[] {
  return t.sqlite.prepare(sql).all(...params) as T[];
}

/** The same database, with every statement it is asked to prepare written down. */
export function recordSql(env: Env): { env: Env; sql: string[] } {
  const sql: string[] = [];
  const source = env.DB;
  const db = Object.create(source) as D1Database;
  db.prepare = (text: string) => {
    sql.push(text);
    return source.prepare(text);
  };
  return { env: { ...env, DB: db }, sql };
}
