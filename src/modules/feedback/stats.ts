/** Numbers for the Stats screen: posts, votes and comments by day, top posts, status flow, time to first reply. */
import type { Ctx } from './portal';

export interface DayPoint {
  day: string;
  posts: number;
  votes: number;
  comments: number;
}

export interface Stats {
  days: number;
  series: DayPoint[];
  totals: { posts: number; votes: number; comments: number };
  top: { id: string; title: string; slug: string; votes: number; comments: number; status: string | null }[];
  flow: { name: string; tone: string; count: number }[];
  moves: { from: string; to: string; count: number }[];
  firstReply: { count: number; medianMs: number | null; averageMs: number | null; unanswered: number };
}

function dayList(days: number, now: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export async function computeStats(ctx: Ctx, days = 30, now = Date.now()): Promise<Stats> {
  const list = dayList(days, now);
  const since = new Date(`${list[0]}T00:00:00Z`).getTime();
  const [posts, votes, comments, top, flow, moves, replies, unanswered] = await Promise.all([
    ctx.db.all<{ d: string; n: number }>("SELECT date(created_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM fb_posts WHERE org_id = :org AND review IN ('published', 'merged') AND created_at >= ? GROUP BY d", since),
    ctx.db.all<{ d: string; n: number }>("SELECT date(created_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM fb_votes WHERE org_id = :org AND created_at >= ? GROUP BY d", since),
    ctx.db.all<{ d: string; n: number }>("SELECT date(created_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM fb_comments WHERE org_id = :org AND review = 'published' AND created_at >= ? GROUP BY d", since),
    ctx.db.all<{ id: string; title: string; slug: string; votes: number; comments: number; status: string | null }>(
      "SELECT p.id, p.title, p.slug, p.vote_count AS votes, p.comment_count AS comments, s.name AS status FROM fb_posts p LEFT JOIN fb_statuses s ON s.id = p.status_id WHERE p.org_id = :org AND p.review = 'published' ORDER BY p.vote_count DESC, p.id DESC LIMIT 10",
    ),
    ctx.db.all<{ name: string; tone: string; count: number }>(
      "SELECT s.name, s.tone, COUNT(p.id) AS count FROM fb_statuses s LEFT JOIN fb_posts p ON p.status_id = s.id AND p.review = 'published' WHERE s.org_id = :org GROUP BY s.id ORDER BY s.position",
    ),
    ctx.db.all<{ from_name: string | null; to_name: string | null; count: number }>(
      "SELECT a.name AS from_name, b.name AS to_name, COUNT(*) AS count FROM fb_status_log l LEFT JOIN fb_statuses a ON a.id = l.from_status LEFT JOIN fb_statuses b ON b.id = l.to_status WHERE l.org_id = :org AND l.at >= ? GROUP BY l.from_status, l.to_status ORDER BY count DESC LIMIT 12",
      since,
    ),
    ctx.db.all<{ d: number }>('SELECT first_reply_at - created_at AS d FROM fb_posts WHERE org_id = :org AND first_reply_at IS NOT NULL AND created_at >= ? ORDER BY d LIMIT 2000', since),
    ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM fb_posts WHERE org_id = :org AND review = 'published' AND first_reply_at IS NULL AND created_at >= ?", since),
  ]);
  const pick = (rows: { d: string; n: number }[]) => new Map(rows.map((r) => [r.d, r.n]));
  const p = pick(posts);
  const v = pick(votes);
  const c = pick(comments);
  const series = list.map((day) => ({ day, posts: p.get(day) ?? 0, votes: v.get(day) ?? 0, comments: c.get(day) ?? 0 }));
  const durations = replies.map((r) => Math.max(0, r.d));
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  return {
    days,
    series,
    totals: { posts: series.reduce((a, b) => a + b.posts, 0), votes: series.reduce((a, b) => a + b.votes, 0), comments: series.reduce((a, b) => a + b.comments, 0) },
    top,
    flow,
    moves: moves.map((m) => ({ from: m.from_name ?? 'New', to: m.to_name ?? 'Removed', count: m.count })),
    firstReply: { count: durations.length, medianMs: median, averageMs: avg, unanswered: unanswered?.n ?? 0 },
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'No replies yet';
  const mins = ms / 60000;
  if (mins < 1) return 'Under a minute';
  if (mins < 90) return `${Math.round(mins)} minutes`;
  const hours = mins / 60;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
