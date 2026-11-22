/**
 * Days and hours in a site's own time zone. Hits are stored in UTC milliseconds and also carry the
 * site-local day they belong to, so totals never depend on the time zone of whoever is looking.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalTime {
  /** `YYYY-MM-DD` in the site's time zone. */
  day: string;
  hour: number;
  minute: number;
  /** 0 is Sunday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localTime(tz: string, ms: number): LocalTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? 'Sun'),
  };
}

export function localDay(tz: string, ms: number): string {
  return localTime(tz, ms).day;
}

const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written as `YYYY-MM-DD`. */
export function isDay(text: string): boolean {
  if (!DAY_TEXT.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === text;
}

/** Move a `YYYY-MM-DD` day by a number of days. Works on the calendar, so time zones do not matter. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (0 when they are the same day). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/** Every day from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1200; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The UTC instant at which `day` starts in `tz`. Two passes settle daylight saving changes. */
export function dayStart(tz: string, day: string): number {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const t = localTime(tz, guess);
    const shown = Date.parse(`${t.day}T00:00:00Z`) + t.hour * HOUR + t.minute * MINUTE;
    const diff = shown - wall;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}
