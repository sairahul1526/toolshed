/**
 * Direct reads of invitations. An invite's id is only an address for its page: it never signs
 * anyone in. Proof is always a code sent to the invited inbox.
 */
import { randomToken } from '../core/db';
import type { Env } from '../env';

export interface InviteRow {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  /** pending | accepted | canceled */
  status: string;
  expiresAt: string;
  createdAt: string;
  inviterId: string;
  workspaceName: string;
  workspaceSlug: string;
  workspaceCreatedAt: string;
  inviterName: string;
}

const ID = /^inv_[A-Za-z0-9_-]{24}$/;

/** Long and random, because the page behind it shows a workspace name to whoever opens it. */
export function newInviteId(): string {
  return `inv_${randomToken(18)}`;
}

export const INVITE_COLUMNS = `i."id" AS id, i."organizationId" AS organizationId, i."email" AS email, i."role" AS role, i."status" AS status,
       i."expiresAt" AS expiresAt, i."createdAt" AS createdAt, i."inviterId" AS inviterId,
       o."name" AS workspaceName, o."slug" AS workspaceSlug, o."createdAt" AS workspaceCreatedAt, u."name" AS inviterName`;
export const INVITE_JOINS = `"invitation" i JOIN "organization" o ON o."id" = i."organizationId" JOIN "user" u ON u."id" = i."inviterId"`;

/**
 * An invite only works while whoever sent it may still invite with that role. Needs the
 * invitation aliased as `i`.
 */
export const SENDER_MAY = `EXISTS (SELECT 1 FROM "member" s WHERE s."organizationId" = i."organizationId" AND s."userId" = i."inviterId"
                         AND (s."role" = 'owner' OR (s."role" = 'admin' AND i."role" <> 'owner')))`;

export async function findInvite(env: Env, id: string): Promise<InviteRow | null> {
  if (!ID.test(id)) return null;
  return env.DB.prepare(`SELECT ${INVITE_COLUMNS} FROM ${INVITE_JOINS} WHERE i."id" = ?1`).bind(id).first<InviteRow>();
}

export function inviteExpired(row: Pick<InviteRow, 'expiresAt'>, now = Date.now()): boolean {
  return !(Date.parse(row.expiresAt) > now);
}

/** Invites an address can still accept, newest first. */
export async function openInvitesFor(env: Env, email: string, now = Date.now()): Promise<InviteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${INVITE_COLUMNS} FROM ${INVITE_JOINS}
      WHERE i."email" = ?1 AND i."status" = 'pending' AND i."expiresAt" > ?2 AND ${SENDER_MAY} ORDER BY i."createdAt" DESC LIMIT 20`,
  )
    .bind(email.toLowerCase(), new Date(now).toISOString())
    .all<InviteRow>();
  return results;
}

/** True when the address has an invite it can still accept. */
export async function hasOpenInvite(env: Env, email: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS yes FROM "invitation" i WHERE i."email" = ?1 AND i."status" = 'pending' AND i."expiresAt" > ?2 AND ${SENDER_MAY} LIMIT 1`)
    .bind(email.toLowerCase(), new Date(now).toISOString())
    .first<{ yes: number }>();
  return !!row;
}
