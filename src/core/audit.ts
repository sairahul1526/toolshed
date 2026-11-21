/**
 * Audit log: who did what. Call `audit()` after every change a workspace admin would want to trace
 * (sign-ins, invites, role changes, key creation, deletes, settings changes, impersonation).
 */
import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { newId } from './db';

export interface AuditEntry {
  /** Workspace it belongs to. Leave out for install-wide actions (shown only to the instance owner). */
  orgId?: string | null;
  actorId?: string | null;
  actorType?: 'user' | 'apikey' | 'system';
  /** Name or email shown in the log, kept so the line still reads after the actor is deleted. */
  actorLabel?: string | null;
  /** `<thing>.<verb>` in the past tense, for example `member.invited`, `link.deleted`. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** One plain sentence for the log, for example "Invited sam@example.com as Member". */
  summary?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, org_id, actor_id, actor_type, actor_label, action, target_type, target_id, summary, meta, ip, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      newId('aud'),
      entry.orgId ?? null,
      entry.actorId ?? null,
      entry.actorType ?? 'user',
      entry.actorLabel ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.summary ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
      entry.ip ?? null,
      Date.now(),
    )
    .run();
}

/** `audit()` with the actor, workspace and IP filled in from the request. */
export function auditFromRequest(
  c: Context<AppEnv>,
  entry: Omit<AuditEntry, 'actorId' | 'actorType' | 'actorLabel' | 'ip' | 'orgId'> & { orgId?: string | null },
): Promise<void> {
  const user = c.get('user');
  const auth = c.get('auth');
  return audit(c.env, {
    orgId: entry.orgId === undefined ? (c.get('org')?.id ?? null) : entry.orgId,
    actorId: user?.id ?? auth.keyId ?? null,
    actorType: auth.kind === 'apikey' ? 'apikey' : 'user',
    actorLabel: user?.email ?? (auth.kind === 'apikey' ? 'API key' : null),
    ip: c.req.header('cf-connecting-ip') ?? null,
    ...entry,
  });
}
