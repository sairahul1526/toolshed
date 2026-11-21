import { describe, expect, it } from 'vitest';
import { formatBytes, formatCompact, formatDate, formatDateTime, formatNumber, initials, plural, timeAgo } from '../../src/ui/format';
import { DEFAULT_APPEARANCE, parseAppearance } from '../../src/ui/appearance';

const NOW = Date.UTC(2026, 10, 21, 9, 30);

describe('format', () => {
  it('formats numbers and handles bad input', () => {
    expect(formatNumber(18420)).toBe('18,420');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(NaN)).toBe('–');
    expect(formatCompact(18420)).toBe('18.4K');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(2_300_000)).toBe('2.3M');
  });
  it('formats dates in UTC', () => {
    expect(formatDate(NOW)).toBe('Nov 21, 2026');
    expect(formatDateTime(NOW)).toContain('UTC');
    expect(formatDate(NaN)).toBe('–');
  });
  it('says how long ago', () => {
    expect(timeAgo(NOW - 5_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(timeAgo(NOW - 3_600_000, NOW)).toBe('1 hour ago');
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
    expect(timeAgo(NOW - 60 * 86_400_000, NOW)).toBe('Sep 22, 2026');
    expect(timeAgo(NOW + 1000, NOW)).toBe('Nov 21, 2026');
  });
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5.4e12)).toBe('4.9 TB');
    expect(formatBytes(-1)).toBe('–');
  });
  it('pluralises', () => {
    expect(plural(1, 'link')).toBe('1 link');
    expect(plural(0, 'link')).toBe('0 links');
    expect(plural(3, 'person', 'people')).toBe('3 people');
  });
  it('makes initials from any script', () => {
    expect(initials('Maya Reyes')).toBe('MR');
    expect(initials('prince')).toBe('P');
    expect(initials('')).toBe('?');
    expect(initials('maya.reyes@example.com')).toBe('MR');
    expect(initials('夏のキャンペーン')).toBe('夏');
    expect(initials('🎉 Party')).toBe('🎉P');
  });
});

describe('parseAppearance', () => {
  it('falls back to defaults for anything unknown', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({ accent: 'pink', mode: 3, preset: 'x' })).toEqual(DEFAULT_APPEARANCE);
  });
  it('keeps valid values', () => {
    expect(parseAppearance({ accent: 'violet', mode: 'dark', preset: 'dusk', powered: false })).toEqual({ accent: 'violet', mode: 'dark', preset: 'dusk', powered: false });
    expect(parseAppearance({ powered: 'true' }).powered).toBe(true);
  });
});
