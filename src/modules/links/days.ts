/** Days are UTC calendar days written as YYYY-MM-DD, so they sort as text. */
export const DAY_MS = 86_400_000;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

/** Every day from `from` to `to`, inclusive. Capped at 800 days. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isDay = (s: string): boolean => /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** A range from the last `days` days ending today, or from explicit `from` and `to` days. */
export function resolveRange(opts: { days?: number; from?: string; to?: string }, now = Date.now()): { from: string; to: string } {
  const to = opts.to && isDay(opts.to) ? opts.to : dayOf(now);
  const from = opts.from && isDay(opts.from) ? opts.from : addDays(to, -((opts.days && opts.days > 0 ? Math.min(opts.days, 400) : 30) - 1));
  return from <= to ? { from, to } : { from: to, to: from };
}
