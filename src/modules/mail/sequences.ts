/**
 * The welcome sequence: up to 10 emails that go out after someone confirms, each a set time after
 * the one before. One sequence per newsletter. Timing is explicit: every function takes `now`.
 *
 * A person is enrolled once (a unique row), so confirming twice or re-subscribing never restarts it.
 * Leaving the newsletter, or being suppressed, stops the remaining steps.
 */
import { z } from 'zod';
import { newId } from '../../core/db';
import { resolveBrand } from '../../core/email-templates/brand';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import type { Env } from '../../env';
import { composeMessage } from './emails';
import { mailErrors } from './errors';
import { getList } from './lists';
import { linkBase, getMailSettings } from './settings';
import { coreSender, type Sender } from './sender';
import { isSuppressed } from './suppression';
import { ctxOf, type Ctx, type List, type Subscriber } from './types';

export const MAX_STEPS = 10;
export const SEQUENCE_BATCH = 4;
export const CLAIM_LEASE_MS = 5 * 60_000;
export const CAPPED_BACKOFF_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;

export interface Sequence {
  id: string;
  org_id: string;
  list_id: string;
  name: string;
  status: 'draft' | 'active';
  created_at: number;
  updated_at: number;
}

export interface Step {
  id: string;
  org_id: string;
  sequence_id: string;
  position: number;
  delay_minutes: number;
  subject: string;
  preheader: string;
  body: string;
}

export const stepInput = z.object({
  delay_minutes: z.number().int().min(0).max(60 * 24 * 365),
  subject: z.string().trim().min(1, 'Add a subject.').max(200),
  preheader: z.string().trim().max(200).default(''),
  body: z.string().min(1, 'Write something in this email.').max(100_000),
});

export const sequenceInput = z.object({
  status: z.enum(['draft', 'active']).optional(),
  steps: z.array(stepInput).max(MAX_STEPS, `A sequence can have up to ${MAX_STEPS} emails.`).optional(),
});

export interface SequenceView {
  sequence: Sequence | null;
  steps: Step[];
}

export async function getSequence(ctx: Ctx, listId: string): Promise<SequenceView> {
  const sequence = await ctx.db.findOne<Sequence>('mail_sequences', { list_id: listId });
  if (!sequence) return { sequence: null, steps: [] };
  const steps = await ctx.db.all<Step>('SELECT * FROM mail_sequence_steps WHERE org_id = :org AND sequence_id = ? ORDER BY position', sequence.id);
  return { sequence, steps };
}

/** Replace the steps and/or switch the sequence on or off. Steps are saved as a whole so positions stay 1..n. */
export async function saveSequence(ctx: Ctx, listId: string, raw: unknown, now = Date.now()): Promise<SequenceView> {
  const input = parse(sequenceInput, raw);
  const list = await getList(ctx, listId);
  let { sequence } = await getSequence(ctx, listId);
  if (!sequence) {
    sequence = await ctx.db.insert<Sequence>('mail_sequences', { id: newId('msq', now), list_id: listId, name: `${list.name} welcome`, status: 'draft', created_at: now, updated_at: now });
  }
  const d1 = ctx.db.d1;
  if (input.steps) {
    const ops = [d1.prepare('DELETE FROM mail_sequence_steps WHERE org_id = ?1 AND sequence_id = ?2').bind(ctx.org.id, sequence.id)];
    input.steps.forEach((s, i) => {
      ops.push(
        d1
          .prepare('INSERT INTO mail_sequence_steps (id, org_id, sequence_id, position, delay_minutes, subject, preheader, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)')
          .bind(newId('mss', now + i), ctx.org.id, sequence!.id, i + 1, s.delay_minutes, s.subject, s.preheader, s.body, now),
      );
    });
    await d1.batch(ops);
  }
  const status = input.status ?? sequence.status;
  if (status === 'active') {
    const count = input.steps ? input.steps.length : (await getSequence(ctx, listId)).steps.length;
    if (count === 0) throw errors.validation_failed('Add at least one email before turning the sequence on.', { steps: 'Add an email.' });
  }
  await ctx.db.update('mail_sequences', sequence.id, { status, updated_at: now });
  return getSequence(ctx, listId);
}

/** Put a newly confirmed person at the start of the list's sequence. A no-op when there is none, or it is off. */
export async function enrollSubscriber(ctx: Ctx, listId: string, subscriberId: string, now = Date.now()): Promise<boolean> {
  const row = await ctx.db.first<{ id: string; delay: number | null }>(
    `SELECT q.id AS id, (SELECT delay_minutes FROM mail_sequence_steps WHERE sequence_id = q.id AND position = 1) AS delay
     FROM mail_sequences q WHERE q.org_id = :org AND q.list_id = ? AND q.status = 'active'`,
    listId,
  );
  if (!row || row.delay === null) return false;
  const { changes } = await ctx.db.run(
    `INSERT OR IGNORE INTO mail_enrollments (id, org_id, sequence_id, subscriber_id, next_position, next_at, status, enrolled_at)
     VALUES (?, :org, ?, ?, 1, ?, 'active', ?)`,
    newId('men', now),
    row.id,
    subscriberId,
    now + row.delay * 60_000,
    now,
  );
  return changes > 0;
}

interface Due {
  id: string;
  org_id: string;
  sequence_id: string;
  subscriber_id: string;
  next_position: number;
  attempts: number;
}

export interface SequenceRun {
  claimed: number;
  sent: number;
  completed: number;
  stopped: boolean;
}

/**
 * Send the welcome emails that are due. Runs every minute. It sends a handful at a time (the free plan
 * allows about 50 outside calls per run) and leaves the rest for the next minute.
 */
export async function runSequences(env: Env, now = Date.now(), deps: { sender?: Sender; limit?: number } = {}): Promise<SequenceRun> {
  const sender = deps.sender ?? coreSender(env);
  const limit = deps.limit ?? SEQUENCE_BATCH;
  const claimed = await env.DB.prepare(
    `UPDATE mail_enrollments SET claimed_at = ?1
     WHERE id IN (SELECT id FROM mail_enrollments WHERE status = 'active' AND next_at <= ?1 AND (claimed_at IS NULL OR claimed_at < ?2) ORDER BY next_at LIMIT ?3)
     RETURNING id, org_id, sequence_id, subscriber_id, next_position, attempts`,
  )
    .bind(now, now - CLAIM_LEASE_MS, limit)
    .all<Due>();
  const run: SequenceRun = { claimed: claimed.results.length, sent: 0, completed: 0, stopped: false };
  for (const due of claimed.results) {
    if (run.stopped) {
      await env.DB.prepare('UPDATE mail_enrollments SET claimed_at = NULL WHERE id = ?1').bind(due.id).run();
      continue;
    }
    const outcome = await sendStep(env, sender, due, now);
    if (outcome === 'sent') run.sent++;
    if (outcome === 'completed') {
      run.sent++;
      run.completed++;
    }
    if (outcome === 'stop') run.stopped = true;
  }
  return run;
}

type StepOutcome = 'sent' | 'completed' | 'skipped' | 'stop';

async function sendStep(env: Env, sender: Sender, due: Due, now: number): Promise<StepOutcome> {
  const ctx = ctxOf(env, due.org_id);
  const finish = async (status: 'cancelled' | 'failed') => {
    await env.DB.prepare('UPDATE mail_enrollments SET status = ?2, claimed_at = NULL WHERE id = ?1').bind(due.id, status).run();
    return 'skipped' as const;
  };
  const [seq, step, nextStep, sub] = await Promise.all([
    ctx.db.get<Sequence>('mail_sequences', due.sequence_id),
    ctx.db.first<Step>('SELECT * FROM mail_sequence_steps WHERE org_id = :org AND sequence_id = ? AND position = ?', due.sequence_id, due.next_position),
    ctx.db.first<{ position: number; delay_minutes: number }>('SELECT position, delay_minutes FROM mail_sequence_steps WHERE org_id = :org AND sequence_id = ? AND position = ?', due.sequence_id, due.next_position + 1),
    ctx.db.get<Subscriber>('mail_subscribers', due.subscriber_id),
  ]);
  if (!seq || !sub) return finish('cancelled');
  if (seq.status !== 'active') {
    // Switched off: wait, don't lose the place. Look again in an hour.
    await env.DB.prepare('UPDATE mail_enrollments SET claimed_at = NULL, next_at = ?2 WHERE id = ?1').bind(due.id, now + 3_600_000).run();
    return 'skipped';
  }
  if (!step) return finish('cancelled');
  const [member, suppressed, list] = await Promise.all([
    ctx.db.first<{ status: string }>('SELECT status FROM mail_memberships WHERE org_id = :org AND list_id = ? AND subscriber_id = ?', seq.list_id, sub.id),
    isSuppressed(ctx, sub.email, seq.list_id),
    ctx.db.get<List>('mail_lists', seq.list_id),
  ]);
  if (!list || member?.status !== 'active' || suppressed) return finish('cancelled');

  const [brand, settings, base] = await Promise.all([resolveBrand(env, due.org_id), getMailSettings(env, due.org_id), linkBase(env, due.org_id)]);
  const message = await composeMessage({
    env,
    list,
    sub,
    content: { format: 'markdown', subject: step.subject, preheader: step.preheader, body: step.body },
    kind: 'mail.sequence',
    scope: `seq:${step.id}`,
    base,
    brand,
    postalAddress: settings.postalAddress,
  });
  // A crash between sending and saving must not send this step twice.
  const already = await sender.alreadySent(due.org_id, sub.email, message.template);
  const result = already ? ({ ok: true, dev: false } as const) : await sender.send(message);
  if (!result.ok) {
    if (result.kind === 'capped') {
      await env.DB.prepare('UPDATE mail_enrollments SET claimed_at = NULL, next_at = ?2 WHERE id = ?1').bind(due.id, now + CAPPED_BACKOFF_MS).run();
      return 'stop';
    }
    if (result.kind === 'not_configured') {
      await env.DB.prepare('UPDATE mail_enrollments SET claimed_at = NULL, next_at = ?2 WHERE id = ?1').bind(due.id, now + 3_600_000).run();
      return 'stop';
    }
    if (result.kind === 'suppressed') return finish('cancelled');
    if (due.attempts + 1 >= MAX_ATTEMPTS) return finish('failed');
    await env.DB.prepare('UPDATE mail_enrollments SET claimed_at = NULL, attempts = attempts + 1, next_at = ?2 WHERE id = ?1').bind(due.id, now + 15 * 60_000).run();
    return 'skipped';
  }
  if (nextStep) {
    await env.DB.prepare('UPDATE mail_enrollments SET claimed_at = NULL, attempts = 0, next_position = ?2, next_at = ?3 WHERE id = ?1')
      .bind(due.id, nextStep.position, now + nextStep.delay_minutes * 60_000)
      .run();
    return 'sent';
  }
  await env.DB.prepare("UPDATE mail_enrollments SET claimed_at = NULL, status = 'completed', completed_at = ?2, next_position = next_position + 1 WHERE id = ?1").bind(due.id, now).run();
  await emit(env, { orgId: due.org_id, module: 'mail', name: 'sequence.completed', subject: sub.id, data: { email: sub.email, list: list.slug }, at: now });
  return 'completed';
}

export const sequenceStats = (ctx: Ctx, sequenceId: string) =>
  ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM mail_enrollments WHERE org_id = :org AND sequence_id = ? GROUP BY status', sequenceId);

export { mailErrors };
