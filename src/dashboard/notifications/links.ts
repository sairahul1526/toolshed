/**
 * Stored links come from other parts of the app, and a redirect to one must never leave this site.
 * Only a plain path is followed: it starts with one `/`, and has no backslash, space or control
 * character (browsers read `/\evil.example` and `/<tab>/evil.example` as `//evil.example`).
 */
export function sitePath(value: string | null | undefined): string | null {
  if (!value || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\u0000- \u007f\\]/.test(value)) return null;
  return value;
}

/** Where to go after a form: the page the person was on, or the list. */
export function returnTo(value: unknown): string {
  return typeof value === 'string' ? (sitePath(value) ?? '/app/notifications') : '/app/notifications';
}
