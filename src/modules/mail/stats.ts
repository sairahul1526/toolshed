/** Numbers for the dashboard, plus the two public tracking hits (open pixel and click redirect). Tracking is off unless a broadcast turns it on. */
import { readClickToken, readOpenToken } from './tokens';
import type { Env } from '../../env';
import type { Broadcast, Ctx } from './types';

export interface BroadcastStats {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  queued: number;
  unsubscribed: number;
  opened: number;
  clicked: number;
  tracking: { opens: boolean; clicks: boolean };
  links: { url: string; clicks: number }[];
}

export async function broadcastStats(ctx: Ctx, b: Broadcast): Promise<BroadcastStats> {
  const [row, links, unsub] = await Promise.all([
    ctx.db.first<{ total: number; sent: number; failed: number; skipped: number; queued: number; opened: number; clicked: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'sent'), 0) AS sent, COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(status = 'skipped'), 0) AS skipped,
        COALESCE(SUM(status IN ('queued', 'sending')), 0) AS queued, COALESCE(SUM(opened_at IS NOT NULL), 0) AS opened, COALESCE(SUM(clicked_at IS NOT NULL), 0) AS clicked
       FROM mail_deliveries WHERE org_id = :org AND broadcast_id = ?`,
      b.id,
    ),
    ctx.db.all<{ url: string; clicks: number }>('SELECT url, clicks FROM mail_links WHERE org_id = :org AND broadcast_id = ? ORDER BY clicks DESC LIMIT 20', b.id),
    ctx.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mail_memberships m JOIN mail_deliveries d ON d.org_id = m.org_id AND d.subscriber_id = m.subscriber_id AND d.broadcast_id = ?
       WHERE m.org_id = :org AND m.list_id = ? AND m.status = 'unsubscribed' AND m.unsubscribed_at >= ?`,
      b.id,
      b.list_id,
      b.started_at ?? b.created_at,
    ),
  ]);
  return {
    total: row?.total ?? 0,
    sent: row?.sent ?? 0,
    failed: row?.failed ?? 0,
    skipped: row?.skipped ?? 0,
    queued: row?.queued ?? 0,
    unsubscribed: unsub?.n ?? 0,
    opened: row?.opened ?? 0,
    clicked: row?.clicked ?? 0,
    tracking: { opens: b.track_opens === 1, clicks: b.track_clicks === 1 },
    links,
  };
}

export interface Growth {
  day: string;
  joined: number;
  left: number;
}

/** New confirmed subscribers and unsubscribes per day for the last `days` days (UTC). */
export async function growth(ctx: Ctx, opts: { listId?: string; days?: number; now?: number } = {}): Promise<Growth[]> {
  const days = Math.min(opts.days ?? 30, 365);
  const now = opts.now ?? Date.now();
  const since = now - days * 86_400_000;
  const scope = opts.listId ? 'AND list_id = ?' : '';
  const extra = opts.listId ? [opts.listId] : [];
  const [joined, left] = await Promise.all([
    ctx.db.all<{ day: string; n: number }>(
      `SELECT strftime('%Y-%m-%d', confirmed_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM mail_memberships WHERE org_id = :org AND confirmed_at >= ? ${scope} GROUP BY day`,
      since,
      ...extra,
    ),
    ctx.db.all<{ day: string; n: number }>(
      `SELECT strftime('%Y-%m-%d', unsubscribed_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM mail_memberships WHERE org_id = :org AND unsubscribed_at >= ? ${scope} GROUP BY day`,
      since,
      ...extra,
    ),
  ]);
  const j = new Map(joined.map((r) => [r.day, r.n]));
  const l = new Map(left.map((r) => [r.day, r.n]));
  const out: Growth[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, joined: j.get(day) ?? 0, left: l.get(day) ?? 0 });
  }
  return out;
}

export interface Totals {
  subscribers: number;
  active: number;
  pending: number;
  unsubscribed: number;
  suppressed: number;
  broadcasts: number;
  lists: number;
}

export async function totals(ctx: Ctx): Promise<Totals> {
  const [m, s, supp, b, l] = await Promise.all([
    ctx.db.first<{ active: number; pending: number; unsub: number }>(
      "SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'unsubscribed'), 0) AS unsub FROM mail_memberships WHERE org_id = :org",
    ),
    ctx.db.count('mail_subscribers'),
    ctx.db.count('mail_suppressions'),
    ctx.db.count('mail_broadcasts'),
    ctx.db.count('mail_lists'),
  ]);
  return { subscribers: s, active: m?.active ?? 0, pending: m?.pending ?? 0, unsubscribed: m?.unsub ?? 0, suppressed: supp, broadcasts: b, lists: l };
}

/** The pixel was loaded. Counts once per delivery as "opened", and every load in `open_count`. */
export async function recordOpen(env: Env, token: string, now = Date.now()): Promise<boolean> {
  const t = await readOpenToken(env, token);
  if (!t) return false;
  const first = await env.DB.prepare('UPDATE mail_deliveries SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?3) WHERE id = ?1 AND org_id = ?2 RETURNING subscriber_id, open_count')
    .bind(t.d, t.o, now)
    .first<{ subscriber_id: string; open_count: number }>();
  if (first?.open_count === 1) await env.DB.prepare('UPDATE mail_subscribers SET opens = opens + 1 WHERE id = ?1 AND org_id = ?2').bind(first.subscriber_id, t.o).run();
  return true;
}

/** A tracked link was followed. Returns the destination, or null for a bad token. */
export async function recordClick(env: Env, token: string, now = Date.now(), opts: { count?: boolean } = {}): Promise<string | null> {
  const t = await readClickToken(env, token);
  if (!t) return null;
  const link = await env.DB.prepare('SELECT url FROM mail_links WHERE id = ?1 AND org_id = ?2').bind(t.k, t.o).first<{ url: string }>();
  if (!link) return null;
  if (opts.count === false) return link.url;
  await env.DB.batch([
    env.DB.prepare('UPDATE mail_links SET clicks = clicks + 1 WHERE id = ?1 AND org_id = ?2').bind(t.k, t.o),
    env.DB.prepare('UPDATE mail_deliveries SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?3) WHERE id = ?1 AND org_id = ?2').bind(t.d, t.o, now),
    env.DB.prepare('UPDATE mail_subscribers SET clicks = clicks + 1 WHERE org_id = ?2 AND id = (SELECT subscriber_id FROM mail_deliveries WHERE id = ?1 AND org_id = ?2)').bind(t.d, t.o),
  ]);
  return link.url;
}
