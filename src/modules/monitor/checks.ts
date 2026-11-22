/** One HTTP or keyword check. Pure of the database: takes a monitor, returns what happened. */
import { describeFetchError, safeFetch } from './outbound';
import { type MonitorRow, parseStatusSpec } from './schema';
import { parseJson } from '../../core/db';

export interface CheckResult {
  ok: boolean;
  /** Time to the last byte, in ms. */
  ms: number;
  code: number | null;
  /** Short plain reason when not ok. */
  error: string | null;
}

type CheckInput = Pick<MonitorRow, 'url' | 'method' | 'headers' | 'body' | 'expected_status' | 'keyword' | 'keyword_mode' | 'timeout_ms' | 'follow_redirects'>;

/** Run the check once. Never throws. */
export async function runCheck(m: CheckInput, now: () => number = Date.now): Promise<CheckResult> {
  const started = now();
  const wantsBody = m.keyword_mode !== 'none' && !!m.keyword;
  try {
    const res = await safeFetch(
      m.url ?? '',
      {
        method: m.method,
        headers: parseJson<Record<string, string>>(m.headers, {}),
        body: m.body,
        timeoutMs: m.timeout_ms,
        followRedirects: m.follow_redirects === 1,
      },
      wantsBody,
    );
    const ms = Math.max(0, now() - started);
    const accepts = parseStatusSpec(m.expected_status) ?? ((c: number) => c >= 200 && c < 300);
    if (!accepts(res.status)) {
      return { ok: false, ms, code: res.status, error: `Got status ${res.status}, expected ${m.expected_status}` };
    }
    if (wantsBody) {
      const found = res.text.toLowerCase().includes((m.keyword ?? '').toLowerCase());
      if (m.keyword_mode === 'present' && !found) return { ok: false, ms, code: res.status, error: `Keyword “${clip(m.keyword!)}” not found` };
      if (m.keyword_mode === 'absent' && found) return { ok: false, ms, code: res.status, error: `Keyword “${clip(m.keyword!)}” found, and it should not be` };
    }
    return { ok: true, ms, code: res.status, error: null };
  } catch (err) {
    return { ok: false, ms: Math.max(0, now() - started), code: null, error: describeFetchError(err) };
  }
}

function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
