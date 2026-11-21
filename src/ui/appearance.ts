/**
 * Appearance choices a workspace saves (Appearance screen) and how the UI reads them.
 * Stored as plain strings under the `appearance` setting; anything unknown falls back to the default,
 * so a bad or old value never breaks a page.
 */

export const MODES = ['system', 'light', 'dark'] as const;
export const ACCENTS = ['lime', 'mint', 'sky', 'violet', 'rose', 'amber'] as const;
export const PUBLIC_PRESETS = ['paper', 'warm', 'cobalt', 'dusk'] as const;

export type Mode = (typeof MODES)[number];
export type Accent = (typeof ACCENTS)[number];
export type PublicPreset = (typeof PUBLIC_PRESETS)[number];

export interface Appearance {
  /** Default colour mode for the dashboard. People can still pick their own. */
  mode: Mode;
  accent: Accent;
  /** Look of public pages (short-link previews, forms, status page). */
  preset: PublicPreset;
  /** Show the small "Powered by Toolshed" link on public pages. */
  powered: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', accent: 'lime', preset: 'paper', powered: true };

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Reads the saved settings (any shape) into a complete, valid Appearance. */
export function parseAppearance(saved: Record<string, unknown> | null | undefined): Appearance {
  const s = saved ?? {};
  return {
    mode: pick(MODES, s.mode, DEFAULT_APPEARANCE.mode),
    accent: pick(ACCENTS, s.accent, DEFAULT_APPEARANCE.accent),
    preset: pick(PUBLIC_PRESETS, s.preset, DEFAULT_APPEARANCE.preset),
    powered: s.powered === undefined ? DEFAULT_APPEARANCE.powered : s.powered === true || s.powered === 'true' || s.powered === '1',
  };
}
