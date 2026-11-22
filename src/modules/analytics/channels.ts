/**
 * Where a visit came from: a readable source name and one of a few channels. AI assistants get
 * their own channel, because "someone asked a chatbot and it sent them here" is neither search
 * nor a plain referral.
 */

export const CHANNELS = ['Direct', 'Search', 'Paid search', 'Social', 'Paid social', 'Email', 'AI assistants', 'Referral', 'Campaign'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Host suffix, source name. Checked in order, so `gemini.google.com` is listed before `google.`. */
const AI: [string, string][] = [
  ['chatgpt.com', 'ChatGPT'],
  ['chat.openai.com', 'ChatGPT'],
  ['claude.ai', 'Claude'],
  ['perplexity.ai', 'Perplexity'],
  ['gemini.google.com', 'Gemini'],
  ['bard.google.com', 'Gemini'],
  ['copilot.microsoft.com', 'Copilot'],
  ['copilot.com', 'Copilot'],
  ['chat.deepseek.com', 'DeepSeek'],
  ['grok.com', 'Grok'],
  ['chat.mistral.ai', 'Mistral'],
  ['meta.ai', 'Meta AI'],
  ['you.com', 'You.com'],
  ['phind.com', 'Phind'],
  ['poe.com', 'Poe'],
  ['kagi.com/assistant', 'Kagi Assistant'],
];

const SEARCH: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)search\.yahoo\.[a-z.]+$|(^|\.)yahoo\.[a-z.]+$/, 'Yahoo'],
  [/(^|\.)yandex\.[a-z.]+$|(^|\.)ya\.ru$/, 'Yandex'],
  [/(^|\.)baidu\.com$/, 'Baidu'],
  [/(^|\.)ecosia\.org$/, 'Ecosia'],
  [/(^|\.)search\.brave\.com$/, 'Brave Search'],
  [/(^|\.)startpage\.com$/, 'Startpage'],
  [/(^|\.)kagi\.com$/, 'Kagi'],
  [/(^|\.)qwant\.com$/, 'Qwant'],
  [/(^|\.)naver\.com$/, 'Naver'],
];

const SOCIAL: [RegExp, string][] = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'X'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'LinkedIn'],
  [/(^|\.)(reddit\.com|redd\.it)$/, 'Reddit'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/, 'Pinterest'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'],
  [/(^|\.)bsky\.app$/, 'Bluesky'],
  [/(^|\.)news\.ycombinator\.com$/, 'Hacker News'],
  [/(^|\.)producthunt\.com$/, 'Product Hunt'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'WhatsApp'],
  [/(^|\.)(telegram\.org|t\.me)$/, 'Telegram'],
  [/(^|\.)discord\.com$/, 'Discord'],
  [/(^|\.)mastodon\.[a-z.]+$/, 'Mastodon'],
  [/(^|\.)snapchat\.com$/, 'Snapchat'],
  [/(^|\.)quora\.com$/, 'Quora'],
];

const EMAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|mail\.proton\.me)$/;
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid-search|paid_search|cpm|cpv|display|banner|ads?)$/;
const PAID_SOCIAL_MEDIUM = /^(paidsocial|paid-social|paid_social|social-paid|social_paid)$/;
const SOCIAL_MEDIUM = /^(social|social-network|social-media|sm|social_network|social_media)$/;
const EMAIL_MEDIUM = /^(email|e-mail|e_mail|newsletter|mail)$/;

/** Referrers that exist only to show up in analytics reports. Matched as host suffixes. */
const SPAM = [
  'semalt.com', 'buttons-for-website.com', 'darodar.com', 'best-seo-offer.com', 'best-seo-solution.com', 'social-buttons.com',
  'free-share-buttons.com', 'simple-share-buttons.com', '4webmasters.org', 'trafficmonetize.org', 'floating-share-buttons.com',
  'get-free-traffic-now.com', 'event-tracking.com', 'success-seo.com', 'videos-for-your-business.com', 'rank-checker.online',
  'top1-seo-service.com', 'traffic2cash.xyz', 'ilovevitaly.com', 'hulfingtonpost.com', 'priceg.com', 'o-o-6-o-o.com', 'cenoval.ru',
  'bestwebsitesawards.com', 'guardlink.org', 'seo-platform.com', 'webmonetizer.net', 'website-analyzer.info', 'ranksonic.info',
];

export interface Attribution {
  source: string | null;
  channel: Channel;
  spam: boolean;
}

export interface Utm {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'android-app:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function suffixMatch(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function aiName(host: string): string | null {
  for (const [suffix, name] of AI) if (suffixMatch(host, suffix.split('/')[0]!)) return name;
  return null;
}

function known(host: string, list: [RegExp, string][]): string | null {
  return list.find(([re]) => re.test(host))?.[1] ?? null;
}

/**
 * Work out the source and channel of a visit from its referrer and UTM tags. `siteHosts` are the
 * site's own domains: a referrer from one of them is an internal click and counts as no referrer.
 */
export function attribute(referrer: string | null | undefined, utm: Utm, isOwnHost: (host: string) => boolean): Attribution {
  const host = hostOf(referrer);
  const external = host && !isOwnHost(host) ? host : null;
  const spam = !!external && SPAM.some((s) => suffixMatch(external, s));
  const tag = utm.source?.trim().toLowerCase() || null;
  const medium = utm.medium?.trim().toLowerCase() || '';

  // A tag such as utm_source=chatgpt.com names a host; treat it like a referrer from that host.
  const tagHost = tag && tag.includes('.') ? tag.replace(/^www\./, '') : null;
  const lookup = external ?? tagHost;
  const ai = lookup ? aiName(lookup) : tag ? (AI.find(([, name]) => name.toLowerCase() === tag)?.[1] ?? null) : null;
  const search = lookup ? known(lookup, SEARCH) : null;
  const social = lookup ? known(lookup, SOCIAL) : null;
  const source = ai ?? search ?? social ?? (tag ? utm.source!.trim() : external);

  let channel: Channel;
  if (ai) channel = 'AI assistants';
  else if (PAID_SOCIAL_MEDIUM.test(medium) || (PAID_MEDIUM.test(medium) && social)) channel = 'Paid social';
  else if (PAID_MEDIUM.test(medium)) channel = 'Paid search';
  else if (EMAIL_MEDIUM.test(medium) || (lookup && EMAIL_HOSTS.test(lookup))) channel = 'Email';
  else if (search) channel = 'Search';
  else if (social || SOCIAL_MEDIUM.test(medium)) channel = 'Social';
  else if (tag || utm.campaign) channel = 'Campaign';
  else if (external) channel = 'Referral';
  else channel = 'Direct';

  return { source: source ?? null, channel, spam };
}
