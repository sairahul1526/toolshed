/**
 * A person's passkeys: list, rename, remove. Adding one needs the browser, so it lives in
 * `routes/passkey.ts` with a button any page can carry (`data-passkey-add`, see docs/auth.md).
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { parse } from '../../core/errors';
import type { AppEnv } from '../../env';
import { authErrors } from '../errors';
import { actorFrom, auditBy, freshFrom, selfFrom } from './actor';

export interface PasskeyView {
  id: string;
  /** The name the person gave it, or "Passkey" when they gave none. */
  name: string;
  /** When it was added, ms. Null for one added before dates were kept. */
  createdAt: number | null;
  /** True when the passkey is synced between the person's devices (a phone or a password manager). */
  synced: boolean;
}

const passkeyNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the passkey a name.')
  .max(60, 'Keep the name under 60 characters.')
  .refine((v) => !/[\u0000-\u001f\u007f<>]/.test(v), 'Use letters, numbers and simple punctuation only.');

/** The asking person's passkeys, oldest first. One query. */
export async function listPasskeys(c: Context<AppEnv>): Promise<PasskeyView[]> {
  const actor = await actorFrom(c);
  const { results } = await c.env.DB.prepare(
    `SELECT "id", "name", "createdAt", "backedUp" FROM "passkey" WHERE "userId" = ?1 ORDER BY "createdAt", "id" LIMIT 100`,
  )
    .bind(actor.id)
    .all<{ id: string; name: string | null; createdAt: string | null; backedUp: number }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name?.trim() || 'Passkey',
    createdAt: row.createdAt ? Date.parse(row.createdAt) : null,
    synced: !!row.backedUp,
  }));
}

/** Give one of your passkeys a new name. */
export async function renamePasskey(c: Context<AppEnv>, passkeyId: string, input: { name: string }): Promise<PasskeyView> {
  const actor = await selfFrom(c);
  const { name } = parse(z.object({ name: passkeyNameSchema }), { name: input.name });
  const row = await c.env.DB.prepare('UPDATE "passkey" SET "name" = ?1 WHERE "id" = ?2 AND "userId" = ?3 RETURNING "id", "createdAt", "backedUp"')
    .bind(name, typeof passkeyId === 'string' ? passkeyId : '', actor.id)
    .first<{ id: string; createdAt: string | null; backedUp: number }>();
  if (!row) throw authErrors.passkey_not_found();
  await auditBy(c.env, actor, { orgId: null, action: 'passkey.renamed', targetType: 'user', targetId: actor.id, summary: `Renamed a passkey to “${name}”` });
  return { id: row.id, name, createdAt: row.createdAt ? Date.parse(row.createdAt) : null, synced: !!row.backedUp };
}

/** Remove one of your passkeys. Emailed codes always work, so removing the last one locks nobody out. */
export async function removePasskey(c: Context<AppEnv>, passkeyId: string): Promise<void> {
  const actor = await freshFrom(c);
  const row = await c.env.DB.prepare('DELETE FROM "passkey" WHERE "id" = ?1 AND "userId" = ?2 RETURNING "name"')
    .bind(typeof passkeyId === 'string' ? passkeyId : '', actor.id)
    .first<{ name: string | null }>();
  if (!row) throw authErrors.passkey_not_found();
  const name = row.name?.trim();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'passkey.removed',
    targetType: 'user',
    targetId: actor.id,
    summary: name ? `Removed the passkey “${name}”` : 'Removed a passkey',
  });
}
