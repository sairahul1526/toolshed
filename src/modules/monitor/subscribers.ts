/** Status page subscribers: double opt-in by email, and the notification job that tells them about incidents and maintenance. */
import { newId, randomToken } from '../../core/db';
import { emailStatus, sendEmail } from '../../core/email';
import { renderEmail } from '../../core/email-templates';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { enqueue, once } from '../../core/jobs';
import type { Env } from '../../env';
import { monitorErrors } from './errors';
import { baseUrl } from './outbound';
import type { Ctx } from './monitors';
import { type ComponentRow, type IncidentRow, type IncidentUpdateRow, type PageRow, type SubscriberRow, ids, subscribeSchema } from './schema';

export const MAX_SUBSCRIBERS = 5000;
const BATCH = 6;

export interface SubscriberView {
  id: string;
  email: string;
  status: SubscriberRow['status'];
  componentIds: string[];
  createdAt: number;
  confirmedAt: number | null;
}

export const subscriberView = (s: SubscriberRow): SubscriberView => ({
  id: s.id,
  email: s.email,
  status: s.status,
  componentIds: ids(s.component_ids),
  createdAt: s.created_at,
  confirmedAt: s.confirmed_at,
});

export async function listSubscribers(ctx: Ctx, pageId: string, limit = 500): Promise<SubscriberRow[]> {
  return ctx.db.all<SubscriberRow>(`SELECT * FROM mon_subscribers WHERE org_id = :org AND page_id = ? ORDER BY created_at DESC LIMIT ${Math.min(limit, 5000)}`, pageId);
}

export async function removeSubscriber(ctx: Ctx, id: string): Promise<void> {
  if (!(await ctx.db.get('mon_subscribers', id))) throw errors.not_found('We couldn’t find that subscriber.');
  await ctx.db.remove('mon_subscribers', id);
}

export async function subscriberCounts(ctx: Ctx, pageId: string): Promise<{ confirmed: number; pending: number }> {
  const rows = await ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM mon_subscribers WHERE org_id = :org AND page_id = ? GROUP BY status', pageId);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { confirmed: by.confirmed ?? 0, pending: by.pending ?? 0 };
}

async function sendMail(env: Env, orgId: string, to: string, template: string, title: string, body: string, link?: string, linkLabel?: string): Promise<void> {
  const mail = await renderEmail(env, { template: 'notification', data: { title, body, link, linkLabel }, orgId });
  await sendEmail(env, { orgId, to, subject: mail.subject, html: mail.html, text: mail.text, template, tag: 'monitor' });
}

type PageLite = Pick<PageRow, 'id' | 'org_id' | 'slug' | 'title' | 'allow_subscribe' | 'published'>;

/**
 * Start a subscription. Whatever the state of the address, the caller sees the same result,
 * so nobody can use the form to find out who is subscribed.
 */
export async function subscribe(env: Env, page: PageLite, raw: unknown, base: string, at = Date.now()): Promise<void> {
  if (page.published !== 1 || page.allow_subscribe !== 1) throw errors.not_found('This page doesn’t take subscribers.');
  if ((await emailStatus(env)).status !== 'ready') throw monitorErrors.email_not_ready();
  const input = parse(subscribeSchema, raw);
  const orgId = page.org_id;
  const valid = new Set((await env.DB.prepare('SELECT id FROM mon_components WHERE org_id = ?1 AND page_id = ?2').bind(orgId, page.id).all<{ id: string }>()).results.map((r) => r.id));
  const cids = (input.componentIds ?? []).filter((c) => valid.has(c));
  const existing = await env.DB.prepare('SELECT * FROM mon_subscribers WHERE page_id = ?1 AND email = ?2').bind(page.id, input.email).first<SubscriberRow>();
  if (existing && existing.status === 'confirmed') return;
  if (!existing) {
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mon_subscribers WHERE page_id = ?1`).bind(page.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_SUBSCRIBERS) throw monitorErrors.limit_reached('This page has reached its subscriber limit.');
  }
  const token = randomToken(24);
  if (existing) {
    await env.DB.prepare(`UPDATE mon_subscribers SET status = 'pending', token = ?2, component_ids = ?3, created_at = ?4 WHERE id = ?1`).bind(existing.id, token, JSON.stringify(cids), at).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO mon_subscribers (id, org_id, page_id, email, status, token, component_ids, created_at, confirmed_at, sample) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, NULL, 0)`,
    )
      .bind(newId('sub', at), orgId, page.id, input.email, token, JSON.stringify(cids), at)
      .run();
  }
  await sendMail(
    env,
    orgId,
    input.email,
    'monitor-confirm',
    `Confirm your subscription to ${page.title}`,
    `Confirm that you want an email when ${page.title} has an incident or planned maintenance. If you didn’t ask for this, ignore this message and nothing will be sent.`,
    `${base}/status/${page.slug}/confirm/${token}`,
    'Confirm subscription',
  );
}

export async function confirmSubscriber(env: Env, token: string, at = Date.now()): Promise<{ page: { slug: string; title: string } } | null> {
  const s = await env.DB.prepare('SELECT * FROM mon_subscribers WHERE token = ?1').bind(token).first<SubscriberRow>();
  if (!s || s.status === 'unsubscribed') return null;
  if (s.status === 'pending') {
    await env.DB.prepare(`UPDATE mon_subscribers SET status = 'confirmed', confirmed_at = ?2 WHERE id = ?1`).bind(s.id, at).run();
    await emit(env, { orgId: s.org_id, module: 'monitor', name: 'subscriber.added', subject: s.id, at });
  }
  const page = await env.DB.prepare('SELECT slug, title FROM mon_pages WHERE id = ?1').bind(s.page_id).first<{ slug: string; title: string }>();
  return page ? { page } : null;
}

export async function unsubscribeByToken(env: Env, token: string): Promise<{ page: { slug: string; title: string } } | null> {
  const s = await env.DB.prepare('SELECT * FROM mon_subscribers WHERE token = ?1').bind(token).first<SubscriberRow>();
  if (!s) return null;
  await env.DB.prepare(`UPDATE mon_subscribers SET status = 'unsubscribed' WHERE id = ?1`).bind(s.id).run();
  const page = await env.DB.prepare('SELECT slug, title FROM mon_pages WHERE id = ?1').bind(s.page_id).first<{ slug: string; title: string }>();
  return page ? { page } : null;
}

/* ------------------------------------------------------------------ notifications */

export interface NotifyPayload {
  orgId: string;
  kind: 'incident' | 'maintenance_started' | 'maintenance_ended';
  incidentId?: string;
  updateId?: string;
  maintenanceId?: string;
  title?: string;
  body?: string | null;
  until?: number | null;
  monitorIds?: string[];
}

interface BatchPayload {
  orgId: string;
  key: string;
  pageId: string;
  subject: string;
  text: string;
  subscriberIds: string[];
}

/** Job `monitor.notify`: work out who should hear about this, then queue them in small batches. */
export async function notifyJob(env: Env, payload: unknown): Promise<void> {
  const p = payload as NotifyPayload;
  const pages = (await env.DB.prepare(`SELECT * FROM mon_pages WHERE org_id = ?1 AND published = 1 AND allow_subscribe = 1`).bind(p.orgId).all<PageRow>()).results;
  if (pages.length === 0) return;
  if ((await emailStatus(env)).status !== 'ready') return;

  let subject = '';
  let text = '';
  let affectedComponents: (comps: ComponentRow[]) => string[] = () => [];
  let tag = '';

  if (p.kind === 'incident' && p.incidentId) {
    const inc = await env.DB.prepare('SELECT * FROM mon_incidents WHERE org_id = ?1 AND id = ?2').bind(p.orgId, p.incidentId).first<IncidentRow>();
    const up = p.updateId ? await env.DB.prepare('SELECT * FROM mon_incident_updates WHERE id = ?1').bind(p.updateId).first<IncidentUpdateRow>() : null;
    if (!inc) return;
    subject = `${inc.status === 'resolved' ? 'Resolved' : cap(inc.status)}: ${inc.title}`;
    text = `${up?.body ?? inc.title}\n\nStatus: ${cap(inc.status)}`;
    tag = `inc:${inc.id}:${p.updateId ?? ''}`;
    const cids = ids(inc.component_ids);
    affectedComponents = () => cids;
  } else if (p.kind === 'maintenance_started' || p.kind === 'maintenance_ended') {
    const mids = p.monitorIds ?? [];
    subject = p.kind === 'maintenance_started' ? `Maintenance started: ${p.title}` : `Maintenance finished: ${p.title}`;
    text = `${p.body ?? p.title ?? ''}${p.until && p.kind === 'maintenance_started' ? `\n\nExpected to finish by ${new Date(p.until).toUTCString()}.` : ''}`;
    tag = `mnt:${p.maintenanceId}:${p.kind}:${p.until ?? ''}`;
    affectedComponents = (comps) => (mids.length ? comps.filter((c) => c.monitor_id && mids.includes(c.monitor_id)).map((c) => c.id) : []);
  } else return;

  for (const page of pages) {
    const comps = (await env.DB.prepare('SELECT * FROM mon_components WHERE org_id = ?1 AND page_id = ?2').bind(p.orgId, page.id).all<ComponentRow>()).results;
    const onPage = new Set(comps.map((c) => c.id));
    const affected = affectedComponents(comps);
    const relevant = affected.length === 0 || affected.some((c) => onPage.has(c));
    if (!relevant) continue;
    const subs = (await env.DB.prepare(`SELECT id, component_ids FROM mon_subscribers WHERE page_id = ?1 AND status = 'confirmed'`).bind(page.id).all<{ id: string; component_ids: string | null }>()).results;
    const wanted = subs.filter((s) => {
      const filter = ids(s.component_ids);
      return filter.length === 0 || affected.length === 0 || filter.some((c) => affected.includes(c));
    });
    for (let i = 0; i < wanted.length; i += BATCH) {
      const batch: BatchPayload = { orgId: p.orgId, key: `${tag}:${page.id}:${i / BATCH}`, pageId: page.id, subject: `[${page.title}] ${subject}`, text, subscriberIds: wanted.slice(i, i + BATCH).map((s) => s.id) };
      await enqueue(env, 'monitor.notify_batch', batch);
    }
  }
}

/** Job `monitor.notify_batch`: send one small batch of subscriber emails. */
export async function notifyBatchJob(env: Env, payload: unknown): Promise<void> {
  const b = payload as BatchPayload;
  await once(env, `mon:nb:${b.key}`, 86_400, async () => {
    const page = await env.DB.prepare('SELECT slug, title FROM mon_pages WHERE id = ?1').bind(b.pageId).first<{ slug: string; title: string }>();
    if (!page) return;
    const qs = b.subscriberIds.map(() => '?').join(',');
    const subs = (await env.DB.prepare(`SELECT * FROM mon_subscribers WHERE status = 'confirmed' AND id IN (${qs})`).bind(...b.subscriberIds).all<SubscriberRow>()).results;
    const base = baseUrl(env);
    for (const s of subs) {
      const unsub = `${base}/status/${page.slug}/unsubscribe/${s.token}`;
      try {
        await sendMail(env, b.orgId, s.email, 'monitor-update', b.subject, `${b.text}\n\nYou get this because you subscribed to ${page.title}. Unsubscribe: ${unsub}`, `${base}/status/${page.slug}`, 'View status page');
      } catch (err) {
        console.error('[monitor] subscriber email failed', err);
      }
    }
  });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
