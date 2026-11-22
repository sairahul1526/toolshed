/** The state machine: given what a monitor looked like and one new observation, what is it now? Pure. */
import type { MonitorRow, MonitorStatus } from './schema';

export interface Runtime {
  status: MonitorStatus;
  slow: number;
  fail_streak: number;
  slow_streak: number;
  since_at: number | null;
  last_error: string | null;
  last_code: number | null;
}

export type StateEvent = 'down' | 'up' | 'slow' | 'unslow';

export interface Observation {
  ok: boolean;
  ms: number;
  code: number | null;
  error: string | null;
}

export interface Advance {
  next: Runtime;
  events: StateEvent[];
  /** True when any column of the monitor row has to be written. */
  changed: boolean;
  /** True when the first result moved it from pending to up (no alert, but it is recorded). */
  firstUp: boolean;
}

export const runtimeOf = (m: Pick<MonitorRow, keyof Runtime>): Runtime => ({
  status: m.status,
  slow: m.slow,
  fail_streak: m.fail_streak,
  slow_streak: m.slow_streak,
  since_at: m.since_at,
  last_error: m.last_error,
  last_code: m.last_code,
});

/**
 * Apply one check result. `failAfter` is how many failures in a row make it down; a heartbeat that
 * was told it failed passes 1. A recovery needs one good check.
 */
export function advance(
  cur: Runtime,
  obs: Observation,
  cfg: { failAfter: number; slowMs: number | null; slowAfter: number },
  at: number,
): Advance {
  const next: Runtime = { ...cur };
  const events: StateEvent[] = [];
  let firstUp = false;

  if (obs.ok) {
    next.fail_streak = 0;
    next.last_error = null;
    next.last_code = obs.code;
    if (cur.status !== 'up') {
      next.status = 'up';
      next.since_at = at;
      if (cur.status === 'down') events.push('up');
      else firstUp = true;
    }
    if (cfg.slowMs && obs.ms > cfg.slowMs) {
      next.slow_streak = Math.min(cur.slow_streak + 1, Math.max(1, cfg.slowAfter));
      if (next.slow_streak >= cfg.slowAfter && !cur.slow) {
        next.slow = 1;
        events.push('slow');
      }
    } else {
      next.slow_streak = 0;
      if (cur.slow) {
        next.slow = 0;
        events.push('unslow');
      }
    }
  } else {
    next.fail_streak = Math.min(cur.fail_streak + 1, Math.max(1, cfg.failAfter));
    next.last_error = obs.error;
    next.last_code = obs.code;
    next.slow_streak = 0;
    if (next.fail_streak >= cfg.failAfter && cur.status !== 'down') {
      next.status = 'down';
      next.since_at = at;
      events.push('down');
    }
  }
  if (events.includes('up') && cur.slow) next.slow = 0;

  const changed =
    next.status !== cur.status ||
    next.slow !== cur.slow ||
    next.fail_streak !== cur.fail_streak ||
    next.slow_streak !== cur.slow_streak ||
    next.last_error !== cur.last_error ||
    next.last_code !== cur.last_code;
  return { next, events, changed, firstUp };
}

/**
 * When a heartbeat is late: its last successful ping plus the period plus the grace, or for one
 * that has never been pinged, its creation time plus the same. Returns the deadline in ms.
 */
export function heartbeatDeadline(m: Pick<MonitorRow, 'hb_last_ping_at' | 'created_at' | 'hb_period_sec' | 'hb_grace_sec'>): number | null {
  if (!m.hb_period_sec) return null;
  return (m.hb_last_ping_at ?? m.created_at) + (m.hb_period_sec + m.hb_grace_sec) * 1000;
}
