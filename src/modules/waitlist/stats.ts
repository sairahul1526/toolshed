/** The numbers on the stats screen. Test signups never count. */
import type { OrgDb } from '../../core/db';
import type { Waitlist } from './types';

const DAY = 86_400_000;

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Count one page view for today. Bots are filtered before this is called. */
export async function recordView(db: OrgDb, wl: Waitlist, now = Date.now()): Promise<void> {
  await db.run('INSERT INTO wl_daily (org_id, waitlist_id, day, views) VALUES (:org, ?, ?, 1) ON CONFLICT (waitlist_id, day) DO UPDATE SET views = views + 1', wl.id, dayKey(now));
}

export interface Stats {
  days: number;
  labels: string[];
  signups: number[];
  total: number;
  confirmed: number;
  referred: number;
  credited: number;
  /** Credited referrals per person on the list. Above 1 means the list grows by itself. */
  kFactor: number;
  views: number;
  /** Signups divided by page views over the same days, as a percentage. Null when there are no views. */
  conversion: number | null;
  sources: { label: string; count: number }[];
  topReferrers: { name: string; email: string; referrals: number }[];
}

export async function waitlistStats(db: OrgDb, wl: Waitlist, days = 30, now = Date.now()): Promise<Stats> {
  const since = now - (days - 1) * DAY;
  const start = Date.UTC(new Date(since).getUTCFullYear(), new Date(since).getUTCMonth(), new Date(since).getUTCDate());
  const [byDay, totals, views, sources, top] = await Promise.all([
    db.all<{ day: string; n: number }>(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND created_at >= ? GROUP BY day`,
      wl.id,
      start,
    ),
    db.first<{ total: number; confirmed: number; referred: number; credited: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(email_verified), 0) AS confirmed, COALESCE(SUM(referred_by IS NOT NULL), 0) AS referred, COALESCE(SUM(referral_status = 'credited'), 0) AS credited FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND status != 'removed'`,
      wl.id,
    ),
    db.first<{ n: number }>('SELECT COALESCE(SUM(views), 0) AS n FROM wl_daily WHERE org_id = :org AND waitlist_id = ? AND day >= ?', wl.id, dayKey(start)),
    db.all<{ label: string; n: number }>(
      `SELECT CASE WHEN referred_by IS NOT NULL THEN 'referral' WHEN source = '' THEN 'direct' ELSE source END AS label, COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND status != 'removed' GROUP BY label ORDER BY n DESC LIMIT 8`,
      wl.id,
    ),
    db.all<{ name: string; email: string; referral_count: number }>(
      `SELECT name, email, referral_count FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND status != 'removed' AND referral_count > 0 ORDER BY referral_count DESC, seq ASC LIMIT 10`,
      wl.id,
    ),
  ]);
  const counts = new Map(byDay.map((r) => [r.day, r.n]));
  const labels: string[] = [];
  const signups: number[] = [];
  for (let i = 0; i < days; i++) {
    const key = dayKey(start + i * DAY);
    labels.push(key);
    signups.push(counts.get(key) ?? 0);
  }
  const total = totals?.total ?? 0;
  const inPeriod = signups.reduce((a, b) => a + b, 0);
  const seen = views?.n ?? 0;
  return {
    days,
    labels,
    signups,
    total,
    confirmed: totals?.confirmed ?? 0,
    referred: totals?.referred ?? 0,
    credited: totals?.credited ?? 0,
    kFactor: total ? Math.round(((totals?.credited ?? 0) / total) * 100) / 100 : 0,
    views: seen,
    conversion: seen > 0 ? Math.min(100, Math.round((inPeriod / seen) * 1000) / 10) : null,
    sources: sources.map((s) => ({ label: s.label, count: s.n })),
    topReferrers: top.map((t) => ({ name: t.name, email: t.email, referrals: t.referral_count })),
  };
}
