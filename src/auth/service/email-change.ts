/**
 * Changing the email an account signs in with. The new address has to prove itself first: a code
 * goes to it, and nothing about the account changes until that code comes back.
 *
 * An address that already has an account gets the same answer as any other, and no email, so
 * this cannot be used to find out who has an account here.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { sendEmail } from '../../core/email';
import { renderEmail } from '../../core/email-templates';
import { parse } from '../../core/errors';
import type { AppEnv } from '../../env';
import { issueCode, redeemCode } from '../codes';
import { CODE_TTL_MS } from '../config';
import { fingerprint } from '../crypto';
import { authErrors } from '../errors';
import { enforceHit } from '../http';
import { background } from '../signin';
import { emailSchema, findUserByEmail } from '../users';
import { isUniqueClash } from '../workspace-store';
import { actorFrom, auditBy, freshFrom, selfFrom } from './actor';

export interface PendingEmailChange {
  /** The address waiting to be confirmed. */
  email: string;
  /** When the code stops working, ms. */
  expiresAt: number;
}

interface PendingRow {
  id: string;
  email: string;
  expires_at: number;
}

const pendingFor = (c: Context<AppEnv>, userId: string, now: number) =>
  c.env.DB.prepare(
    `SELECT id, email, expires_at FROM auth_codes
      WHERE purpose = 'email-change' AND ref = ?1 AND used_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(userId, now)
    .first<PendingRow>();

/** The change this person started and has not finished, or null. */
export async function pendingEmailChange(c: Context<AppEnv>, now = Date.now()): Promise<PendingEmailChange | null> {
  const actor = await actorFrom(c);
  const row = await pendingFor(c, actor.id, now);
  return row ? { email: row.email, expiresAt: row.expires_at } : null;
}

/**
 * Start changing your email: a 6-digit code goes to the new address. Needs a recent sign-in.
 * Starting again replaces the change that was waiting.
 */
export async function startEmailChange(c: Context<AppEnv>, input: { email: string }, now = Date.now()): Promise<PendingEmailChange> {
  const actor = await freshFrom(c);
  const { email } = parse(z.object({ email: emailSchema }), { email: input.email });
  if (email === actor.email) throw authErrors.email_same();
  await enforceHit(c.env, 'emailChangePerUser', actor.id);
  await enforceHit(c.env, 'emailChangePerAddress', await fingerprint(c.env.AUTH_SECRET, email));

  const taken = !!(await findUserByEmail(c.env, email));
  // Older codes stop working but stay on record, so their wrong guesses still count.
  await c.env.DB.prepare(`UPDATE auth_codes SET used_at = ?2 WHERE purpose = 'email-change' AND ref = ?1 AND used_at IS NULL`).bind(actor.id, now).run();
  const issued = await issueCode(c.env, { purpose: 'email-change', email, ref: actor.id, deliverable: !taken, ip: actor.ip, userAgent: c.req.header('user-agent'), now });
  if (!taken) {
    await background(
      c,
      renderEmail(c.env, { template: 'email-change', data: { code: issued.code, minutes: CODE_TTL_MS / 60_000 } }).then((mail) =>
        sendEmail(c.env, { to: email, template: 'email-change', tag: 'auth', ...mail }),
      ),
    );
  }
  return { email, expiresAt: issued.expiresAt };
}

/** Drop a change that is waiting for its code. */
export async function cancelEmailChange(c: Context<AppEnv>, now = Date.now()): Promise<void> {
  const actor = await selfFrom(c);
  await c.env.DB.prepare(`UPDATE auth_codes SET used_at = ?2 WHERE purpose = 'email-change' AND ref = ?1 AND used_at IS NULL`).bind(actor.id, now).run();
}

/**
 * Finish the change with the code from the new address. Every other device is signed out, and
 * the old address is told, so a change the person did not make does not go unnoticed.
 */
export async function confirmEmailChange(c: Context<AppEnv>, input: { code: string }, now = Date.now()): Promise<{ email: string }> {
  const actor = await selfFrom(c);
  await enforceHit(c.env, 'checkPerIp', actor.ip);
  const pending = await pendingFor(c, actor.id, now);
  if (!pending) throw authErrors.code_expired();

  const result = await redeemCode(c.env, { id: pending.id, purpose: 'email-change', code: typeof input.code === 'string' ? input.code : '', now });
  if (!result.ok) {
    if (result.reason === 'wrong') throw authErrors.code_wrong();
    if (result.reason === 'limited') throw authErrors.code_limited();
    throw result.reason === 'used' ? authErrors.code_used() : authErrors.code_expired();
  }

  try {
    // The old address is part of the statement, so two changes finishing at once cannot both apply.
    const done = await c.env.DB.prepare('UPDATE "user" SET "email" = ?1, "emailVerified" = 1, "updatedAt" = ?2 WHERE "id" = ?3 AND "email" = ?4')
      .bind(result.email, new Date(now).toISOString(), actor.id, actor.email)
      .run();
    if (done.meta.changes !== 1) throw authErrors.code_expired();
  } catch (err) {
    // Someone made an account with this address after the code was sent.
    if (isUniqueClash(err)) throw authErrors.email_taken();
    throw err;
  }

  await c.env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?1 AND "id" <> ?2').bind(actor.id, actor.sessionId).run();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'user.email_changed',
    targetType: 'user',
    targetId: actor.id,
    summary: `Changed their email from ${actor.email} to ${result.email}`,
    meta: { from: actor.email, to: result.email },
  });
  await background(
    c,
    renderEmail(c.env, {
      template: 'notification',
      data: {
        title: 'Your email address was changed',
        body: `Your account now signs in with ${result.email}. This address no longer works for it. If you did not make this change, tell the person who runs this Toolshed.`,
      },
    }).then((mail) => sendEmail(c.env, { to: actor.email, template: 'notification', tag: 'auth', ...mail })),
  );
  return { email: result.email };
}
