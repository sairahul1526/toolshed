/** Heartbeat pings: a cron job calls /hb/<token> (or /start, /fail) and we remember when. The runner judges lateness each minute. */
import type { Env } from '../../env';
import { MINUTE } from './time';

export type PingKind = 'success' | 'start' | 'fail';
export type PingResult = 'ok' | 'unknown' | 'limited';

const MAX_PER_MINUTE = 12;

/** One atomic write per ping. Pings over the per-minute limit are dropped quietly (and tell the caller 429). */
export async function recordPing(env: Env, token: string, kind: PingKind, opts: { code?: number | null; note?: string | null; at?: number } = {}): Promise<PingResult> {
  const at = opts.at ?? Date.now();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return 'unknown';
  const win = Math.floor(at / MINUTE) * MINUTE;
  const code = opts.code !== undefined && opts.code !== null && Number.isFinite(opts.code) ? Math.trunc(opts.code) : null;
  const note = opts.note ? opts.note.slice(0, 200) : null;
  const res = await env.DB.prepare(
    `UPDATE mon_monitors SET
       hb_win_count = CASE WHEN hb_win_start = ?2 THEN hb_win_count + 1 ELSE 1 END,
       hb_win_start = ?2,
       hb_last_kind = CASE WHEN ?3 = 'start' THEN hb_last_kind ELSE ?3 END,
       hb_last_ping_at = CASE WHEN ?3 = 'success' THEN ?4 ELSE hb_last_ping_at END,
       hb_started_at = CASE WHEN ?3 = 'start' THEN ?4 ELSE hb_started_at END,
       hb_last_code = CASE WHEN ?3 = 'start' THEN hb_last_code ELSE ?5 END,
       hb_last_note = CASE WHEN ?3 = 'start' THEN hb_last_note ELSE ?6 END
     WHERE hb_token = ?1 AND type = 'heartbeat' AND paused = 0 AND (hb_win_start != ?2 OR hb_win_count < ?7)`,
  )
    .bind(token, win, kind, at, code, note, MAX_PER_MINUTE)
    .run();
  if ((res.meta?.changes ?? 0) > 0) return 'ok';
  const exists = await env.DB.prepare(`SELECT paused FROM mon_monitors WHERE hb_token = ?1 AND type = 'heartbeat'`).bind(token).first<{ paused: number }>();
  if (!exists) return 'unknown';
  return exists.paused ? 'ok' : 'limited';
}
