/**
 * Things a person changes about their own account. Every function works on the signed-in person
 * only (there is no "user id" input to get wrong), and the ones that change how the account is
 * signed in to ask for a recent sign-in.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { errors, parse } from '../../core/errors';
import type { AppEnv } from '../../env';
import { getAuth } from '../auth';
import { FRESH_SIGN_IN_SEC, MIN_PASSWORD_LENGTH } from '../config';
import { authErrors } from '../errors';
import { MAX_PASSWORD_LENGTH } from '../hasher';
import { clearSessionCookies } from '../signin';
import { eraseUser, soleOwnerOf, type BlockingWorkspace } from '../user-store';
import { actorFrom, auditBy, freshFrom, selfFrom } from './actor';
import { END_IMPERSONATIONS, FORGET_TRUSTED_DEVICES } from './sessions';

export interface AccountSummary {
  id: string;
  email: string;
  name: string;
  username: string | null;
  hasPassword: boolean;
  twoStep: boolean;
  passkeys: number;
  isInstanceOwner: boolean;
  /** When the account was made, ms. */
  createdAt: number;
  /** True when this sign-in is recent enough for changes that ask for one. */
  fresh: boolean;
  /** Set while the instance owner is signed in as this person. */
  impersonatedBy: string | null;
}

/** What the Account screen needs to draw itself. Two queries. */
export async function getAccount(c: Context<AppEnv>, now = Date.now()): Promise<AccountSummary> {
  const actor = await actorFrom(c);
  const row = await c.env.DB.prepare(
    `SELECT u."username" AS username, u."role" AS role, u."twoFactorEnabled" AS twoStep, u."createdAt" AS createdAt,
            (SELECT COUNT(*) FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = 'credential' AND a."password" IS NOT NULL) AS passwords,
            (SELECT COUNT(*) FROM "passkey" p WHERE p."userId" = u."id") AS passkeys
       FROM "user" u WHERE u."id" = ?1`,
  )
    .bind(actor.id)
    .first<{ username: string | null; role: string | null; twoStep: number | null; createdAt: string; passwords: number; passkeys: number }>();
  if (!row) throw authErrors.user_not_found();
  return {
    id: actor.id,
    email: actor.email,
    name: actor.name,
    username: row.username,
    hasPassword: row.passwords > 0,
    twoStep: !!row.twoStep,
    passkeys: row.passkeys,
    isInstanceOwner: row.role === 'admin',
    createdAt: Date.parse(row.createdAt),
    fresh: !actor.impersonatedBy && now - actor.signedInAt <= FRESH_SIGN_IN_SEC * 1000,
    impersonatedBy: actor.impersonatedBy,
  };
}

export const personNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name.')
  .max(80, 'Keep your name under 80 characters.')
  .refine((v) => !/[\u0000-\u001f\u007f<>]/.test(v), 'Use letters, numbers and simple punctuation only.');

/** Change the name other people see. */
export async function changeName(c: Context<AppEnv>, input: { name: string }): Promise<{ name: string }> {
  const actor = await selfFrom(c);
  const { name } = parse(z.object({ name: personNameSchema }), { name: input.name });
  if (name === actor.name) return { name };
  await c.env.DB.prepare('UPDATE "user" SET "name" = ?1, "updatedAt" = ?2 WHERE "id" = ?3').bind(name, new Date().toISOString(), actor.id).run();
  await auditBy(c.env, actor, { orgId: null, action: 'user.renamed', targetType: 'user', targetId: actor.id, summary: `Changed their name to ${name}` });
  return { name };
}

/**
 * Set a password, or replace the one there is. The current password is not asked for: the recent
 * sign-in is the proof, which also keeps this to one hash per request. Every other device is
 * signed out.
 */
export async function setPassword(c: Context<AppEnv>, input: { password: string }): Promise<{ replaced: boolean }> {
  const actor = await freshFrom(c);
  const password = typeof input.password === 'string' ? input.password : '';
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) throw authErrors.password_weak();
  if (length > MAX_PASSWORD_LENGTH) throw authErrors.password_too_long();

  const ctx = await (await getAuth(c.env, c.req.url)).$context;
  const hash = await ctx.password.hash(password);
  const existing = await ctx.internalAdapter.findCredentialAccount(actor.id);
  if (existing) await ctx.internalAdapter.updatePassword(actor.id, hash);
  else await ctx.internalAdapter.linkAccount({ userId: actor.id, providerId: 'credential', accountId: actor.id, password: hash });

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?1 AND "id" <> ?2').bind(actor.id, actor.sessionId),
    c.env.DB.prepare(END_IMPERSONATIONS).bind(actor.id),
    c.env.DB.prepare(FORGET_TRUSTED_DEVICES).bind(actor.id),
  ]);
  await auditBy(c.env, actor, {
    orgId: null,
    action: existing ? 'password.changed' : 'password.added',
    targetType: 'user',
    targetId: actor.id,
    summary: existing ? 'Changed their password' : 'Added a password',
  });
  return { replaced: !!existing };
}

/** Go back to signing in without a password. Emailed codes always work, so nobody is locked out. */
export async function removePassword(c: Context<AppEnv>): Promise<void> {
  const actor = await freshFrom(c);
  // The username goes with it. A username left without a password would answer sign-in faster
  // than one that does not exist, which tells a stranger the name is real.
  const [gone] = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM "account" WHERE "userId" = ?1 AND "providerId" = 'credential'`).bind(actor.id),
    c.env.DB.prepare('UPDATE "user" SET "username" = NULL, "displayUsername" = NULL WHERE "id" = ?1 AND "username" IS NOT NULL').bind(actor.id),
  ]);
  if (!gone?.meta.changes) return;
  await auditBy(c.env, actor, { orgId: null, action: 'password.removed', targetType: 'user', targetId: actor.id, summary: 'Removed their password' });
}

/** Lower case, 3 to 30 letters, numbers, dots or underscores. Never an email address. */
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{3,30}$/, 'Use 3 to 30 letters, numbers, dots or underscores.');

/** Set, change or clear (null) the optional username. It needs a password on the account (`auth.username_needs_password`), and goes when the password does. */
export async function setUsername(c: Context<AppEnv>, input: { username: string | null }): Promise<{ username: string | null }> {
  const actor = await selfFrom(c);
  const username = input.username === null || input.username === '' ? null : parse(z.object({ username: usernameSchema }), input).username;
  if (username) {
    const taken = await c.env.DB.prepare('SELECT 1 AS yes FROM "user" WHERE "username" = ?1 AND "id" <> ?2').bind(username, actor.id).first<{ yes: number }>();
    if (taken) throw authErrors.username_taken();
  }
  let saved: number | undefined;
  try {
    // Having a password is part of the statement, so removing it at the same moment cannot leave a username behind.
    const done = await c.env.DB.prepare(
      `UPDATE "user" SET "username" = ?1, "displayUsername" = ?1, "updatedAt" = ?2
        WHERE "id" = ?3 AND (?1 IS NULL OR EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = ?3 AND a."providerId" = 'credential' AND a."password" IS NOT NULL))`,
    )
      .bind(username, new Date().toISOString(), actor.id)
      .run();
    saved = done.meta.changes;
  } catch (err) {
    // Two people asking for the same name at once: the unique index decides.
    if (/UNIQUE/i.test(String((err as Error)?.message))) throw authErrors.username_taken();
    throw err;
  }
  if (saved !== 1) throw authErrors.username_needs_password();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'username.changed',
    targetType: 'user',
    targetId: actor.id,
    summary: username ? `Set their username to ${username}` : 'Removed their username',
  });
  return { username };
}

/**
 * The workspaces that stop this person deleting their account: the ones they alone own. Each
 * needs another owner, or to be deleted, first. An empty list means nothing is in the way.
 */
export async function accountDeletionBlockers(c: Context<AppEnv>): Promise<BlockingWorkspace[]> {
  const actor = await actorFrom(c);
  return soleOwnerOf(c.env, actor.id);
}

/**
 * Delete your own account for good. `confirm` must be your email address, typed out. Refused
 * while you are the only owner of a workspace (`auth.sole_owner`) or of this install
 * (`auth.last_instance_owner`): both would be left with nobody in charge.
 */
export async function deleteAccount(c: Context<AppEnv>, input: { confirm: string }): Promise<void> {
  const actor = await freshFrom(c);
  const typed = typeof input.confirm === 'string' ? input.confirm.trim().toLowerCase() : '';
  if (typed !== actor.email) throw errors.validation_failed(undefined, { confirm: `Type ${actor.email} to confirm.` });
  const outcome = await eraseUser(c.env, actor);
  if (outcome === 'last_instance_owner') throw authErrors.last_instance_owner();
  if (outcome !== 'done') throw authErrors.sole_owner();
  await auditBy(c.env, actor, { orgId: null, action: 'user.deleted', targetType: 'user', targetId: actor.id, summary: `Deleted their account (${actor.email})` });
  clearSessionCookies(c);
}
