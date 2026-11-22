/** One try at a receiver: sign the body, POST it, and describe what came back. Never throws. */
import type { Env } from '../../env';
import { parseJson } from '../db';
import { AppError } from '../errors';
import { safeFetch } from '../net';
import type { EndpointRow } from './rows';
import { headersAad, open, secretAad } from './seal';
import { signPayload } from './signing';
import { pointsAtThisInstall } from './url';
import { type AttemptResult, MAX_RESPONSE_BYTES, SNIPPET_BYTES, TIMEOUT_MS, USER_AGENT } from './types';

export interface Sendable {
  id: string;
  message_id: string;
  payload: string;
}

/** The error codes we record for a failed try. Redirects are named for what happened, not for the shared fetch error. */
function errorCodeOf(err: unknown): string {
  if (err instanceof AppError) return err.code === 'too_many_redirects' ? 'redirect_not_followed' : err.code;
  return 'fetch_failed';
}

async function signatures(env: Env, endpoint: EndpointRow, delivery: Sendable, timestampSec: number, now: number): Promise<string | null> {
  const current = await open(env, secretAad(endpoint.id), endpoint.secret_enc);
  if (!current) return null;
  const list = [await signPayload(current, delivery.message_id, timestampSec, delivery.payload)];
  if (endpoint.prev_secret_enc && endpoint.prev_secret_expires_at !== null && endpoint.prev_secret_expires_at > now) {
    const previous = await open(env, secretAad(endpoint.id), endpoint.prev_secret_enc);
    if (previous) list.push(await signPayload(previous, delivery.message_id, timestampSec, delivery.payload));
  }
  return list.join(' ');
}

export async function performAttempt(env: Env, endpoint: EndpointRow, delivery: Sendable, now: number): Promise<AttemptResult> {
  const started = Date.now();
  const done = (partial: Pick<AttemptResult, 'ok' | 'statusCode' | 'errorCode' | 'responseSnippet'>): AttemptResult => ({
    deliveryId: delivery.id,
    messageId: delivery.message_id,
    durationMs: Date.now() - started,
    ...partial,
  });
  try {
    // Rows saved before this check, or an APP_URL set later, can still point back at this install.
    if (pointsAtThisInstall(env, endpoint.url)) return done({ ok: false, statusCode: null, errorCode: 'url_not_allowed', responseSnippet: null });
    const timestampSec = Math.floor(now / 1000);
    const signature = await signatures(env, endpoint, delivery, timestampSec, now);
    if (!signature) return done({ ok: false, statusCode: null, errorCode: 'secret_unreadable', responseSnippet: null });

    let custom: Record<string, string> = {};
    if (endpoint.headers_enc) {
      // Sending without headers the receiver expects (an Authorization header, say) would only make it refuse the event.
      const opened = await open(env, headersAad(endpoint.id), endpoint.headers_enc);
      if (opened === null) return done({ ok: false, statusCode: null, errorCode: 'headers_unreadable', responseSnippet: null });
      custom = parseJson<Record<string, string>>(opened, {});
    }
    const headers = new Headers(custom);
    headers.set('content-type', 'application/json');
    headers.set('user-agent', USER_AGENT);
    headers.set('webhook-id', delivery.message_id);
    headers.set('webhook-timestamp', String(timestampSec));
    headers.set('webhook-signature', signature);

    const res = await safeFetch(endpoint.url, {
      method: 'POST',
      headers,
      body: delivery.payload,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      truncate: true,
      maxRedirects: 0,
    });
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).subarray(0, SNIPPET_BYTES));
    const ok = res.status >= 200 && res.status < 300;
    return done({ ok, statusCode: res.status, errorCode: ok ? null : `http_${res.status}`, responseSnippet: text || null });
  } catch (err) {
    return done({ ok: false, statusCode: null, errorCode: errorCodeOf(err), responseSnippet: null });
  }
}
