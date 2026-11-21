/**
 * One-time messages that survive a redirect: set one in a POST handler, show it on the next page.
 *
 *   setFlash(c, { kind: 'ok', message: 'Invite sent.' });
 *   return c.redirect('/app/members');
 *
 * renderPage() reads and clears it, so screens never call takeFlash themselves.
 * The cookie is short lived, HttpOnly and only holds text the server wrote.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export interface Flash {
  kind: 'ok' | 'error' | 'info';
  message: string;
}

const COOKIE = 'ts_flash';
const MAX_MESSAGE = 240;
const KINDS = ['ok', 'error', 'info'];

export function setFlash(c: Context, flash: Flash): void {
  const value = encodeURIComponent(JSON.stringify({ kind: flash.kind, message: flash.message.slice(0, MAX_MESSAGE) }));
  setCookie(c, COOKIE, value, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60, secure: new URL(c.req.url).protocol === 'https:' });
}

/** Returns the pending message, if any, and clears it. Anything malformed is dropped. */
export function takeFlash(c: Context): Flash | null {
  const raw = getCookie(c, COOKIE);
  if (raw === undefined) return null;
  deleteCookie(c, COOKIE, { path: '/' });
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { kind, message } = parsed as Record<string, unknown>;
    if (typeof message !== 'string' || message.length === 0 || typeof kind !== 'string' || !KINDS.includes(kind)) return null;
    return { kind: kind as Flash['kind'], message: message.slice(0, MAX_MESSAGE) };
  } catch {
    return null;
  }
}
