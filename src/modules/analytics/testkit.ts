/**
 * Shared pieces for this module's tests: a site ready to take hits, pretend browsers, and a
 * counter for database statements. Only imported by `*.test.ts` files.
 */
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { orgDb } from '../../core/db';
import type { ModuleContext } from '../../core/module';
import { registerModules, setModuleEnabled } from '../../core/registry';
import { collect, type CollectResult, type HitInput } from './ingest';
import analytics from './module';
import { createSite, getSite, type Site } from './sites';

export const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export interface Kit {
  t: TestEnv;
  ctx: ModuleContext;
  site: Site;
  /** Send one hit as a browser would. `who` picks the visitor (a number becomes an IP address). */
  hit(at: number, input?: Partial<HitInput> & { who?: number; ua?: string; country?: string; city?: string; headers?: Record<string, string>; server?: boolean }): Promise<CollectResult>;
  /** The site as stored right now. */
  fresh(): Promise<Site>;
}

export function browser(opts: { who?: number; ua?: string; country?: string; city?: string; headers?: Record<string, string> } = {}): Request {
  const who = opts.who ?? 1;
  const req = new Request('https://app.example.com/a/e', {
    method: 'POST',
    headers: { 'user-agent': opts.ua ?? CHROME, 'cf-connecting-ip': `203.0.${Math.floor(who / 250)}.${(who % 250) + 1}`, ...opts.headers },
  });
  if (opts.country) Object.defineProperty(req, 'cf', { value: { country: opts.country, region: 'Region', city: opts.city ?? 'City' } });
  return req;
}

export async function makeKit(site: { domain?: string; timezone?: string } = {}, now = Date.UTC(2026, 0, 1)): Promise<Kit> {
  const t = createTestEnv();
  registerModules([analytics]);
  await setModuleEnabled(t.env, t.org.id, 'analytics', true);
  const ctx: ModuleContext = { env: t.env, org: t.org, db: orgDb(t.env.DB, t.org.id) };
  const made = await createSite(ctx, { domain: site.domain ?? 'example.com', timezone: site.timezone ?? 'UTC' }, { now });
  return {
    t,
    ctx,
    site: made,
    hit(at, input = {}) {
      const { who, ua, country, city, headers, server, ...rest } = input;
      return collect(
        t.env,
        { key: made.key, kind: 'p', url: 'https://example.com/', ...rest },
        { req: browser({ who, ua, country, city, headers }), now: at, rand: () => 1, ...(server ? { server } : {}) },
      );
    },
    fresh: () => getSite(ctx.db, made.id),
  };
}

/** Count database work from now on: batches sent, and statements run (single or inside a batch). */
export function countStatements(t: TestEnv): { batches: number; statements: number; kvReads: number; kvWrites: number; reset(): void } {
  const counts = {
    batches: 0,
    statements: 0,
    kvReads: 0,
    kvWrites: 0,
    reset() {
      counts.batches = counts.statements = counts.kvReads = counts.kvWrites = 0;
    },
  };
  const db = t.env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> };
  const batch = db.batch.bind(db);
  db.batch = (s) => {
    counts.batches += 1;
    return batch(s);
  };
  const sqlite = t.sqlite as unknown as { prepare: (sql: string) => unknown };
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (sql) => {
    // The test double asks SQLite how many rows changed after each write; that is not a statement of ours.
    if (!sql.startsWith('SELECT changes()')) counts.statements += 1;
    return prepare(sql);
  };
  const kv = t.kv as unknown as { get: (...a: unknown[]) => Promise<unknown>; put: (...a: unknown[]) => Promise<void> };
  const get = kv.get.bind(kv);
  const put = kv.put.bind(kv);
  kv.get = (...a) => {
    counts.kvReads += 1;
    return get(...a);
  };
  kv.put = (...a) => {
    counts.kvWrites += 1;
    return put(...a);
  };
  return counts;
}

/** A small seeded random source, so generated traffic is the same on every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
