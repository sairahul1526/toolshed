/**
 * Everything the Overview screen shows, loaded in two rounds of parallel queries:
 * round one is the shell (which modules are on, their counts, appearance) next to the recent-activity
 * read; round two is one set of reads per turned-on module.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { eventCounts, recentEvents, type DayCount, type RecentEvent } from '../../core/events';
import type { KpiStat } from '../../core/module';
import { getModule, moduleContext, moduleStatus, type ModuleStatus } from '../../core/registry';
import { shellData, type ShellData } from '../../core/shell-data';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 30;

const rangeSchema = z.coerce
  .number()
  .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
  .catch(DEFAULT_RANGE);

/** Reads `?days=` from the query string. Anything else means 30 days, so a hand-edited link still works. */
export function parseRange(value: unknown): Range {
  return rangeSchema.parse(value ?? DEFAULT_RANGE);
}

const RECENT_LIMIT = 10;

export interface ModuleCard {
  id: string;
  name: string;
  icon: string;
  href: string;
  /** The module's own headline number, or null when it has none or it could not be read. */
  count: number | null;
  /** Daily totals for the chosen range, oldest first. */
  days: DayCount[];
  total: number;
  status: Extract<ModuleStatus, { status: 'ready' | 'needs_setup' }>;
  stats: KpiStat[];
}

export interface OverviewData {
  shell: ShellData;
  range: Range;
  cards: ModuleCard[];
  recent: RecentEvent[];
  canManage: boolean;
}

/** One module's broken number must not take the whole page down. */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export async function loadOverview(c: Context<AppEnv>, opts: { range: Range; now?: number }): Promise<OverviewData> {
  const org = c.get('org');
  if (!org) throw new Error('loadOverview needs an active workspace');
  const env = c.env;
  const canManage = roleAtLeast(org.role, 'admin');

  const [shell, recent] = await Promise.all([shellData(c), recentEvents(env, org.id, { limit: RECENT_LIMIT })]);

  const ctx = await moduleContext(env, org);
  const cards = await Promise.all(
    shell.modules.map(async (m): Promise<ModuleCard> => {
      const def = getModule(m.id);
      const [days, status, stats] = await Promise.all([
        safely(() => eventCounts(env, org.id, { module: m.id, days: opts.range, now: opts.now }), []),
        def ? moduleStatus(ctx, def, { enabled: true, sample: false, enabledAt: null }) : { status: 'ready' as const },
        def?.overview ? safely(() => def.overview!(ctx), []) : [],
      ]);
      return {
        id: m.id,
        name: m.name,
        icon: m.icon,
        href: m.href,
        count: m.count,
        days,
        total: days.reduce((sum, d) => sum + d.count, 0),
        status: status.status === 'off' ? { status: 'ready' } : status,
        stats: stats.slice(0, 2),
      };
    }),
  );

  return { shell, range: opts.range, cards, recent, canManage };
}
