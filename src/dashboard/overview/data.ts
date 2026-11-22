/**
 * Everything the Overview screen shows, loaded in two rounds of parallel queries:
 * round one is the shell (which modules are on, their counts, appearance) next to the checklist and
 * recent-activity reads; round two is one set of reads per turned-on module.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { emailStatus } from '../../core/email';
import { eventCounts, recentEvents, type DayCount, type RecentEvent } from '../../core/events';
import type { KpiStat } from '../../core/module';
import { getModule, moduleContext, moduleStatus, type ModuleStatus } from '../../core/registry';
import { getSetting } from '../../core/settings';
import { shellData, type ShellData } from '../../core/shell-data';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { DEFAULT_APPEARANCE, parseAppearance } from '../../ui';

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

export const CHECKLIST_SETTING = 'overview.checklistDismissed';
const RECENT_LIMIT = 10;

export interface ChecklistStep {
  id: 'email' | 'module' | 'appearance' | 'teammate';
  title: string;
  /** What finishing it does for the workspace. */
  body: string;
  done: boolean;
  href: string;
  action: string;
}

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
  /** Null when the checklist should not be shown (done, dismissed, or the person is not an admin). */
  checklist: ChecklistStep[] | null;
  canManage: boolean;
}

async function memberCount(c: Context<AppEnv>, orgId: string): Promise<number> {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1').bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

function appearanceChanged(saved: Record<string, string>): boolean {
  const now = parseAppearance(saved);
  return (Object.keys(DEFAULT_APPEARANCE) as (keyof typeof DEFAULT_APPEARANCE)[]).some((k) => now[k] !== DEFAULT_APPEARANCE[k]);
}

export function buildChecklist(input: { emailReady: boolean; modulesOn: number; appearance: Record<string, string>; members: number }): ChecklistStep[] {
  return [
    {
      id: 'email',
      title: 'Set up email sending',
      body: 'So sign-in codes and invites reach people by email.',
      done: input.emailReady,
      href: '/app/email',
      action: 'Set up',
    },
    {
      id: 'module',
      title: 'Turn on a module',
      body: 'Pick the first tool you want to use.',
      done: input.modulesOn > 0,
      href: '/app/modules',
      action: 'Browse',
    },
    {
      id: 'appearance',
      title: 'Choose your look',
      body: 'Set the colors and theme for your workspace.',
      done: appearanceChanged(input.appearance),
      href: '/app/appearance',
      action: 'Choose',
    },
    {
      id: 'teammate',
      title: 'Invite a teammate',
      body: 'They get a sign-in link by email.',
      done: input.members > 1,
      href: '/app/members',
      action: 'Invite',
    },
  ];
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

  const [shell, recent, email, members, dismissed] = await Promise.all([
    shellData(c),
    recentEvents(env, org.id, { limit: RECENT_LIMIT }),
    canManage ? emailStatus(env) : null,
    canManage ? memberCount(c, org.id) : 0,
    canManage ? getSetting<boolean>(env, org.id, CHECKLIST_SETTING, false) : true,
  ]);

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

  const steps = canManage && email ? buildChecklist({ emailReady: email.status === 'ready', modulesOn: shell.modules.length, appearance: shell.appearance, members }) : null;
  const checklist = steps && !dismissed && steps.some((s) => !s.done) ? steps : null;

  return { shell, range: opts.range, cards, recent, checklist, canManage };
}
