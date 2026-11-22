/** Small formatting helpers shared by messages, emails and screens. */

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}

/** "2026-11-21 14:32 UTC" */
export function fmtUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function pct(up: number, down: number): number | null {
  const total = up + down;
  return total === 0 ? null : (up / total) * 100;
}

/** 99.98 -> "99.98%"; never rounds a non-perfect value up to 100. */
export function fmtPct(value: number | null): string {
  if (value === null) return 'No data';
  if (value >= 100) return '100%';
  const floored = Math.floor(value * 100) / 100;
  const text = floored.toFixed(2).replace(/\.?0+$/, '');
  return `${text}%`;
}
