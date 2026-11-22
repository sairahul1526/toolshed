/**
 * What the workspace export gets from this module. Sites, goals, share links, counters and the
 * daily totals go in whole. Raw hits and open visits go in up to a row limit, newest first,
 * because the export job holds each table in memory; the full raw export is the paged
 * `GET /api/v1/analytics/sites/:id/hits?format=csv`.
 */
import type { ModuleContext } from '../../core/module';
import { listSites, publicShare, type Goal, type Share } from './sites';

const PAGE = 5000;
/** Rows of daily totals: about 18 months of a mid-sized site. */
const MAX_ROLLUPS = 40_000;
export const MAX_EXPORT_HITS = 10_000;
const MAX_SESSIONS = 5000;

async function paged(ctx: ModuleContext, table: string, order: string, max: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  while (rows.length < max) {
    const found = await ctx.db.all(`SELECT * FROM ${table} WHERE org_id = :org ORDER BY ${order} LIMIT ? OFFSET ?`, Math.min(PAGE, max - rows.length), rows.length);
    rows.push(...found);
    if (found.length < PAGE) break;
  }
  return rows;
}

export async function exportData(ctx: ModuleContext): Promise<Record<string, unknown[]>> {
  const sites = await listSites(ctx.db);
  const goals = await ctx.db.all<Goal>('SELECT * FROM an_goals WHERE org_id = :org ORDER BY site_id, created_at LIMIT 2000');
  const shares = await ctx.db.all<Share>('SELECT * FROM an_shares WHERE org_id = :org ORDER BY site_id, created_at LIMIT 2000');
  return {
    an_sites: sites,
    an_goals: goals,
    // A share link's password hash stays out of the file.
    an_shares: shares.map(publicShare),
    an_rollups: await paged(ctx, 'an_rollups', 'day DESC, site_id, dim, value', MAX_ROLLUPS),
    an_counters: await paged(ctx, 'an_counters', 'day DESC, site_id, name', PAGE),
    an_hits: await paged(ctx, 'an_hits', 'at DESC, id DESC', MAX_EXPORT_HITS),
    an_sessions: await paged(ctx, 'an_sessions', 'day DESC, site_id, visitor', MAX_SESSIONS),
  };
}
