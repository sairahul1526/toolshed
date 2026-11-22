/**
 * Invites: the only way a new person gets an account. An invite names an email address and a
 * role. Its link opens a page; it never signs anyone in. To join, the person proves they own
 * the invited inbox with a sign-in code, then accepts while signed in as that address.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { newId } from '../../core/db';
import { sendEmail, type EmailStatus } from '../../core/email';
import { renderEmail } from '../../core/email-templates';
import { parse } from '../../core/errors';
import type { AppEnv, Role } from '../../env';
import { baseUrl } from '../auth';
import { INVITE_TTL_MS } from '../config';
import { authErrors } from '../errors';
import { enforceHit } from '../http';
import { findInvite, INVITE_COLUMNS, INVITE_JOINS, inviteExpired, newInviteId, SENDER_MAY, type InviteRow } from '../invites';
import { emailSchema } from '../users';
import { auditBy, selfFrom, workspaceActor, type WorkspaceActor } from './actor';
import { assertMayAssign, isRole, parseRole, ROLE_NAMES } from './roles';
import type { Workspace } from './workspaces';

export interface Invite {
  id: string;
  email: string;
  role: Role;
  /** `expired` invites stay listed so they can be sent again or cancelled. */
  status: 'pending' | 'expired';
  invitedBy: { id: string; name: string };
  /** ms */
  createdAt: number;
  /** ms */
  expiresAt: number;
  /** The page the invited person opens. Safe to copy: it only works for the invited address. */
  link: string;
}

/** An invite together with what happened to its email (`sent`, `dev`, `not_configured`, `failed` and so on). */
export interface SentInvite extends Invite {
  emailStatus: EmailStatus;
}

const DAYS = Math.round(INVITE_TTL_MS / 86_400_000);

function toInvite(c: Context<AppEnv>, row: InviteRow, role: Role, now: number): Invite {
  return {
    id: row.id,
    email: row.email,
    role,
    status: inviteExpired(row, now) ? 'expired' : 'pending',
    invitedBy: { id: row.inviterId, name: row.inviterName },
    createdAt: Date.parse(row.createdAt),
    expiresAt: Date.parse(row.expiresAt),
    link: `${baseUrl(c.env, c.req.url)}/invite/${row.id}`,
  };
}

/** Invites of the active workspace that nobody has accepted or cancelled, newest first. Admins and owners only. */
export async function listInvites(c: Context<AppEnv>, now = Date.now()): Promise<Invite[]> {
  const actor = await workspaceActor(c, 'admin');
  const { results } = await c.env.DB.prepare(
    `SELECT ${INVITE_COLUMNS} FROM ${INVITE_JOINS} WHERE i."organizationId" = ?1 AND i."status" = 'pending' ORDER BY i."createdAt" DESC, i."id" LIMIT 200`,
  )
    .bind(actor.orgId)
    .all<InviteRow>();
  return results.flatMap((row) => (isRole(row.role) ? [toInvite(c, row, row.role, now)] : []));
}

async function deliver(c: Context<AppEnv>, actor: WorkspaceActor, invite: Invite): Promise<EmailStatus> {
  const mail = await renderEmail(c.env, {
    template: 'invite',
    orgId: actor.orgId,
    data: { inviterName: actor.name, workspaceName: actor.orgName, role: ROLE_NAMES[invite.role], link: invite.link, days: DAYS },
  });
  return (await sendEmail(c.env, { orgId: actor.orgId, to: invite.email, template: 'invite', tag: 'auth', ...mail })).status;
}

/** A pending invite of the actor's workspace that the actor may manage, or `invite_not_found`. */
async function ownInvite(c: Context<AppEnv>, actor: WorkspaceActor, id: string): Promise<{ row: InviteRow; role: Role }> {
  const row = await findInvite(c.env, typeof id === 'string' ? id : '');
  // An invite of another workspace does not exist, as far as this person can tell.
  if (!row || row.organizationId !== actor.orgId || row.status !== 'pending' || !isRole(row.role)) throw authErrors.invite_not_found();
  assertMayAssign(actor.role, null, row.role);
  return { row, role: row.role };
}

/**
 * Invite an address to the active workspace with a role, and email the invite. Admins and owners
 * only; only an owner can invite an owner. Inviting an address again replaces its older invite.
 */
export async function inviteMember(c: Context<AppEnv>, input: { email: string; role: string }): Promise<SentInvite> {
  const actor = await workspaceActor(c, 'admin');
  const { email } = parse(z.object({ email: emailSchema }), { email: input.email });
  const role = parseRole(input.role);
  assertMayAssign(actor.role, null, role);
  await enforceHit(c.env, 'invitePerUser', actor.id);

  const now = Date.now();
  const iso = new Date(now).toISOString();
  const id = newInviteId();
  const expires = new Date(now + INVITE_TTL_MS).toISOString();
  const isMember = `EXISTS (SELECT 1 FROM "member" m JOIN "user" u ON u."id" = m."userId" WHERE m."organizationId" = ?1 AND u."email" = ?2)`;
  const openInvite = `EXISTS (SELECT 1 FROM "invitation" p WHERE p."organizationId" = ?1 AND p."email" = ?2 AND p."status" = 'pending')`;
  // The asker's role is checked again inside both statements, so a role lost a moment ago cannot invite.
  const stillMay = `EXISTS (SELECT 1 FROM "member" a WHERE a."organizationId" = ?1 AND a."userId" = ?3 AND a."role" = ?4)`;
  const results = await c.env.DB.batch([
    // The older invite for this address goes, unless it is an owner invite and the asker is not an owner.
    c.env.DB.prepare(
      `UPDATE "invitation" SET "status" = 'canceled'
        WHERE "organizationId" = ?1 AND "email" = ?2 AND "status" = 'pending' AND (?4 = 'owner' OR "role" <> 'owner') AND NOT ${isMember} AND ${stillMay}`,
    ).bind(actor.orgId, email, actor.id, actor.role),
    c.env.DB.prepare(
      `INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId")
       SELECT ?5, ?1, ?2, ?6, 'pending', ?7, ?8, ?3 WHERE NOT ${isMember} AND NOT ${openInvite} AND ${stillMay}`,
    ).bind(actor.orgId, email, actor.id, actor.role, id, role, expires, iso),
  ]);
  if (results[1]?.meta.changes !== 1) {
    const why = await c.env.DB.prepare(`SELECT ${isMember} AS member, ${openInvite} AS open`).bind(actor.orgId, email).first<{ member: number; open: number }>();
    if (why?.member) throw authErrors.already_member();
    throw why?.open ? authErrors.role_over_owner() : authErrors.role_needed();
  }

  const invite: Invite = {
    id,
    email,
    role,
    status: 'pending',
    invitedBy: { id: actor.id, name: actor.name },
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    link: `${baseUrl(c.env, c.req.url)}/invite/${id}`,
  };
  const emailStatus = await deliver(c, actor, invite);
  await auditBy(c.env, actor, {
    orgId: actor.orgId,
    action: 'invite.sent',
    targetType: 'invite',
    targetId: id,
    summary: `Invited ${email} as ${ROLE_NAMES[role]}`,
    meta: { email, role, emailStatus },
  });
  return { ...invite, emailStatus };
}

/** Email an invite again and give it a fresh 7 days. Works on an expired invite too. */
export async function resendInvite(c: Context<AppEnv>, id: string): Promise<SentInvite> {
  const actor = await workspaceActor(c, 'admin');
  const { row, role } = await ownInvite(c, actor, id);
  await enforceHit(c.env, 'invitePerUser', actor.id);

  const now = Date.now();
  const expires = new Date(now + INVITE_TTL_MS).toISOString();
  // The sender becomes the person who sent it again: an invite only works while its sender may still invite.
  const done = await c.env.DB.prepare(
    `UPDATE "invitation" SET "expiresAt" = ?3, "inviterId" = ?4
      WHERE "id" = ?1 AND "organizationId" = ?2 AND "status" = 'pending'
        AND EXISTS (SELECT 1 FROM "member" a WHERE a."organizationId" = ?2 AND a."userId" = ?4 AND a."role" = ?5)`,
  )
    .bind(row.id, actor.orgId, expires, actor.id, actor.role)
    .run();
  if (done.meta.changes !== 1) throw authErrors.invite_not_found();

  const invite = toInvite(c, { ...row, expiresAt: expires, inviterId: actor.id, inviterName: actor.name }, role, now);
  const emailStatus = await deliver(c, actor, invite);
  await auditBy(c.env, actor, {
    orgId: actor.orgId,
    action: 'invite.resent',
    targetType: 'invite',
    targetId: row.id,
    summary: `Sent the invite for ${row.email} again`,
    meta: { email: row.email, role, emailStatus },
  });
  return { ...invite, emailStatus };
}

/** Cancel an invite. Its link stops working at once. */
export async function cancelInvite(c: Context<AppEnv>, id: string): Promise<void> {
  const actor = await workspaceActor(c, 'admin');
  const { row, role } = await ownInvite(c, actor, id);
  const done = await c.env.DB.prepare(
    `UPDATE "invitation" SET "status" = 'canceled'
      WHERE "id" = ?1 AND "organizationId" = ?2 AND "status" = 'pending'
        AND EXISTS (SELECT 1 FROM "member" a WHERE a."organizationId" = ?2 AND a."userId" = ?3 AND a."role" = ?4)`,
  )
    .bind(row.id, actor.orgId, actor.id, actor.role)
    .run();
  if (done.meta.changes !== 1) throw authErrors.invite_not_found();
  await auditBy(c.env, actor, {
    orgId: actor.orgId,
    action: 'invite.cancelled',
    targetType: 'invite',
    targetId: row.id,
    summary: `Cancelled the invite for ${row.email}`,
    meta: { email: row.email, role },
  });
}

/**
 * Join the workspace an invite is for, and make it the active one. The signed-in person must be
 * the invited address, the invite must be pending and in date, and whoever sent it must still be
 * allowed to invite with that role. All of that is checked again inside the statements that make
 * the change, so an invite cancelled a moment ago cannot be used.
 */
export async function acceptInvite(c: Context<AppEnv>, id: string, now = Date.now()): Promise<Workspace> {
  const actor = await selfFrom(c);
  const row = await findInvite(c.env, typeof id === 'string' ? id : '');
  if (!row || row.status !== 'pending' || !isRole(row.role)) throw authErrors.invite_not_found();
  if (inviteExpired(row, now)) throw authErrors.invite_expired();
  if (row.email.toLowerCase() !== actor.email.toLowerCase()) throw authErrors.invite_wrong_account();

  const iso = new Date(now).toISOString();
  const joined = `EXISTS (SELECT 1 FROM "member" m WHERE m."organizationId" = ?2 AND m."userId" = ?3)`;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
       SELECT ?4, i."organizationId", ?3, i."role", ?5 FROM "invitation" i
        WHERE i."id" = ?1 AND i."organizationId" = ?2 AND i."status" = 'pending' AND i."expiresAt" > ?5 AND lower(i."email") = ?6
          AND i."role" IN ('owner', 'admin', 'member', 'viewer')
          AND ${SENDER_MAY}
       ON CONFLICT ("organizationId", "userId") DO NOTHING`,
    ).bind(row.id, row.organizationId, actor.id, newId('mem', now), iso, actor.email.toLowerCase()),
    c.env.DB.prepare(`UPDATE "invitation" SET "status" = 'accepted' WHERE "id" = ?1 AND "organizationId" = ?2 AND "status" = 'pending' AND "expiresAt" > ?4 AND ${joined}`).bind(
      row.id,
      row.organizationId,
      actor.id,
      iso,
    ),
    c.env.DB.prepare(`UPDATE "session" SET "activeOrganizationId" = ?2 WHERE "id" = ?1 AND "userId" = ?3 AND ${joined}`).bind(actor.sessionId, row.organizationId, actor.id),
  ]);
  // Nothing was accepted: the invite was cancelled or used a moment ago, or its sender can no longer invite.
  if (results[1]?.meta.changes !== 1) throw authErrors.invite_not_found();

  const member = await c.env.DB.prepare(`SELECT "role" FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2`).bind(row.organizationId, actor.id).first<{ role: string }>();
  const role = member && isRole(member.role) ? member.role : row.role;
  await auditBy(c.env, actor, {
    orgId: row.organizationId,
    action: 'invite.accepted',
    targetType: 'invite',
    targetId: row.id,
    summary: `${actor.email} joined as ${ROLE_NAMES[role]}`,
    meta: { role, invitedBy: row.inviterId },
  });
  return { id: row.organizationId, name: row.workspaceName, slug: row.workspaceSlug, role, createdAt: Date.parse(row.workspaceCreatedAt) };
}
