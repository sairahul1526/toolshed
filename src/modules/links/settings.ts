import { z } from 'zod';
import { parse } from '../../core/errors';
import { getModuleSettings, setModuleSettings } from '../../core/registry';
import type { Env } from '../../env';

export interface LinksSettings extends Record<string, unknown> {
  defaultRedirectType: 301 | 302 | 307;
  codeLength: number;
}

export const DEFAULT_SETTINGS: LinksSettings = { defaultRedirectType: 302, codeLength: 7 };

const schema = z.object({
  defaultRedirectType: z.union([z.literal(301), z.literal(302), z.literal(307)]),
  codeLength: z.coerce.number().int().min(5).max(12),
});

export function getSettings(env: Env, orgId: string): Promise<LinksSettings> {
  return getModuleSettings(env, orgId, 'links', DEFAULT_SETTINGS);
}

export async function saveSettings(env: Env, orgId: string, input: unknown): Promise<LinksSettings> {
  const current = await getSettings(env, orgId);
  const next = parse(schema.partial(), input);
  const merged: LinksSettings = { ...current, ...next } as LinksSettings;
  await setModuleSettings(env, orgId, 'links', merged);
  return merged;
}
