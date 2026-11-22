/** Saving and resetting the workspace look. Both check the role, write the setting and add an audit line. */
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { needRole } from '../../core/guards';
import { parse } from '../../core/errors';
import { deleteSetting, setSetting } from '../../core/settings';
import { changedKeys, KEY_LABELS, loadLook, lookSchema, merge, SETTING, toLook, toStored, type Look, type LookInput } from './data';

function sentence(keys: (keyof Look)[]): string {
  return keys.map((k) => KEY_LABELS[k]).join(', ');
}

/** Validates the posted form and saves it. Returns the keys that changed (empty when nothing did). */
export async function saveLook(c: Context<AppEnv>, body: Record<string, unknown>): Promise<(keyof Look)[]> {
  needRole(c, 'admin');
  const org = c.get('org')!;
  const input: LookInput = parse(lookSchema, body);
  const { raw, look } = await loadLook(c.env, org.id);
  const next = merge(look, input);
  const changed = changedKeys(look, next);
  if (changed.length === 0) return changed;
  await setSetting(c.env, org.id, SETTING, toStored(raw, next));
  await auditFromRequest(c, {
    action: 'appearance.updated',
    targetType: 'appearance',
    targetId: org.id,
    summary: `Changed the appearance: ${sentence(changed)}`,
    meta: { changed },
  });
  return changed;
}

/** Back to the Toolshed defaults. Returns the keys that changed (empty when it already was default). */
export async function resetLook(c: Context<AppEnv>): Promise<(keyof Look)[]> {
  needRole(c, 'admin');
  const org = c.get('org')!;
  const { raw, look } = await loadLook(c.env, org.id);
  const changed = changedKeys(look, toLook({}));
  if (Object.keys(raw).length === 0) return changed;
  await deleteSetting(c.env, org.id, SETTING);
  await auditFromRequest(c, {
    action: 'appearance.updated',
    targetType: 'appearance',
    targetId: org.id,
    summary: 'Put the appearance back to the Toolshed defaults',
    meta: { changed, reset: true },
  });
  return changed;
}
