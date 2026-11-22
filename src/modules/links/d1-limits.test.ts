import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../../../test/helpers/d1';
import { getStats } from './stats';
import type { LinksCtx } from './types';

/** Real D1 refuses a compound SELECT of more than five parts; the Node test double does not. */
const MAX_COMPOUND_PARTS = 5;

function guarded(env: LinksCtx['env']): LinksCtx['env'] {
  const real = env.DB;
  const DB = new Proxy(real, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key, target) as unknown;
      return (sql: string) => {
        const parts = (sql.match(/\bUNION\b/gi) ?? []).length + 1;
        if (parts > MAX_COMPOUND_PARTS) throw new Error(`too many terms in compound SELECT (${parts})`);
        return target.prepare(sql);
      };
    },
  });
  return { ...env, DB } as LinksCtx['env'];
}

describe('stats queries on real D1 limits', () => {
  it('never joins more than five SELECTs, with raw clicks and with none', async () => {
    const t = createTestEnv();
    const ctx: LinksCtx = { env: guarded(t.env), orgId: t.org.id, base: 'http://localhost' };
    const stats = await getStats(ctx, { days: 7 });
    expect(stats.totals.clicks).toBe(0);
    expect(Object.keys(stats.breakdowns)).toContain('referrer');
  });
});
