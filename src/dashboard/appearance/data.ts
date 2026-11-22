/**
 * What the Appearance screen reads and accepts. The saved value lives in the workspace setting
 * `appearance`; the same setting feeds every page's `data-*` attributes (see src/ui/appearance.ts)
 * and the logo in emails (see src/core/email-templates/brand.ts).
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { assertPublicUrl } from '../../core/net';
import { getSetting } from '../../core/settings';
import { ACCENTS, MODES, PUBLIC_PRESETS, parseAppearance, type Appearance } from '../../ui/appearance';

export const SETTING = 'appearance';
export const MAX_LOGO_URL = 2048;

export interface Look extends Appearance {
  /** https address of the workspace logo, or null for the Toolshed mark. */
  logoUrl: string | null;
}

export type Raw = Record<string, unknown>;

export function toLook(raw: Raw): Look {
  return { ...parseAppearance(raw), logoUrl: typeof raw.logoUrl === 'string' && raw.logoUrl !== '' ? raw.logoUrl : null };
}

/** The saved setting as stored (so keys other code keeps in it survive a save) and the same read as a Look. */
export async function loadLook(env: Env, orgId: string): Promise<{ raw: Raw; look: Look }> {
  const raw = await getSetting<Raw>(env, orgId, SETTING, {});
  const safe = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { raw: safe, look: toLook(safe) };
}

/** Why a logo address is refused, in words for the field, or null when it is fine. */
export function logoProblem(value: string): string | null {
  if (value === '') return null;
  if (value.length > MAX_LOGO_URL) return 'That address is too long. Use one under 2,000 characters.';
  let url: URL;
  try {
    url = assertPublicUrl(value);
  } catch {
    return 'Enter a public web address that starts with https://, for example https://example.com/logo.png.';
  }
  return url.protocol === 'https:' ? null : 'The address must start with https:// so it loads safely in emails.';
}

function choice<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { error: 'Pick one of the options shown.' });
}

/** Fields that are left out of a post keep their saved value; a value that is sent must be valid. */
export const lookSchema = z.object({
  mode: choice(MODES).optional(),
  accent: choice(ACCENTS).optional(),
  preset: choice(PUBLIC_PRESETS).optional(),
  powered: choice(['on', 'off']).optional(),
  logoUrl: z
    .string({ error: 'Enter a web address.' })
    .trim()
    .refine((v) => logoProblem(v) === null, { error: (issue) => logoProblem(String(issue.input)) ?? 'Enter a web address.' })
    .optional(),
});

export type LookInput = z.infer<typeof lookSchema>;

/** Plain words for the audit line and the flash message. */
export const KEY_LABELS: Record<keyof Look, string> = {
  mode: 'dashboard mode',
  accent: 'accent colour',
  preset: 'public page look',
  powered: 'Powered by Toolshed line',
  logoUrl: 'logo address',
};

export function merge(current: Look, input: LookInput): Look {
  return {
    mode: input.mode ?? current.mode,
    accent: input.accent ?? current.accent,
    preset: input.preset ?? current.preset,
    powered: input.powered === undefined ? current.powered : input.powered === 'on',
    logoUrl: input.logoUrl === undefined ? current.logoUrl : input.logoUrl === '' ? null : assertPublicUrl(input.logoUrl).toString(),
  };
}

/** Keys whose value differs. */
export function changedKeys(before: Look, after: Look): (keyof Look)[] {
  return (Object.keys(KEY_LABELS) as (keyof Look)[]).filter((k) => before[k] !== after[k]);
}

/** The setting to store: what was there, with this screen's keys written over it. */
export function toStored(raw: Raw, look: Look): Raw {
  const { logoUrl, ...rest } = look;
  const next: Raw = { ...raw, ...rest };
  if (logoUrl) next.logoUrl = logoUrl;
  else delete next.logoUrl;
  return next;
}
