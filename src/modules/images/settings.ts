/** Workspace-wide choices for the module. Stored with the module's state, read on a cache miss. */
import { z } from 'zod';
import { parse } from '../../core/errors';
import { getModuleSettings, setModuleSettings } from '../../core/registry';
import type { Env } from '../../env';

export interface ImageSettings {
  /** Draw PNG files on the server. Off by default: it needs more CPU time than the free Workers plan gives. */
  serverPng: boolean;
  /** Most new images the workspace may make in one UTC day. 0 stops all new images. */
  dailyCap: number;
  /** Sites whose pictures a template may load by address. Uploaded pictures always work. */
  allowedHosts: string[];
}

export const DEFAULT_SETTINGS: ImageSettings = { serverPng: false, dailyCap: 1000, allowedHosts: [] };
export const MAX_DAILY_CAP = 100_000;

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const settingsSchema = z.object({
  serverPng: z.boolean(),
  dailyCap: z.number().int().min(0, 'Use 0 or more.').max(MAX_DAILY_CAP, `Use ${MAX_DAILY_CAP} or less.`),
  allowedHosts: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(HOST, 'Use a site name such as images.example.com, without https:// or a path.'),
    )
    .max(20, 'You can allow 20 sites at most.'),
});

export async function getSettings(env: Env, orgId: string): Promise<ImageSettings> {
  const stored = await getModuleSettings<Record<string, unknown>>(env, orgId, 'images', {});
  const checked = settingsSchema.partial().safeParse(stored);
  return { ...DEFAULT_SETTINGS, ...(checked.success ? checked.data : {}) };
}

/** Saves a full or partial set of settings and returns what is now stored. */
export async function saveSettings(env: Env, orgId: string, input: unknown): Promise<ImageSettings> {
  const patch = parse(settingsSchema.partial(), input);
  const next = { ...(await getSettings(env, orgId)), ...patch };
  next.allowedHosts = [...new Set(next.allowedHosts)];
  await setModuleSettings(env, orgId, 'images', { ...next });
  return next;
}
