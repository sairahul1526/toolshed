/** Sending alerts: build the message, deliver it to a channel, log what happened, remind while down. */
import { newId, parseJson } from '../../core/db';
import { emailStatus, sendEmail } from '../../core/email';
import { renderEmail } from '../../core/email-templates';
import { AppError } from '../../core/errors';
import { enqueue, once } from '../../core/jobs';
import { moduleContext } from '../../core/registry';
import type { Env } from '../../env';
import type { ChannelConfig } from './channels';
import { fmtDuration, fmtUtc } from './fmt';
import { monitorErrors } from './errors';
import { safeFetch } from './outbound';
import { type ChannelRow, type MonitorRow, ids } from './schema';
import { MINUTE, inQuietHours } from './time';
import { workspaceZone } from './maintenance';

export type AlertKind = 'down' | 'up' | 'slow' | 'repeat' | 'test';

export interface AlertInfo {
  kind: AlertKind;
  monitor: { id: string; name: string; type: string; url: string | null };
  at: number;
  error?: string | null;
  code?: number | null;
  ms?: number | null;
  slowMs?: number | null;
  /** When it went down, for durations. */
  since?: number | null;
  incidentId?: string | null;
}

export interface Message {
  title: string;
  body: string;
  link?: string;
}

export function appLink(env: { APP_URL?: string }, path: string): string | undefined {
  return env.APP_URL ? `${env.APP_URL.replace(/\/+$/, '')}${path}` : undefined;
}

export function buildMessage(env: { APP_URL?: string }, info: AlertInfo, channelName = ''): Message {
  const m = info.monitor;
  const target = m.url ?? m.name;
  const down = info.since ? fmtDuration(info.at - info.since) : '';
  const link = appLink(env, `/app/monitor/${m.id}`);
  switch (info.kind) {
    case 'down':
      return { title: `${m.name} is down`, body: `${target} failed its check: ${info.error ?? 'no response'}. Down since ${fmtUtc(info.since ?? info.at)}.`, link };
    case 'up':
      return { title: `${m.name} is back up`, body: `${target} is responding again${down ? ` after ${down}` : ''}.`, link };
    case 'slow':
      return { title: `${m.name} is slow`, body: `${target} answered in ${info.ms} ms, over your limit of ${info.slowMs} ms.`, link };
    case 'repeat':
      return { title: `${m.name} is still down`, body: `${target} has been down for ${down || 'a while'}. Last error: ${info.error ?? 'no response'}.`, link };
    default:
      return { title: 'Test alert from Toolshed', body: `If you can read this, the channel “${channelName}” works.`, link };
  }
}

interface Delivery {
  ok: boolean;
  detail: string;
  /** Worth trying again later. */
  retry: boolean;
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function post(url: string, payload: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Delivery> {
  try {
    const res = await safeFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(payload), timeoutMs: 8000, followRedirects: false });
    if (res.status >= 200 && res.status < 300) return { ok: true, detail: `Delivered (${res.status})`, retry: false };
    return { ok: false, detail: `The service answered ${res.status}`, retry: res.status === 429 || res.status >= 500 };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, detail: err.message, retry: false };
    return { ok: false, detail: 'Could not reach the service', retry: true };
  }
}

/** Send one message to one channel. Never throws. */
export async function deliver(env: Env, orgId: string, channel: ChannelRow, info: AlertInfo): Promise<Delivery> {
  const cfg = parseJson<ChannelConfig>(channel.config, {});
  const msg = buildMessage(env, info, channel.name);
  const line = `${msg.title}\n${msg.body}${msg.link ? `\n${msg.link}` : ''}`;
  switch (channel.kind) {
    case 'email': {
      if ((await emailStatus(env)).status !== 'ready') return { ok: false, detail: 'Email isn’t set up on this install yet', retry: false };
      let failed = 0;
      for (const to of cfg.to ?? []) {
        const mail = await renderEmail(env, { template: 'notification', orgId, data: { title: msg.title, body: msg.body, ...(msg.link ? { link: msg.link, linkLabel: 'Open the monitor' } : {}) } });
        const res = await sendEmail(env, { orgId, to, subject: mail.subject, html: mail.html, text: mail.text, template: 'notification', tag: 'monitor-alert' });
        if (res.status === 'failed' || res.status === 'not_configured' || res.status === 'capped') failed++;
      }
      return failed === 0 ? { ok: true, detail: `Sent to ${cfg.to?.length ?? 0} address${(cfg.to?.length ?? 0) === 1 ? '' : 'es'}`, retry: false } : { ok: false, detail: `${failed} email${failed === 1 ? '' : 's'} could not be sent`, retry: false };
    }
    case 'slack':
      return post(cfg.url ?? '', { text: `*${msg.title}*\n${msg.body}${msg.link ? `\n<${msg.link}|Open in Toolshed>` : ''}` });
    case 'discord':
      return post(cfg.url ?? '', { username: 'Toolshed Monitor', content: `**${msg.title}**\n${msg.body}${msg.link ? `\n${msg.link}` : ''}` });
    case 'teams':
      return post(cfg.url ?? '', {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', wrap: true },
                { type: 'TextBlock', text: msg.body, wrap: true },
              ],
              ...(msg.link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Toolshed', url: msg.link }] } : {}),
            },
          },
        ],
      });
    case 'telegram':
      return post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, { chat_id: cfg.chatId, text: line, disable_web_page_preview: true });
    case 'webhook': {
      const body = JSON.stringify({
        event: info.kind === 'up' ? 'monitor.recovered' : info.kind === 'test' ? 'monitor.test' : `monitor.${info.kind}`,
        at: new Date(info.at).toISOString(),
        monitor: info.monitor,
        status: info.kind === 'up' ? 'up' : info.kind === 'test' ? 'test' : 'down',
        error: info.error ?? null,
        statusCode: info.code ?? null,
        responseMs: info.ms ?? null,
        incidentId: info.incidentId ?? null,
        text: `${msg.title}. ${msg.body}`,
      });
      const headers: Record<string, string> = { 'x-toolshed-event': `monitor.${info.kind}` };
      if (cfg.secret) headers['x-toolshed-signature'] = `sha256=${await hmacHex(cfg.secret, body)}`;
      return post(cfg.url ?? '', null, headers, body);
    }
  }
}

async function log(env: Env, orgId: string, channel: ChannelRow, monitorId: string | null, kind: AlertKind, outcome: 'sent' | 'failed' | 'skipped', detail: string, at: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mon_alerts (id, org_id, monitor_id, channel_id, channel_name, kind, outcome, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(newId('alt', at), orgId, monitorId, channel.id, channel.name, kind, outcome, detail.slice(0, 200), at)
    .run();
}

/** Send a test message right now and say what happened. Throws `monitor.channel_failed` when it did not arrive. */
export async function testChannel(env: Env, orgId: string, channel: ChannelRow, at = Date.now()): Promise<string> {
  const result = await deliver(env, orgId, channel, { kind: 'test', monitor: { id: 'test', name: 'Test monitor', type: 'http', url: 'https://example.com' }, at });
  await log(env, orgId, channel, null, 'test', result.ok ? 'sent' : 'failed', result.detail, at);
  if (!result.ok) throw monitorErrors.channel_failed(`${result.detail}. Check the details and try again.`);
  return result.detail;
}

/** Channels a monitor should alert, for one kind of alert. */
export function channelsFor(m: Pick<MonitorRow, 'channel_ids'>, all: ChannelRow[], kind: AlertKind): ChannelRow[] {
  const wanted = m.channel_ids ? new Set(ids(m.channel_ids)) : null;
  return all.filter((c) => {
    if (c.enabled !== 1) return false;
    if (wanted && !wanted.has(c.id)) return false;
    if (kind === 'up' && c.notify_recovery !== 1) return false;
    if (kind === 'slow' && c.notify_slow !== 1) return false;
    return true;
  });
}

export interface AlertPayload {
  orgId: string;
  channelId: string;
  monitorId: string;
  kind: AlertKind;
  at: number;
  error?: string | null;
  code?: number | null;
  ms?: number | null;
  incidentId?: string | null;
}

/** Queue one alert job per channel. */
export async function fanout(env: Env, orgId: string, m: MonitorRow, kind: AlertKind, info: Omit<AlertPayload, 'orgId' | 'channelId' | 'monitorId' | 'kind'>): Promise<number> {
  const { results } = await env.DB.prepare('SELECT * FROM mon_channels WHERE org_id = ?1 AND enabled = 1').bind(orgId).all<ChannelRow>();
  const targets = channelsFor(m, results, kind);
  for (const c of targets) await enqueue(env, 'monitor.alert', { orgId, channelId: c.id, monitorId: m.id, kind, ...info });
  return targets.length;
}

/** Queue job: deliver one alert. Retries on a busy or unreachable service, stops on a refusal. */
export async function alertJob(env: Env, payload: unknown, meta: { attempt: number }): Promise<void> {
  const p = payload as AlertPayload;
  const ctx = await moduleContext(env, p.orgId);
  const channel = await ctx.db.get<ChannelRow>('mon_channels', p.channelId);
  const m = await ctx.db.get<MonitorRow>('mon_monitors', p.monitorId);
  if (!channel || !m || channel.enabled !== 1) return;
  const notified = parseJson<Record<string, number>>(m.notified, {});

  if (p.kind === 'up' && notified[channel.id] === undefined) return; // we never told this channel it was down
  const tz = await workspaceZone(env, p.orgId);
  if (inQuietHours(channel.quiet_from, channel.quiet_to, tz, p.at)) {
    if (p.kind === 'up') await env.DB.prepare(`UPDATE mon_monitors SET notified = json_remove(COALESCE(notified, '{}'), ?2) WHERE id = ?1`).bind(m.id, `$.${channel.id}`).run();
    await log(env, p.orgId, channel, m.id, p.kind, 'skipped', 'Quiet hours', p.at);
    return;
  }

  await once(env, `mon:alert:${m.id}:${channel.id}:${p.kind}:${Math.floor(p.at / MINUTE)}`, 3600, async () => {
    const result = await deliver(env, p.orgId, channel, {
      kind: p.kind,
      monitor: { id: m.id, name: m.name, type: m.type, url: m.url },
      at: p.at,
      error: p.error ?? m.last_error,
      code: p.code ?? m.last_code,
      ms: p.ms,
      slowMs: m.slow_ms,
      since: m.since_at,
      incidentId: p.incidentId,
    });
    await log(env, p.orgId, channel, m.id, p.kind, result.ok ? 'sent' : 'failed', result.detail, p.at);
    if (p.kind === 'up') {
      await env.DB.prepare(`UPDATE mon_monitors SET notified = json_remove(COALESCE(notified, '{}'), ?2) WHERE id = ?1`).bind(m.id, `$.${channel.id}`).run();
    } else if (p.kind === 'down' || p.kind === 'repeat') {
      if (result.ok || !result.retry || meta.attempt >= 3) {
        await env.DB.prepare(`UPDATE mon_monitors SET notified = json_set(COALESCE(notified, '{}'), ?2, ?3) WHERE id = ?1`).bind(m.id, `$.${channel.id}`, p.at).run();
      }
    }
    if (!result.ok && result.retry && meta.attempt < 3) throw new Error(result.detail);
  });
}

/** Once a minute: send the first alert a quiet channel missed, and "still down" reminders. */
export async function remindDown(env: Env, at: number): Promise<void> {
  const { results: downs } = await env.DB.prepare(`SELECT * FROM mon_monitors WHERE status = 'down' AND paused = 0 AND since_at IS NOT NULL AND since_at <= ?1`)
    .bind(at - 2 * MINUTE)
    .all<MonitorRow>();
  if (downs.length === 0) return;
  const byOrg = new Map<string, MonitorRow[]>();
  for (const m of downs) byOrg.set(m.org_id, [...(byOrg.get(m.org_id) ?? []), m]);
  for (const [orgId, list] of byOrg) {
    const { results: channels } = await env.DB.prepare('SELECT * FROM mon_channels WHERE org_id = ?1 AND enabled = 1').bind(orgId).all<ChannelRow>();
    if (channels.length === 0) continue;
    const tz = await workspaceZone(env, orgId);
    for (const m of list) {
      const notified = parseJson<Record<string, number>>(m.notified, {});
      for (const c of channelsFor(m, channels, 'down')) {
        if (inQuietHours(c.quiet_from, c.quiet_to, tz, at)) continue;
        const last = notified[c.id];
        const kind: AlertKind | null = last === undefined ? 'down' : c.repeat_min > 0 && at - last >= c.repeat_min * MINUTE ? 'repeat' : null;
        if (kind) await enqueue(env, 'monitor.alert', { orgId, channelId: c.id, monitorId: m.id, kind, at, error: m.last_error, code: m.last_code, incidentId: m.incident_id });
      }
    }
  }
}
