/** Small pure helpers: slugs, cursors, names, text limits. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lowercase ASCII words joined by dashes. Falls back to `fallback` when nothing is left. */
export function slugify(text: string, max = 60, fallback = 'post'): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return base || fallback;
}

export const PORTAL_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/** Words that would shadow routes or look official. */
export const RESERVED_PORTAL_SLUGS = new Set(['app', 'api', 'assets', 'admin', 'www', 'embed', 'img', 'widget', 'feedback', 'roadmap', 'changelog', 'static', 'public']);

export function randomSuffix(len = 4): string {
  const alphabet = 'abcdefghjkmnpqrstvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function initials(name: string, email?: string | null): string {
  const clean = name.trim();
  if (clean) {
    const parts = clean.split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    return (first + last).toUpperCase();
  }
  return (email?.[0] ?? '?').toUpperCase();
}

/** "Ada Lovelace" becomes "Ada L." when the portal hides last names. */
export function displayName(name: string, opts: { hideLast?: boolean; fallback?: string } = {}): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return opts.fallback ?? 'Someone';
  if (!opts.hideLast) return clean;
  const parts = clean.split(' ');
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(email);
}

export function countLinks(text: string): number {
  return (text.match(/\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./gi) ?? []).length;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function encodeCursor(parts: (string | number)[]): string {
  return btoa(JSON.stringify(parts)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string | undefined | null): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const pad = cursor.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((cursor.length + 3) % 4);
    const parsed = JSON.parse(atob(pad));
    return Array.isArray(parsed) && parsed.length <= 3 && parsed.every((p) => typeof p === 'string' || typeof p === 'number') ? parsed : null;
  } catch {
    return null;
  }
}

/** Title words worth matching on: lowercase, 3+ letters, no filler. */
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'can', 'could', 'would', 'should', 'have', 'has', 'not', 'are', 'was', 'this', 'that', 'from', 'but', 'add', 'allow', 'ability', 'able', 'want', 'need', 'please', 'when', 'what', 'how', 'why', 'there', 'would', 'like', 'make', 'support', 'into', 'out', 'any', 'all']);
export function titleWords(text: string, max = 6): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9À-￿]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    seen.add(w);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Escape `%`, `_` and the escape character for a LIKE ... ESCAPE '\\' pattern. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function dayKey(ms: number, tz = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

export function formatDate(ms: number, tz = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Drop keys whose value is undefined, so a partial update never writes NULL by accident. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
