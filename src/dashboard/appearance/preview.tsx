/**
 * Small drawings of the dashboard and of a public page in the saved look. They are SVG with
 * presentation attributes (not inline styles) so they obey the strict style rules, work without
 * JavaScript, and never load anything from another site. The colours repeat the ones in
 * toolshed.css and public.css; keep them in step when those change.
 */
import type { Accent, PublicPreset } from '../../ui/appearance';

const HUES: Record<Accent, number> = { lime: 128, mint: 165, sky: 230, violet: 275, rose: 350, amber: 55 };

export function accentFill(accent: Accent): string {
  return `oklch(0.87 0.2 ${HUES[accent]})`;
}
export function accentEdge(accent: Accent): string {
  return `oklch(0.48 0.13 ${HUES[accent]})`;
}

interface PublicColors {
  bg: string;
  fg: string;
  ac: string;
  on: string;
}
const PUBLIC: Record<PublicPreset, { light: PublicColors; dark: PublicColors }> = {
  paper: { light: { bg: '#fafaf7', fg: '#1d1d1b', ac: '#1d1d1b', on: '#fafaf7' }, dark: { bg: '#141413', fg: '#ecebe6', ac: '#ecebe6', on: '#141413' } },
  warm: { light: { bg: '#f6efe4', fg: '#3b2a1a', ac: '#c2622d', on: '#ffffff' }, dark: { bg: '#1f1810', fg: '#f1e6d6', ac: '#e8895a', on: '#1f1810' } },
  cobalt: { light: { bg: '#eef2fb', fg: '#14213d', ac: '#2f55d4', on: '#ffffff' }, dark: { bg: '#0f1626', fg: '#e4eaf8', ac: '#7f9bff', on: '#0f1626' } },
  dusk: { light: { bg: '#f3f0fb', fg: '#2a2540', ac: '#6a4fd8', on: '#ffffff' }, dark: { bg: '#16161d', fg: '#ecebf3', ac: '#b8a4ff', on: '#16161d' } },
};

export type Scheme = 'light' | 'dark';

interface Surface {
  bg: string;
  surface: string;
  text: string;
  faint: string;
  line: string;
}
const DASH: Record<Scheme, Surface> = {
  light: { bg: '#f6f6f4', surface: '#ffffff', text: '#1f1f1d', faint: '#b4b4b0', line: '#e4e4e0' },
  dark: { bg: '#161514', surface: '#1e1d1c', text: '#efeeea', faint: '#5d5c58', line: '#2c2b29' },
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Sidebar, top bar and a card with a primary button, in the chosen accent. */
export function DashboardSketch({ accent, scheme, name }: { accent: Accent; scheme: Scheme; name: string }) {
  const s = DASH[scheme];
  const fill = accentFill(accent);
  const button = scheme === 'dark' ? fill : '#1f1f1d';
  const buttonText = scheme === 'dark' ? '#1b2a05' : '#ffffff';
  const active = scheme === 'dark' ? fill : accentEdge(accent);
  return (
    <svg viewBox="0 0 320 190" width="100%" role="img" aria-label={`Dashboard in ${scheme} mode with the ${accent} accent`} focusable="false">
      <rect width="320" height="190" rx="10" fill={s.bg} stroke={s.line} />
      <rect x="1" y="1" width="76" height="188" rx="9" fill={s.surface} />
      <rect x="1" y="1" width="76" height="188" rx="9" fill="none" stroke={s.line} />
      <rect x="12" y="14" width="14" height="14" rx="4" fill={fill} />
      <rect x="32" y="18" width="30" height="6" rx="3" fill={s.text} />
      <rect x="8" y="44" width="62" height="18" rx="5" fill={fill} fill-opacity="0.22" />
      <rect x="8" y="48" width="3" height="10" rx="1.5" fill={active} />
      <rect x="18" y="51" width="34" height="5" rx="2.5" fill={s.text} />
      <rect x="18" y="75" width="40" height="5" rx="2.5" fill={s.faint} />
      <rect x="18" y="95" width="30" height="5" rx="2.5" fill={s.faint} />
      <rect x="18" y="115" width="38" height="5" rx="2.5" fill={s.faint} />
      <line x1="77" y1="30" x2="319" y2="30" stroke={s.line} />
      <text x="90" y="19" font-size="9" fill={s.text} font-family="Inter, system-ui, sans-serif">{clip(name, 26)}</text>
      <circle cx="298" cy="15" r="6" fill={s.faint} />
      <rect x="90" y="44" width="70" height="9" rx="4" fill={s.text} />
      <rect x="90" y="66" width="218" height="104" rx="8" fill={s.surface} stroke={s.line} />
      <rect x="102" y="80" width="110" height="6" rx="3" fill={s.text} />
      <rect x="102" y="94" width="160" height="5" rx="2.5" fill={s.faint} />
      <rect x="102" y="106" width="130" height="5" rx="2.5" fill={s.faint} />
      <rect x="102" y="126" width="132" height="5" rx="2.5" fill={fill} fill-opacity="0.35" />
      <rect x="102" y="126" width="84" height="5" rx="2.5" fill={fill} />
      <rect x="102" y="142" width="48" height="20" rx="6" fill={button} />
      <text x="126" y="155.5" font-size="9" font-weight="500" text-anchor="middle" fill={buttonText} font-family="Inter, system-ui, sans-serif">Save</text>
    </svg>
  );
}

/** A form-style public page: brand, card, field, button and the optional "Powered by" line. */
export function PublicSketch({ preset, scheme, name, powered }: { preset: PublicPreset; scheme: Scheme; name: string; powered: boolean }) {
  const c = PUBLIC[preset][scheme];
  const font = 'Inter, system-ui, sans-serif';
  return (
    <svg viewBox="0 0 320 190" width="100%" role="img" aria-label={`Public page in the ${preset} look, ${scheme} mode, ${powered ? 'with' : 'without'} the Powered by Toolshed line`} focusable="false">
      <rect width="320" height="190" rx="10" fill={c.bg} stroke={c.fg} stroke-opacity="0.16" />
      <text x="160" y="24" font-size="10" font-weight="600" text-anchor="middle" fill={c.fg} font-family={font}>{clip(name, 30)}</text>
      <rect x="60" y="36" width="200" height={powered ? 118 : 134} rx="10" fill={c.fg} fill-opacity="0.05" stroke={c.fg} stroke-opacity="0.16" />
      <text x="76" y="62" font-size="13" font-weight="600" fill={c.fg} font-family={font}>Contact us</text>
      <rect x="76" y="76" width="168" height="22" rx="6" fill={c.bg} stroke={c.fg} stroke-opacity="0.3" />
      <rect x="84" y="84" width="60" height="5" rx="2.5" fill={c.fg} fill-opacity="0.35" />
      <rect x="76" y="108" width="168" height="22" rx="6" fill={c.bg} stroke={c.fg} stroke-opacity="0.3" />
      <rect x="84" y="116" width="90" height="5" rx="2.5" fill={c.fg} fill-opacity="0.35" />
      <rect x="76" y={powered ? 138 : 140} width="56" height="10" rx="5" fill={c.ac} />
      <text x="104" y={powered ? 145.5 : 147.5} font-size="7" font-weight="500" text-anchor="middle" fill={c.on} font-family={font}>Send</text>
      {powered ? (
        <text x="160" y="172" font-size="8" text-anchor="middle" fill={c.fg} fill-opacity="0.6" font-family={font}>Powered by Toolshed</text>
      ) : null}
    </svg>
  );
}

/** A round swatch for one accent. The name is always written next to it, so colour is never the only cue. */
export function Swatch({ accent }: { accent: Accent }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <circle cx="14" cy="14" r="12" fill={accentFill(accent)} stroke={accentEdge(accent)} stroke-width="1.5" />
    </svg>
  );
}

/** Half light, half dark thumbnail of a public page preset. */
export function PresetThumb({ preset }: { preset: PublicPreset }) {
  const l = PUBLIC[preset].light;
  const d = PUBLIC[preset].dark;
  return (
    <svg width="100%" viewBox="0 0 120 56" aria-hidden="true" focusable="false">
      <rect width="60" height="56" rx="6" fill={l.bg} />
      <rect x="60" width="60" height="56" rx="6" fill={d.bg} />
      <rect x="60" width="6" height="56" fill={d.bg} />
      <rect x="8" y="10" width="34" height="6" rx="3" fill={l.fg} />
      <rect x="8" y="22" width="26" height="4" rx="2" fill={l.fg} fill-opacity="0.4" />
      <rect x="8" y="36" width="22" height="10" rx="4" fill={l.ac} />
      <rect x="68" y="10" width="34" height="6" rx="3" fill={d.fg} />
      <rect x="68" y="22" width="26" height="4" rx="2" fill={d.fg} fill-opacity="0.4" />
      <rect x="68" y="36" width="22" height="10" rx="4" fill={d.ac} />
      <rect width="120" height="56" rx="6" fill="none" stroke="#808080" stroke-opacity="0.35" />
    </svg>
  );
}
