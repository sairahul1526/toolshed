/**
 * In-app notifications: the bell in the top bar.
 *
 * - `notify()` adds one. With a `userId` it is for that person; without one it is for every admin of
 *   the workspace (one row, read state kept per person).
 * - `listNotifications()` gives a person their list and unread count.
 * - Rows older than 60 days are deleted every night.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { newId } from './db';
import { errors, parse } from './errors';
import { registerCoreSchedule } from './jobs';

export const NOTIFICATION_KEEP_DAYS = 60;

export interface NotifyInput {
  orgId: string;
  /** The person it is for. Leave out to tell every admin of the workspace. */
  userId?: string;
  title: string;
  body?: string;
  /** Where clicking goes: a path on this app (`/app/email`) or an https link. */
  href?: string;
  /** For your own grouping, for example `export` or `email`. */
  kind?: string;
  /**
   * Stops repeats: while a notification with this key exists in the workspace, a second `notify` with
   * the same key does nothing. Put the person's id in the key when the same event is for several people.
   * The key is free again when the row is cleaned up after 60 days.
   */
  dedupeKey?: string;
}

const notifySchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1).optional(),
  title: z.string().trim().min(1, 'Add a title.').max(120, 'Keep the title under 120 characters.'),
  body: z.string().trim().max(500, 'Keep the text under 500 characters.').optional(),
  href: z
    .string()
    .trim()
    .max(500)
    .refine((v) => (v.startsWith('/') && !v.startsWith('//') && !/[\r\n\\]/.test(v)) || /^https:\/\/[^\s]+$/.test(v), 'Use a path on this app or an https link.')
    .optional(),
  kind: z.string().trim().min(1).max(40).optional(),
  dedupeKey: z.string().trim().min(1).max(200).optional(),
});

/** Add a notification. Returns `created: false` when the dedupe key was already used. */
export async function notify(env: Env, input: NotifyInput): Promise<{ id: string | null; created: boolean }> {
  const n = parse(notifySchema, input);
  const id = newId('ntf');
  const res = await env.DB.prepare(
    `INSERT INTO notifications (id, org_id, user_id, kind, title, body, href, dedupe_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
  )
    .bind(id, n.orgId, n.userId ?? null, n.kind ?? 'info', n.title, n.body ?? null, n.href ?? null, n.dedupeKey ?? null, Date.now())
    .run();
  const created = (res.meta.changes ?? 0) > 0;
  return { id: created ? id : null, created };
}

export interface NotificationItem {
  id: string;
  title: string;
  body?: string;
  href?: string;
  /** When it was created (ms). */
  at: number;
  read: boolean;
}

export interface NotificationQuery {
  orgId: string;
  userId: string;
  /** Whether this person is an admin of the workspace. Admins also see the ones sent to every admin. Default true. */
  isAdmin?: boolean;
}

const VISIBLE = `n.org_id = ?1 AND (n.user_id = ?2 OR (n.user_id IS NULL AND ?3 = 1))`;
const READ = `(n.created_at <= COALESCE(m.read_all_at, 0) OR r.notification_id IS NOT NULL)`;
const JOINS = `LEFT JOIN notification_marks m ON m.org_id = n.org_id AND m.user_id = ?2
               LEFT JOIN notification_reads r ON r.user_id = ?2 AND r.notification_id = n.id`;

/** A person's notifications, newest first, and how many are unread. */
export async function listNotifications(
  env: Env,
  opts: NotificationQuery & { limit?: number },
): Promise<{ unread: number; items: NotificationItem[] }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100);
  const admin = opts.isAdmin === false ? 0 : 1;
  const [list, count] = await Promise.all([
    env.DB.prepare(
      `SELECT n.id, n.title, n.body, n.href, n.created_at, ${READ} AS is_read
       FROM notifications n ${JOINS} WHERE ${VISIBLE} ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit}`,
    )
      .bind(opts.orgId, opts.userId, admin)
      .all<{ id: string; title: string; body: string | null; href: string | null; created_at: number; is_read: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications n ${JOINS} WHERE ${VISIBLE} AND NOT ${READ}`)
      .bind(opts.orgId, opts.userId, admin)
      .first<{ n: number }>(),
  ]);
  return {
    unread: count?.n ?? 0,
    items: list.results.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.body ? { body: r.body } : {}),
      ...(r.href ? { href: r.href } : {}),
      at: r.created_at,
      read: r.is_read === 1,
    })),
  };
}

/** Mark one notification read for this person. Throws `not_found` if it is not theirs to see. */
export async function markRead(env: Env, q: NotificationQuery & { id: string }): Promise<void> {
  const admin = q.isAdmin === false ? 0 : 1;
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_reads (org_id, user_id, notification_id, read_at)
     SELECT n.org_id, ?2, n.id, ?4 FROM notifications n WHERE n.id = ?5 AND ${VISIBLE}`,
  )
    .bind(q.orgId, q.userId, admin, Date.now(), q.id)
    .run();
  if ((res.meta.changes ?? 0) > 0) return;
  // Nothing inserted: it was already read, or it does not exist for this person.
  const visible = await env.DB.prepare(`SELECT 1 AS x FROM notifications n WHERE n.id = ?4 AND ${VISIBLE}`)
    .bind(q.orgId, q.userId, admin, q.id)
    .first();
  if (!visible) throw errors.not_found('That notification is gone.');
}

/** Mark everything up to now as read for this person. */
export async function markAllRead(env: Env, q: NotificationQuery): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notification_marks (org_id, user_id, read_all_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET read_all_at = excluded.read_all_at`,
  )
    .bind(q.orgId, q.userId, Date.now())
    .run();
}

/** Delete notifications (and read marks) older than `days`. Returns how many notifications went. */
export async function cleanupNotifications(env: Env, now = Date.now(), days = NOTIFICATION_KEEP_DAYS): Promise<number> {
  const cutoff = now - days * 86_400_000;
  const [gone] = await env.DB.batch([
    env.DB.prepare('DELETE FROM notifications WHERE created_at < ?1').bind(cutoff),
    // A read mark is never older than its notification, so these are safe to drop with it.
    env.DB.prepare('DELETE FROM notification_reads WHERE read_at < ?1').bind(cutoff),
  ]);
  return gone?.meta.changes ?? 0;
}

registerCoreSchedule({ name: 'notifications-cleanup', every: 'day', run: async (env, at) => void (await cleanupNotifications(env, at.getTime())) });
