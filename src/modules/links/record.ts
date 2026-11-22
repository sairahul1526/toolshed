/**
 * Recording a visit. A person's click costs two row writes in one batch: one raw row (for the
 * breakdowns) and one upsert on the day's total. A bot only bumps the bot counter, one write.
 */
import { clientIp, geo, isBot, parseUserAgent, visitorId } from '../../core/net';
import { emit } from '../../core/events';
import type { Env } from '../../env';
import { dayOf } from './days';

export type VisitKind = 'click' | 'view' | 'block';

export interface Visit {
  orgId: string;
  targetId: string;
  /** The short code or bio slug, for the `link.clicked` event. */
  code: string;
  kind: VisitKind;
  blockId?: string | null;
  at: number;
  bot: boolean;
  visitor: string;
  country: string;
  city: string;
  device: string;
  browser: string;
  os: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  qr: boolean;
}

const clip = (s: string | null | undefined, n = 100): string => (s ?? '').trim().slice(0, n);

/** The website a visit came from, as a bare host. Empty when direct or when it came from this site. */
export function referrerHost(header: string | null, ownHost: string): string {
  if (!header) return '';
  try {
    const host = new URL(header).hostname.toLowerCase().replace(/^www\./, '');
    return host === ownHost.replace(/^www\./, '') ? '' : host.slice(0, 100);
  } catch {
    return '';
  }
}

/** Build a Visit from a request. Reads no storage except the daily visitor-id salt (cached per isolate). */
export async function visitFromRequest(
  env: Env,
  req: Request,
  info: { orgId: string; targetId: string; code: string; kind: VisitKind; blockId?: string | null; qr?: boolean; now?: number },
): Promise<Visit> {
  const now = info.now ?? Date.now();
  const ua = req.headers.get('user-agent');
  const bot = isBot(ua);
  const url = new URL(req.url);
  const parsed = parseUserAgent(ua);
  const where = geo(req);
  return {
    orgId: info.orgId,
    targetId: info.targetId,
    code: info.code,
    kind: info.kind,
    blockId: info.blockId ?? null,
    at: now,
    bot,
    visitor: bot ? '' : await visitorId(env, info.targetId, req, now),
    country: clip(where.country, 2).toUpperCase(),
    city: clip(where.city, 80),
    device: bot ? '' : parsed.device,
    browser: bot ? '' : parsed.browser,
    os: bot ? '' : parsed.os,
    referrer: referrerHost(req.headers.get('referer'), url.hostname),
    utmSource: clip(url.searchParams.get('utm_source')),
    utmMedium: clip(url.searchParams.get('utm_medium')),
    utmCampaign: clip(url.searchParams.get('utm_campaign')),
    qr: !!info.qr,
  };
}

const UPSERT = `INSERT INTO links_daily (org_id, target_id, kind, day, clicks, qr, bots) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  ON CONFLICT (target_id, kind, day) DO UPDATE SET clicks = clicks + excluded.clicks, qr = qr + excluded.qr, bots = bots + excluded.bots
  RETURNING clicks`;

/** True for 1, 10, 100, 1000, ...: the counts at which `link.clicked` is emitted. */
export function isClickThreshold(n: number): boolean {
  return n >= 1 && /^10*$/.test(String(n));
}

/**
 * Write one visit. Returns today's count for the target (humans only).
 * `link.clicked` is emitted only when a link's count for the day reaches 1, 10, 100, 1,000 and so
 * on, so a busy link produces a handful of events a day instead of one per click.
 */
export async function recordVisit(env: Env, v: Visit): Promise<number | null> {
  const day = dayOf(v.at);
  if (v.bot) {
    await env.DB.prepare(UPSERT).bind(v.orgId, v.targetId, v.kind, day, 0, 0, 1).run();
    return null;
  }
  const [, daily] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO links_clicks (org_id, target_id, kind, block_id, at, day, visitor, country, city, device, browser, os, referrer, utm_source, utm_medium, utm_campaign, qr)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    ).bind(v.orgId, v.targetId, v.kind, v.blockId ?? null, v.at, day, v.visitor, v.country, v.city, v.device, v.browser, v.os, v.referrer, v.utmSource, v.utmMedium, v.utmCampaign, v.qr ? 1 : 0),
    env.DB.prepare(UPSERT).bind(v.orgId, v.targetId, v.kind, day, 1, v.qr ? 1 : 0, 0),
  ]);
  const today = (daily?.results?.[0] as { clicks?: number } | undefined)?.clicks ?? null;
  if (v.kind === 'click' && today !== null && isClickThreshold(today)) {
    await emit(env, { orgId: v.orgId, module: 'links', name: 'link.clicked', subject: v.targetId, at: v.at, data: { code: v.code, clicksToday: today } });
  }
  return today;
}

export { clientIp };
