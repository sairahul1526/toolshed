/** The endpoint's running record of successes and failures, which decides when it is turned off. */
import type { Env } from '../../env';
import { RETRY_HORIZON_MS } from './types';

/**
 * The statement that records one real try. Returns the endpoint's `failing_since` (null after a success).
 *
 * A failure that comes later than the whole retry schedule after the previous one starts a new
 * streak. Retries of one event are never that far apart, so a gap this long means the receiver was
 * quiet or working in between, and one failure after a quiet week must not count against the old streak.
 */
export function healthStatement(env: Env, endpoint: { id: string; org_id: string }, ok: boolean, now: number): D1PreparedStatement {
  if (ok) {
    return env.DB.prepare(
      `UPDATE webhook_endpoints SET last_success_at = ?3, consecutive_failures = 0, failing_since = NULL WHERE org_id = ?1 AND id = ?2 RETURNING failing_since`,
    ).bind(endpoint.org_id, endpoint.id, now);
  }
  const newStreak = '(failing_since IS NULL OR ?3 - last_failure_at > ?4)';
  return env.DB.prepare(
    `UPDATE webhook_endpoints SET last_failure_at = ?3,
       consecutive_failures = CASE WHEN ${newStreak} THEN 1 ELSE consecutive_failures + 1 END,
       failing_since = CASE WHEN ${newStreak} THEN ?3 ELSE failing_since END
     WHERE org_id = ?1 AND id = ?2 RETURNING failing_since`,
  ).bind(endpoint.org_id, endpoint.id, now, RETRY_HORIZON_MS);
}
