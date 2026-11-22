/** Position, the leaderboard and the cached public count. Position is always a count, never a stored number. */
import { orgDb, type OrgDb } from '../../core/db';
import type { Env } from '../../env';
import type { Signup, Waitlist } from './types';

type Ranked = Pick<Signup, 'is_test' | 'score' | 'seq' | 'status'>;

/** Place in line (1 is first), including the owner's head start. Null when the person is not in line. */
export async function positionOf(db: OrgDb, wl: Waitlist, s: Ranked): Promise<number | null> {
  if (s.status !== 'active') return null;
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = ? AND status = 'active' AND (score < ? OR (score = ? AND seq < ?))`,
    wl.id,
    s.is_test,
    s.score,
    s.score,
    s.seq,
  );
  return (row?.n ?? 0) + 1 + wl.head_start;
}

export async function queueSize(db: OrgDb, wl: Waitlist, test = 0): Promise<number> {
  const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = ? AND status = 'active'`, wl.id, test);
  return (row?.n ?? 0) + wl.head_start;
}

const COUNT_TTL = 300;

/** "N people joined", shared by every visitor for a few minutes so the page costs no database count. */
export async function publicCount(env: Env, wl: Waitlist): Promise<number> {
  const key = `wl:count:${wl.id}`;
  const hit = await env.KV.get(key);
  if (hit !== null) return Number(hit) || 0;
  const row = await orgDb(env.DB, wl.org_id).first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND status NOT IN ('removed', 'flagged')`,
    wl.id,
  );
  const total = (row?.n ?? 0) + wl.anon_count + wl.head_start;
  await env.KV.put(key, String(total), { expirationTtl: COUNT_TTL });
  return total;
}

export interface Leader {
  name: string;
  referrals: number;
}

/** "Jo K." from "Jo Kim", or "jo***" from an address, so the public board never shows an email. */
export function maskName(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
  if (parts.length === 1) return parts[0]!;
  return `${email.slice(0, 2)}***`;
}

export async function leaderboard(env: Env, wl: Waitlist): Promise<Leader[]> {
  if (!wl.leaderboard_on) return [];
  const key = `wl:board:${wl.id}`;
  const hit = await env.KV.get(key);
  if (hit) return JSON.parse(hit) as Leader[];
  const rows = await orgDb(env.DB, wl.org_id).all<Pick<Signup, 'name' | 'email' | 'referral_count'>>(
    `SELECT name, email, referral_count FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND status IN ('active', 'invited', 'accepted') AND referral_count > 0 ORDER BY referral_count DESC, seq ASC LIMIT ?`,
    wl.id,
    wl.leaderboard_size,
  );
  const board = rows.map((r) => ({ name: maskName(r.name, r.email), referrals: r.referral_count }));
  await env.KV.put(key, JSON.stringify(board), { expirationTtl: COUNT_TTL });
  return board;
}

/** Move one person to a place in line by changing only their own offset. */
export async function moveTo(db: OrgDb, wl: Waitlist, s: Signup, place: number): Promise<number> {
  const target = Math.max(1, Math.floor(place) - wl.head_start);
  const around = await db.all<{ score: number }>(
    `SELECT score FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = ? AND status = 'active' AND id != ? ORDER BY score ASC, seq ASC LIMIT 2 OFFSET ?`,
    wl.id,
    s.is_test,
    s.id,
    Math.max(0, target - 2),
  );
  const [first, second] = around;
  let score: number;
  if (target <= 1) score = (first?.score ?? s.score + 1) - 1;
  else if (second) score = (first!.score + second.score) / 2;
  else score = (first?.score ?? s.score) + 1;
  const delta = score - s.score;
  await db.run('UPDATE wl_signups SET manual_offset = manual_offset + ?, adj = adj + ? WHERE org_id = :org AND id = ?', delta, delta, s.id);
  return target + wl.head_start;
}
