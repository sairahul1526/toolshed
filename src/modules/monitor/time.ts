/** Time helpers: minute slots for the dispatcher and workspace time zones for quiet hours and maintenance. */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function minuteOf(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}

export function hourOf(ms: number): number {
  return Math.floor(ms / HOUR) * HOUR;
}

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStart(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

/** A stable small number from an id, used to spread monitors across the minutes of their interval. */
export function slotFor(id: string, intervalMin: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % intervalMin;
}

/** True when a monitor with this interval and slot runs in the minute starting at `at`. */
export function isDueMinute(at: number, intervalMin: number, slot: number): boolean {
  if (intervalMin <= 1) return true;
  return Math.floor(at / MINUTE) % intervalMin === slot % intervalMin;
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at the instant `utcMs`, in ms (east is positive). */
export function tzOffsetMs(tz: string, utcMs: number): number {
  if (tz === 'UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 is Sunday. */
  weekday: number;
}

export function localParts(tz: string, utcMs: number): LocalParts {
  const shifted = new Date(utcMs + tzOffsetMs(tz, utcMs));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** The UTC instant at which the wall clock in `tz` reads the given date and time. */
export function localToUtc(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - tzOffsetMs(tz, guess);
  utc = guess - tzOffsetMs(tz, utc);
  return utc;
}

/** True when the wall-clock time at `at` falls inside `from` to `to` ("HH:MM"). Windows may cross midnight. */
export function inQuietHours(from: string | null, to: string | null, tz: string, at: number): boolean {
  if (!from || !to || from === to) return false;
  const p = localParts(tz, at);
  const now = p.hour * 60 + p.minute;
  const [fh, fm] = from.split(':').map(Number) as [number, number];
  const [th, tm] = to.split(':').map(Number) as [number, number];
  const a = fh * 60 + fm;
  const b = th * 60 + tm;
  return a < b ? now >= a && now < b : now >= a || now < b;
}
