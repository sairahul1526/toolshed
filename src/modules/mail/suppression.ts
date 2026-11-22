/**
 * Who we must not mail. Checked again for every recipient at send time, so a bounce, a complaint
 * or an unsubscribe that lands while a send is running still stops the next batch. A suppression
 * outlives the subscriber row and a re-import: importing an address never lifts it.
 *
 * There is no feedback from the mail provider yet. Bounces and complaints reach this module through
 * `recordBounce` / `recordComplaint` (the API webhook, a bounced-address CSV, or "mark as bounced").
 */
import { newId } from '../../core/db';
import { emit } from '../../core/events';
import { isValidAddress, normaliseAddress } from '../../core/email';
import { mailErrors } from './errors';
import type { Ctx, SuppressionReason } from './types';

export interface SuppressionRow {
  id: string;
  email: string;
  list_id: string;
  reason: SuppressionReason;
  note: string;
  created_at: number;
}

/** Add (or keep) a suppression. `listId` '' means every newsletter in the workspace. Returns whether it is new. */
export async function suppress(
  ctx: Ctx,
  input: { email: string; listId?: string; reason: SuppressionReason; note?: string; now?: number },
): Promise<boolean> {
  const email = normaliseAddress(input.email);
  const { changes } = await ctx.db.run(
    `INSERT INTO mail_suppressions (id, org_id, email, list_id, reason, note, created_at)
     VALUES (?, :org, ?, ?, ?, ?, ?) ON CONFLICT (org_id, email, list_id) DO NOTHING`,
    newId('msp'),
    email,
    input.listId ?? '',
    input.reason,
    (input.note ?? '').slice(0, 200),
    input.now ?? Date.now(),
  );
  return changes > 0;
}

export async function isSuppressed(ctx: Ctx, email: string, listId: string): Promise<SuppressionRow | null> {
  return ctx.db.first<SuppressionRow>(
    "SELECT * FROM mail_suppressions WHERE org_id = :org AND email = ? AND list_id IN ('', ?) LIMIT 1",
    normaliseAddress(email),
    listId,
  );
}

export async function listSuppressions(ctx: Ctx, opts: { reason?: string; q?: string; limit?: number; offset?: number } = {}): Promise<SuppressionRow[]> {
  const where: string[] = ['org_id = :org'];
  const params: (string | number)[] = [];
  if (opts.reason) {
    where.push('reason = ?');
    params.push(opts.reason);
  }
  if (opts.q) {
    where.push("email LIKE ? ESCAPE '\\'");
    params.push(`%${opts.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  }
  return ctx.db.all<SuppressionRow>(
    `SELECT * FROM mail_suppressions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${Math.min(opts.limit ?? 50, 200)} OFFSET ${Math.max(opts.offset ?? 0, 0)}`,
    ...params,
  );
}

export async function countSuppressions(ctx: Ctx): Promise<Record<string, number>> {
  const rows = await ctx.db.all<{ reason: string; n: number }>('SELECT reason, COUNT(*) AS n FROM mail_suppressions WHERE org_id = :org GROUP BY reason');
  return Object.fromEntries(rows.map((r) => [r.reason, r.n]));
}

/** Lift one suppression. Only do this when the person asked to come back. */
export async function removeSuppression(ctx: Ctx, id: string): Promise<boolean> {
  return (await ctx.db.run('DELETE FROM mail_suppressions WHERE org_id = :org AND id = ?', id)).changes > 0;
}

async function record(ctx: Ctx, kind: 'bounced' | 'complaint', email: string, note: string, now: number): Promise<{ newlySuppressed: boolean; subscriberId: string | null }> {
  const address = normaliseAddress(email);
  if (!isValidAddress(address)) throw mailErrors.suppressed('That isn’t a valid email address.');
  const newly = await suppress(ctx, { email: address, reason: kind, note, now });
  const sub = await ctx.db.findOne<{ id: string }>('mail_subscribers', { email: address });
  if (sub) {
    await ctx.db.run(
      "UPDATE mail_memberships SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE org_id = :org AND subscriber_id = ? AND status <> 'unsubscribed'",
      now,
      sub.id,
    );
  }
  if (newly) {
    await emit(ctx.env, {
      orgId: ctx.org.id,
      module: 'mail',
      name: 'subscriber.bounced',
      ...(sub ? { subject: sub.id } : {}),
      data: { email: address, reason: kind },
      at: now,
    });
  }
  return { newlySuppressed: newly, subscriberId: sub?.id ?? null };
}

/** A message to this address could not be delivered (hard bounce). Stops every future send to it. */
export const recordBounce = (ctx: Ctx, email: string, note = '', now = Date.now()) => record(ctx, 'bounced', email, note, now);

/** The person marked a message as spam. Stops every future send to this address. */
export const recordComplaint = (ctx: Ctx, email: string, note = '', now = Date.now()) => record(ctx, 'complaint', email, note, now);

export interface BounceImport {
  added: number;
  already: number;
  invalid: number;
  total: number;
}

export const BOUNCE_IMPORT_MAX = 500;

/**
 * A list of bounced addresses. Written in batches so a few hundred addresses stay inside the
 * free plan's limit of 50 subrequests; the count of new ones is one event, not one per address.
 */
export async function importBounced(ctx: Ctx, addresses: string[], now = Date.now()): Promise<BounceImport> {
  const unique = new Map<string, number>();
  const report: BounceImport = { added: 0, already: 0, invalid: 0, total: addresses.length };
  for (const raw of addresses.slice(0, BOUNCE_IMPORT_MAX)) {
    const address = normaliseAddress(raw);
    if (!isValidAddress(address)) report.invalid++;
    else if (unique.has(address)) report.already++;
    else unique.set(address, 1);
  }
  const emails = [...unique.keys()];
  const stmts: D1PreparedStatement[] = [];
  const d1 = ctx.db.d1;
  for (const email of emails) {
    stmts.push(
      d1
        .prepare("INSERT INTO mail_suppressions (id, org_id, email, list_id, reason, note, created_at) VALUES (?1, ?2, ?3, '', 'bounced', 'Imported from a bounce list', ?4) ON CONFLICT (org_id, email, list_id) DO NOTHING")
        .bind(newId('msp'), ctx.org.id, email, now),
      d1
        .prepare(
          "UPDATE mail_memberships SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?3) WHERE org_id = ?1 AND status <> 'unsubscribed' AND subscriber_id IN (SELECT id FROM mail_subscribers WHERE org_id = ?1 AND email = ?2)",
        )
        .bind(ctx.org.id, email, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) {
    const results = await d1.batch(stmts.slice(i, i + 100));
    results.forEach((r, k) => {
      if ((i + k) % 2 === 0) {
        if ((r.meta.changes ?? 0) > 0) report.added++;
        else report.already++;
      }
    });
  }
  if (report.added > 0) {
    await emit(ctx.env, { orgId: ctx.org.id, module: 'mail', name: 'subscriber.bounced', data: { imported: report.added, reason: 'bounced' }, count: report.added, at: now });
  }
  return report;
}
