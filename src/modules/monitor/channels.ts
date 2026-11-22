/** Alert channels: where a notification goes (email, Slack, Discord, Teams, Telegram or a webhook). */
import { newId, parseJson } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { monitorErrors } from './errors';
import type { Ctx } from './monitors';
import { assertPublicUrl } from './outbound';
import { CHANNEL_KINDS, type ChannelKind, type ChannelRow, channelSchema } from './schema';

const HOSTS: Partial<Record<ChannelKind, { test: (host: string) => boolean; hint: string }>> = {
  slack: { test: (h) => h === 'hooks.slack.com', hint: 'A Slack webhook address starts with https://hooks.slack.com/services/' },
  discord: { test: (h) => h === 'discord.com' || h === 'discordapp.com' || h.endsWith('.discord.com'), hint: 'A Discord webhook address starts with https://discord.com/api/webhooks/' },
  teams: {
    test: (h) => h.endsWith('.webhook.office.com') || h.endsWith('.logic.azure.com') || h.endsWith('.powerplatform.com') || h.endsWith('.office.com'),
    hint: 'Paste the address from the Teams Workflows “Post to a channel when a webhook request is received” template.',
  },
};

export interface ChannelConfig {
  to?: string[];
  url?: string;
  secret?: string;
  botToken?: string;
  chatId?: string;
}

/** Check and tidy the config for a kind. Throws field errors the form can show. */
export function normalizeConfig(kind: ChannelKind, raw: Record<string, unknown>, current?: ChannelConfig): ChannelConfig {
  const fail = (field: string, message: string): never => {
    throw errors.validation_failed(undefined, { [`config.${field}`]: message });
  };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (kind === 'email') {
    const list = (Array.isArray(raw.to) ? raw.to : str(raw.to).split(/[\s,;]+/)).map(str).filter(Boolean);
    if (list.length === 0) fail('to', 'Enter at least one email address.');
    if (list.length > 5) fail('to', 'Use up to 5 addresses. For more people, send to a mailing list address.');
    for (const a of list) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) fail('to', `“${a.slice(0, 40)}” isn’t a valid email address.`);
    return { to: [...new Set(list.map((a) => a.toLowerCase()))] };
  }
  if (kind === 'telegram') {
    const botToken = str(raw.botToken) || current?.botToken || '';
    const chatId = str(raw.chatId);
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) fail('botToken', 'That doesn’t look like a bot token. Get one from @BotFather.');
    if (!/^-?\d{3,}$|^@[A-Za-z0-9_]{4,}$/.test(chatId)) fail('chatId', 'Enter the chat id (a number) or the @name of a public channel.');
    return { botToken, chatId };
  }
  const url = str(raw.url) || current?.url || '';
  if (!url) fail('url', 'Paste the webhook address.');
  let parsed: URL;
  try {
    parsed = assertPublicUrl(url);
  } catch {
    return fail('url', 'That isn’t a public web address.');
  }
  if (parsed.protocol !== 'https:') fail('url', 'The address must start with https://');
  const rule = HOSTS[kind];
  if (rule && !rule.test(parsed.hostname)) fail('url', rule.hint);
  const out: ChannelConfig = { url: parsed.toString() };
  if (kind === 'webhook') {
    const secret = raw.secret === undefined ? current?.secret : str(raw.secret);
    if (secret) out.secret = secret.slice(0, 100);
  }
  return out;
}

/** What a client may see: secrets are hidden. */
export function channelView(c: ChannelRow) {
  const cfg = parseJson<ChannelConfig>(c.config, {});
  const hide = (s: string | undefined) => (s ? `${s.slice(0, 8)}…` : undefined);
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    config: {
      ...(cfg.to ? { to: cfg.to } : {}),
      ...(cfg.url ? { url: hide(cfg.url) } : {}),
      ...(cfg.chatId ? { chatId: cfg.chatId } : {}),
      ...(cfg.botToken ? { botToken: hide(cfg.botToken) } : {}),
      ...(cfg.secret ? { secretSet: true } : {}),
    },
    enabled: c.enabled === 1,
    notifyRecovery: c.notify_recovery === 1,
    notifySlow: c.notify_slow === 1,
    repeatMin: c.repeat_min,
    quietFrom: c.quiet_from,
    quietTo: c.quiet_to,
    createdAt: c.created_at,
  };
}

export async function createChannel(ctx: Ctx, raw: unknown, at = Date.now()): Promise<ChannelRow> {
  const input = parse(channelSchema, raw);
  if ((await ctx.db.count('mon_channels')) >= 50) throw monitorErrors.limit_reached('A workspace can have up to 50 alert channels.');
  const config = normalizeConfig(input.kind, input.config);
  checkQuiet(input.quietFrom, input.quietTo);
  return ctx.db.insert<ChannelRow>('mon_channels', {
    id: newId('chn', at),
    name: input.name,
    kind: input.kind,
    config: JSON.stringify(config),
    enabled: input.enabled === false ? 0 : 1,
    notify_recovery: input.notifyRecovery === false ? 0 : 1,
    notify_slow: input.notifySlow ? 1 : 0,
    repeat_min: input.repeatMin ?? 0,
    quiet_from: input.quietFrom ?? null,
    quiet_to: input.quietTo ?? null,
    created_at: at,
    updated_at: at,
  });
}

function checkQuiet(from: string | undefined, to: string | undefined): void {
  if ((from && !to) || (!from && to)) throw errors.validation_failed(undefined, { quietFrom: 'Set both the start and the end of quiet hours, or neither.' });
}

export async function updateChannel(ctx: Ctx, id: string, raw: Record<string, unknown>, at = Date.now()): Promise<ChannelRow> {
  const cur = await getChannel(ctx, id);
  const curCfg = parseJson<ChannelConfig>(cur.config, {});
  const merged = {
    name: cur.name,
    kind: cur.kind,
    enabled: cur.enabled === 1,
    notifyRecovery: cur.notify_recovery === 1,
    notifySlow: cur.notify_slow === 1,
    repeatMin: cur.repeat_min,
    quietFrom: cur.quiet_from ?? undefined,
    quietTo: cur.quiet_to ?? undefined,
    config: {},
    ...raw,
  };
  const input = parse(channelSchema, { ...merged, kind: cur.kind });
  const hasConfig = raw.config && Object.keys(raw.config as object).length > 0;
  const config = hasConfig ? normalizeConfig(cur.kind, raw.config as Record<string, unknown>, curCfg) : curCfg;
  checkQuiet(input.quietFrom, input.quietTo);
  return (await ctx.db.update<ChannelRow>('mon_channels', id, {
    name: input.name,
    config: JSON.stringify(config),
    enabled: input.enabled === false ? 0 : 1,
    notify_recovery: input.notifyRecovery === false ? 0 : 1,
    notify_slow: input.notifySlow ? 1 : 0,
    repeat_min: input.repeatMin ?? 0,
    quiet_from: input.quietFrom ?? null,
    quiet_to: input.quietTo ?? null,
    updated_at: at,
  }))!;
}

export async function getChannel(ctx: Ctx, id: string): Promise<ChannelRow> {
  const row = await ctx.db.get<ChannelRow>('mon_channels', id);
  if (!row) throw errors.not_found('We couldn’t find that alert channel.');
  return row;
}

export async function listChannels(ctx: Ctx): Promise<ChannelRow[]> {
  return ctx.db.list<ChannelRow>('mon_channels', { orderBy: 'created_at', limit: 100 });
}

export async function deleteChannel(ctx: Ctx, id: string): Promise<void> {
  await getChannel(ctx, id);
  // Monitors that listed this channel by id keep working: an unknown id is ignored when alerts go out.
  await ctx.db.remove('mon_channels', id);
}

export { CHANNEL_KINDS };
