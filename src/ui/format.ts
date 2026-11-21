/**
 * Number, date and text helpers shared by every screen. All of them are pure and take an
 * explicit `now` or `locale` where the answer would otherwise change between runs.
 */

const LOCALE = 'en-US';

/** 18420 -> "18,420". Non-finite input shows an en dash so a bad value never reads as zero. */
export function formatNumber(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat(LOCALE).format(n) : '–';
}

/** 18420 -> "18.4K", 2_300_000 -> "2.3M". Below 1,000 the number is shown as is. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

type DateInput = number | Date;

function toDate(at: DateInput): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Nov 18, 2026". Times are always UTC so the same value reads the same everywhere. */
export function formatDate(at: DateInput): string {
  const d = toDate(at);
  return d ? new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' }).format(d) : '–';
}

/** "Nov 18, 2026, 9:05 AM UTC". */
export function formatDateTime(at: DateInput): string {
  const d = toDate(at);
  return d ? `${new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d)} UTC` : '–';
}

const UNITS: [number, string][] = [
  [60, 'minute'],
  [60 * 60, 'hour'],
  [60 * 60 * 24, 'day'],
];

/** "just now", "5 minutes ago", "3 days ago". Older than 30 days falls back to the date. */
export function timeAgo(at: DateInput, now: DateInput = Date.now()): string {
  const d = toDate(at);
  const n = toDate(now);
  if (!d || !n) return '–';
  const seconds = Math.round((n.getTime() - d.getTime()) / 1000);
  if (seconds < 0) return formatDate(d);
  if (seconds < 60) return 'just now';
  const days = Math.floor(seconds / 86400);
  if (days > 30) return formatDate(d);
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [size, name] = UNITS[i]!;
    if (seconds >= size) return `${plural(Math.floor(seconds / size), name)} ago`;
  }
  return 'just now';
}

/** 1536 -> "1.5 KB". Uses 1,024 steps and shows whole numbers for bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const text = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[i]}`;
}

/** plural(1, 'link') -> "1 link", plural(2, 'link') -> "2 links", plural(3, 'person', 'people') -> "3 people". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** "Maya Reyes" -> "MR", "prince" -> "P", "" -> "?". Works for non-Latin names and emoji. */
export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]!][0] ?? '?';
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + last).toUpperCase();
}
