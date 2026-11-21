/**
 * Audit log: who did what. Call `audit()` after every change a workspace admin would want to trace
 * (sign-ins, invites, role changes, key creation, deletes, settings changes, impersonation).
 */
import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { csvRow } from './csv';
import { newId, parseJson } from './db';
import { errors } from './errors';
import { registerCoreSchedule } from './jobs';
import { getSetting, INSTANCE, setSetting } from './settings';

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

// ---------------------------------------------------------------------------------------------
// Reading, exporting and retention. Writing stays append-only: the database refuses edits, and
// refuses deletes except the nightly cleanup below (see migration 0004).
// ---------------------------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  orgId: string | null;
  actorId: string | null;
  actorType: string;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  /** When it happened (ms). */
  at: number;
}

export interface AuditQuery {
  /** Only this workspace. Leave out to read the whole install: only the instance owner may do that. */
  orgId?: string | null;
  actorId?: string;
  action?: string;
  targetType?: string;
  /** Text to look for in the summary, the actor's name, the action and the target id. */
  q?: string;
  /** Inclusive bounds, ms. */
  from?: number;
  to?: number;
}

interface AuditRow {
  id: string;
  org_id: string | null;
  actor_id: string | null;
  actor_type: string;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string | null;
  meta: string | null;
  ip: string | null;
  created_at: number;
}

function encodeCursor(row: { created_at: number; id: string }): string {
  return btoa(`${row.created_at}:${row.id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { at: number; id: string } {
  try {
    const raw = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const colon = raw.indexOf(':');
    const at = Number(raw.slice(0, colon));
    const id = raw.slice(colon + 1);
    if (Number.isFinite(at) && id) return { at, id };
  } catch {
    // fall through
  }
  throw errors.bad_request('That page marker isn’t valid. Reload the list.');
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function where(query: AuditQuery, cursor?: { at: number; id: string }): { sql: string; params: (string | number | null)[] } {
  const parts: string[] = [];
  const params: (string | number | null)[] = [];
  const add = (sql: string, ...values: (string | number | null)[]) => {
    let i = params.length;
    parts.push(sql.replace(/\?/g, () => `?${++i}`));
    params.push(...values);
  };
  if (query.orgId) add('org_id = ?', query.orgId);
  if (query.actorId) add('actor_id = ?', query.actorId);
  if (query.action) add('action = ?', query.action);
  if (query.targetType) add('target_type = ?', query.targetType);
  if (query.from !== undefined) add('created_at >= ?', query.from);
  if (query.to !== undefined) add('created_at <= ?', query.to);
  const q = query.q?.trim();
  if (q) {
    const like = `%${likeEscape(q.slice(0, 100))}%`;
    add(`(summary LIKE ? ESCAPE '\\' OR actor_label LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')`, like, like, like, like);
  }
  if (cursor) add('(created_at < ? OR (created_at = ? AND id < ?))', cursor.at, cursor.at, cursor.id);
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

function record(r: AuditRow): AuditRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    actorId: r.actor_id,
    actorType: r.actor_type,
    actorLabel: r.actor_label,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    meta: parseJson<Record<string, unknown> | null>(r.meta, null),
    ip: r.ip,
    at: r.created_at,
  };
}

/**
 * Entries newest first. `before` is the `nextCursor` of the previous page, so a page never shifts
 * when new entries arrive. `nextCursor` is null on the last page.
 */
export async function listAudit(
  env: Env,
  opts: AuditQuery & { before?: string; limit?: number },
): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const w = where(opts, opts.before ? decodeCursor(opts.before) : undefined);
  const { results } = await env.DB.prepare(
    `SELECT id, org_id, actor_id, actor_type, actor_label, action, target_type, target_id, summary, meta, ip, created_at
     FROM audit_log ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
  )
    .bind(...w.params)
    .all<AuditRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(record), nextCursor: results.length > limit && last ? encodeCursor(last) : null };
}

/** The choices for the filter menus: every action and every person that appears in the log. */
export async function auditFilters(
  env: Env,
  orgId?: string | null,
): Promise<{ actions: string[]; actors: { id: string; label: string }[] }> {
  const org = orgId ?? null;
  const [actions, actors] = await Promise.all([
    env.DB.prepare('SELECT DISTINCT action FROM audit_log WHERE (?1 IS NULL OR org_id = ?1) ORDER BY action LIMIT 500')
      .bind(org)
      .all<{ action: string }>(),
    env.DB.prepare(
      `SELECT actor_id AS id, MAX(actor_label) AS label FROM audit_log
       WHERE actor_id IS NOT NULL AND (?1 IS NULL OR org_id = ?1) GROUP BY actor_id ORDER BY label LIMIT 500`,
    )
      .bind(org)
      .all<{ id: string; label: string | null }>(),
  ]);
  return {
    actions: actions.results.map((r) => r.action),
    actors: actors.results.map((r) => ({ id: r.id, label: r.label ?? r.id })),
  };
}

/** Most rows an export holds, so one click cannot read the whole database. */
export const AUDIT_EXPORT_LIMIT = 10_000;

/** The log as CSV (newest first, up to 10,000 rows), for the Export CSV button. */
export async function exportAuditCsv(env: Env, query: AuditQuery = {}): Promise<string> {
  const lines = [
    csvRow(['When (UTC)', 'Workspace', 'Who', 'Kind', 'Action', 'What happened', 'Target type', 'Target', 'IP address']),
  ];
  let before: string | undefined;
  for (let count = 0; count < AUDIT_EXPORT_LIMIT; ) {
    const page = await listAudit(env, { ...query, ...(before ? { before } : {}), limit: Math.min(1000, AUDIT_EXPORT_LIMIT - count) });
    for (const r of page.items) {
      lines.push(csvRow([new Date(r.at).toISOString(), r.orgId, r.actorLabel ?? r.actorId, r.actorType, r.action, r.summary, r.targetType, r.targetId, r.ip]));
    }
    count += page.items.length;
    if (!page.nextCursor) break;
    before = page.nextCursor;
  }
  return `${lines.join('')}`;
}

export const AUDIT_RETENTION_CHOICES = [30, 90, 180, 365, 'forever'] as const;
export type AuditRetention = (typeof AUDIT_RETENTION_CHOICES)[number];
const DEFAULT_RETENTION: AuditRetention = 90;

export async function getAuditRetention(env: Env): Promise<AuditRetention> {
  const value = await getSetting<unknown>(env, INSTANCE, 'audit.retention', DEFAULT_RETENTION);
  return (AUDIT_RETENTION_CHOICES as readonly unknown[]).includes(value) ? (value as AuditRetention) : DEFAULT_RETENTION;
}

/** Owner-only choice (the caller checks that). Takes effect at the next nightly cleanup. */
export async function setAuditRetention(env: Env, days: unknown, actor?: { id?: string | null; email?: string | null }): Promise<AuditRetention> {
  if (!(AUDIT_RETENTION_CHOICES as readonly unknown[]).includes(days)) {
    throw errors.validation_failed(undefined, { retention: 'Choose 30 days, 90 days, 180 days, 1 year or forever.' });
  }
  await setSetting(env, INSTANCE, 'audit.retention', days);
  await audit(env, {
    orgId: null,
    actorId: actor?.id ?? null,
    actorLabel: actor?.email ?? null,
    action: 'audit.retention_changed',
    summary: days === 'forever' ? 'Chose to keep the audit log forever' : `Chose to keep the audit log for ${days} days`,
  });
  return days as AuditRetention;
}

const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 20;

/**
 * Delete entries older than the retention choice, in batches so one run stays small. Returns how many
 * went. The gate row opens deletion for rows older than the cutoff only, inside one atomic batch.
 */
export async function purgeOldAudit(env: Env, now = Date.now()): Promise<number> {
  const retention = await getAuditRetention(env);
  if (retention === 'forever') return 0;
  const cutoff = now - retention * 86_400_000;
  let deleted = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const [, del] = await env.DB.batch([
      env.DB.prepare('UPDATE audit_guard SET purge_before = ?1 WHERE id = 1').bind(cutoff),
      env.DB.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)').bind(cutoff, PURGE_BATCH),
      env.DB.prepare('UPDATE audit_guard SET purge_before = 0 WHERE id = 1'),
    ]);
    const n = del?.meta.changes ?? 0;
    deleted += n;
    if (n < PURGE_BATCH) break;
  }
  return deleted;
}

registerCoreSchedule({ name: 'audit-retention', every: 'day', run: async (env, at) => void (await purgeOldAudit(env, at.getTime())) });
