/** Choosing people: the filter behind the signups list, invite waves and broadcasts. */
import type { OrgDb, Scalar } from '../../core/db';
import { SIGNUP_STATUSES, type Segment, type Signup, type SignupStatus } from './types';

const text = (v: unknown, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Read a segment from form fields, query strings or JSON, dropping anything unknown or empty. */
export function parseSegment(raw: unknown): Segment {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const seg: Segment = {};
  const status = text(src.status, 20);
  if ((SIGNUP_STATUSES as readonly string[]).includes(status)) seg.status = status as SignupStatus;
  const tag = text(src.tag).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (tag) seg.tag = tag;
  if (text(src.source, 60)) seg.source = text(src.source, 60);
  if (text(src.tier, 60)) seg.tier = text(src.tier, 60);
  if (text(src.q)) seg.q = text(src.q);
  const min = Number(src.minReferrals);
  if (Number.isFinite(min) && min > 0) seg.minReferrals = Math.floor(min);
  if (src.verified === true || src.verified === 'yes' || src.verified === '1') seg.verified = true;
  if (src.verified === false || src.verified === 'no' || src.verified === '0') seg.verified = false;
  return seg;
}

export function segmentSummary(seg: Segment): string {
  const parts: string[] = [];
  if (seg.status) parts.push(`status ${seg.status}`);
  if (seg.tag) parts.push(`tag ${seg.tag}`);
  if (seg.source) parts.push(`source ${seg.source}`);
  if (seg.minReferrals) parts.push(`${seg.minReferrals}+ referrals`);
  if (seg.verified !== undefined) parts.push(seg.verified ? 'verified' : 'unverified');
  if (seg.q) parts.push(`matching "${seg.q}"`);
  return parts.length ? parts.join(', ') : 'everyone';
}

export interface Where {
  sql: string;
  params: Scalar[];
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** SQL conditions (each starting with AND) for one waitlist and a segment. Removed people appear only when asked for. */
export function segmentWhere(waitlistId: string, seg: Segment, test: boolean): Where {
  const sql: string[] = ['AND waitlist_id = ?', 'AND is_test = ?'];
  const params: Scalar[] = [waitlistId, test ? 1 : 0];
  if (seg.status) {
    sql.push('AND status = ?');
    params.push(seg.status);
  } else sql.push(`AND status != 'removed'`);
  if (seg.tag) {
    sql.push(`AND tags LIKE ? ESCAPE '\\'`);
    params.push(like(`,${seg.tag},`));
  }
  if (seg.source) {
    sql.push('AND source = ?');
    params.push(seg.source);
  }
  if (seg.minReferrals) {
    sql.push('AND referral_count >= ?');
    params.push(seg.minReferrals);
  }
  if (seg.tier) {
    sql.push('AND id IN (SELECT signup_id FROM wl_reached WHERE tier_id = ?)');
    params.push(seg.tier);
  }
  if (seg.verified !== undefined) {
    sql.push('AND email_verified = ?');
    params.push(seg.verified ? 1 : 0);
  }
  if (seg.q) {
    sql.push(`AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`);
    params.push(like(seg.q), like(seg.q));
  }
  return { sql: sql.join(' '), params };
}

export const SORTS = {
  position: 'score ASC, seq ASC',
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  referrals: 'referral_count DESC, seq ASC',
} as const;
export type SortKey = keyof typeof SORTS;

export interface ListOptions {
  segment?: Segment;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
  test?: boolean;
}

export async function listSignups(db: OrgDb, waitlistId: string, opts: ListOptions = {}): Promise<{ rows: Signup[]; total: number }> {
  const where = segmentWhere(waitlistId, opts.segment ?? {}, opts.test ?? false);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 25), 200);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [rows, count] = await Promise.all([
    db.all<Signup>(`SELECT * FROM wl_signups WHERE org_id = :org ${where.sql} ORDER BY ${SORTS[opts.sort ?? 'position']} LIMIT ? OFFSET ?`, ...where.params, pageSize, (page - 1) * pageSize),
    db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org ${where.sql}`, ...where.params),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export async function countSegment(db: OrgDb, waitlistId: string, seg: Segment): Promise<number> {
  const where = segmentWhere(waitlistId, seg, false);
  const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org ${where.sql}`, ...where.params);
  return row?.n ?? 0;
}

/** The first `limit` people in line who match, best place first. Only active people can be invited. */
export function topInLine(db: OrgDb, waitlistId: string, seg: Segment, limit: number): Promise<Signup[]> {
  const where = segmentWhere(waitlistId, { ...seg, status: 'active' }, false);
  return db.all<Signup>(`SELECT * FROM wl_signups WHERE org_id = :org ${where.sql} ORDER BY score ASC, seq ASC LIMIT ?`, ...where.params, limit);
}

/** The next page of a segment by id, for jobs that walk a whole list in batches. */
export function pageAfter(db: OrgDb, waitlistId: string, seg: Segment, after: string, limit: number): Promise<Signup[]> {
  const where = segmentWhere(waitlistId, seg, false);
  return db.all<Signup>(`SELECT * FROM wl_signups WHERE org_id = :org ${where.sql} AND id > ? ORDER BY id ASC LIMIT ?`, ...where.params, after, limit);
}
