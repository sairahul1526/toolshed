/**
 * The full list. `listNotifications` has no cursor, filter or kind, so the page reads the rows
 * itself with the same visibility rule (this workspace, and addressed to this person or to every
 * admin) and the same read rule (read-all mark or a single mark). Unread counts still come from
 * the core function so the page and the bell never disagree.
 */
import type { Env } from '../../env';
import { listNotifications } from '../../core/notifications';

export const PAGE_SIZE = 25;

export interface Viewer {
  orgId: string;
  userId: string;
  isAdmin: boolean;
}

export interface Row {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  at: number;
  read: boolean;
}

export type Filter = 'all' | 'unread';

const VISIBLE = 'n.org_id = ?1 AND (n.user_id = ?2 OR (n.user_id IS NULL AND ?3 = 1))';
const READ = '(n.created_at <= COALESCE(m.read_all_at, 0) OR r.notification_id IS NOT NULL)';
const JOINS = `LEFT JOIN notification_marks m ON m.org_id = n.org_id AND m.user_id = ?2
               LEFT JOIN notification_reads r ON r.user_id = ?2 AND r.notification_id = n.id`;

/** `<created_at>.<id>`: where the next page starts, in the list's own order (newest first, id breaks ties). */
export function encodeCursor(row: Pick<Row, 'at' | 'id'>): string {
  return `${row.at}.${row.id}`;
}

export function decodeCursor(value: string | undefined): { at: number; id: string } | null {
  const m = /^(\d{1,16})\.([\w-]{1,64})$/.exec(value ?? '');
  return m ? { at: Number(m[1]), id: m[2]! } : null;
}

export async function loadPage(
  env: Env,
  who: Viewer,
  opts: { filter: Filter; cursor: { at: number; id: string } | null },
): Promise<{ rows: Row[]; next: string | null; unread: number }> {
  const binds: (string | number)[] = [who.orgId, who.userId, who.isAdmin ? 1 : 0];
  let where = VISIBLE;
  if (opts.filter === 'unread') where += ` AND NOT ${READ}`;
  if (opts.cursor) {
    where += ' AND (n.created_at < ?4 OR (n.created_at = ?4 AND n.id < ?5))';
    binds.push(opts.cursor.at, opts.cursor.id);
  }
  const [list, bell] = await Promise.all([
    env.DB.prepare(
      `SELECT n.id, n.kind, n.title, n.body, n.href, n.created_at, ${READ} AS is_read
       FROM notifications n ${JOINS} WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ${PAGE_SIZE + 1}`,
    )
      .bind(...binds)
      .all<{ id: string; kind: string; title: string; body: string | null; href: string | null; created_at: number; is_read: number }>(),
    listNotifications(env, { ...who, limit: 1 }),
  ]);
  const rows: Row[] = list.results.slice(0, PAGE_SIZE).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    href: r.href,
    at: r.created_at,
    read: r.is_read === 1,
  }));
  const last = rows[rows.length - 1];
  return { rows, next: list.results.length > PAGE_SIZE && last ? encodeCursor(last) : null, unread: bell.unread };
}

/** The stored link of a notification this person may see, or null. */
export async function storedHref(env: Env, who: Viewer, id: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT n.href FROM notifications n WHERE n.id = ?4 AND ${VISIBLE}`)
    .bind(who.orgId, who.userId, who.isAdmin ? 1 : 0, id)
    .first<{ href: string | null }>();
  return row?.href ?? null;
}
