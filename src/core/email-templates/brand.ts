import type { Env } from '../../env';
import { getSetting, INSTANCE } from '../settings';
import type { Brand } from './types';

/** Settings key (scope: install) that holds the sender name and address. Shared with `email.ts`. */
export const SENDER_KEY = 'email.sender';
const DEFAULT_ACCENT = '#3f6212';

interface AppearanceSetting {
  logoUrl?: string;
  accent?: string;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Only absolute https URLs (or a path on this install) may be used as a logo in an email. */
function safeLogo(env: Env, url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const abs = url.startsWith('/') && env.APP_URL ? new URL(url, env.APP_URL) : new URL(url);
    return abs.protocol === 'https:' || (abs.protocol === 'http:' && abs.hostname === 'localhost') ? abs.toString() : null;
  } catch {
    return null;
  }
}

/** Sender name, logo and accent: the workspace's appearance wins over the install's, then "Toolshed". */
export async function resolveBrand(env: Env, orgId?: string | null): Promise<Brand> {
  const [sender, installLook, orgLook, footer] = await Promise.all([
    getSetting<{ fromName?: string }>(env, INSTANCE, SENDER_KEY, {}),
    getSetting<AppearanceSetting>(env, INSTANCE, 'appearance', {}),
    orgId ? getSetting<AppearanceSetting>(env, orgId, 'appearance', {}) : Promise.resolve({} as AppearanceSetting),
    orgId ? getSetting<string | null>(env, orgId, 'email.footer', null) : Promise.resolve(null),
  ]);
  const look = { ...installLook, ...orgLook };
  const name = (sender.fromName ?? '').trim();
  return {
    name: name || 'Toolshed',
    logoUrl: safeLogo(env, look.logoUrl),
    accent: isHexColor(look.accent) ? look.accent : DEFAULT_ACCENT,
    footer: typeof footer === 'string' && footer.trim() ? footer.trim().slice(0, 300) : null,
  };
}
