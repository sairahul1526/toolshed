/**
 * Outbound requests to addresses a user typed in (checks, webhooks, the alive ping).
 * A thin adapter over the shared `core/net`: every address check and every redirect hop is done there.
 * This file only sets the timeout and body cap, times nothing of its own, and turns core errors into
 * Monitor's own error codes and plain sentences.
 */
import { AppError } from '../../core/errors';
import { assertPublicUrl as corePublicUrl, safeFetch as coreFetch } from '../../core/net';
import { monitorErrors } from './errors';

/** Parse an address with the shared rules. A refusal is a field error on `field`, so a form can show it in place. */
export function assertPublicUrl(raw: string, field = 'url'): URL {
  try {
    return corePublicUrl(raw);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    throw monitorErrors.url_not_allowed(undefined, { [field]: 'That address can’t be checked. Use a public http or https address.' });
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  /** Follow redirects (each hop re-checked by core). When false, the first redirect is reported as a 302 and never followed. */
  followRedirects?: boolean;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  /** First `maxBytes` of the body as text, or '' when not asked for. */
  text: string;
}

const USER_AGENT = 'Toolshed-Monitor/1.0';

/** One request through core `safeFetch`. The body is cut at `maxBytes`, never failed on. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}, readBody = false, maxBytes = 512 * 1024): Promise<SafeResponse> {
  const follow = opts.followRedirects !== false;
  try {
    const res = await coreFetch(rawUrl, {
      method: opts.method ?? 'GET',
      headers: { 'user-agent': USER_AGENT, ...(opts.headers ?? {}) },
      body: opts.body ?? undefined,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxRedirects: follow ? (opts.maxRedirects ?? 5) : 0,
      maxBytes: readBody ? maxBytes : 1,
      truncate: true,
    });
    return { status: res.status, text: readBody ? await res.text() : '' };
  } catch (err) {
    // Core has no "don't follow" mode, so a redirect with following off arrives as this error.
    if (!follow && err instanceof AppError && err.code === 'too_many_redirects') return { status: 302, text: '' };
    throw err;
  }
}

/** The public base URL of this install, from APP_URL or the request. */
export function baseUrl(env: { APP_URL?: string }, requestUrl?: string): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, '');
  if (requestUrl) return new URL(requestUrl).origin;
  return 'http://localhost:8787';
}

const BY_CODE: Record<string, string> = {
  url_not_allowed: 'Address not allowed',
  fetch_timeout: 'Timed out',
  too_many_redirects: 'Too many redirects',
  redirect_not_followed: 'Redirected somewhere unsafe, not followed',
  fetch_too_large: 'Answer too large',
  fetch_failed: 'Connection failed',
};

/** A short plain sentence for a fetch failure. Never includes a stack or internal detail. */
export function describeFetchError(err: unknown): string {
  if (err instanceof AppError) return BY_CODE[err.code.replace(/^monitor\./, '')] ?? 'Request failed';
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(msg)) return 'Timed out';
  return 'Request failed';
}
