/**
 * Where to send someone after sign-in. Only a path on this site is ever accepted, so a crafted
 * link cannot bounce a freshly signed-in person to another site.
 */
const BLOCKED = ['/sign-in', '/sign-out', '/sign-up', '/api/', '/setup'];

export function safeNext(value: unknown, fallback = '/app'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return fallback;
  // One leading slash only: `//host` and `/\host` are other sites to a browser.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, 'http://self.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'http://self.invalid') return fallback;
  const path = url.pathname;
  // The parser resolves `.` and `..` (also written `%2e`), so `/.//host` and `/a/..//host` come
  // out as `//host`: another site again. Judge the path that will be sent, not the one typed.
  if (path.startsWith('//') || path.includes('\\')) return fallback;
  if (BLOCKED.some((b) => path === b || path.startsWith(b.endsWith('/') ? b : `${b}/`))) return fallback;
  return path + url.search;
}
