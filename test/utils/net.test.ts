import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  assertPublicUrl,
  baseUrl,
  clientIp,
  geo,
  isBot,
  isPreviewBot,
  parseUserAgent,
  safeFetch,
  visitorId,
} from '../../src/core/net';
import { AppError, listErrorCodes } from '../../src/core/errors';
import type { AppEnv, Env } from '../../src/env';
import { createTestEnv } from '../helpers/d1';

const DAY = 24 * 3600 * 1000;

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return err instanceof AppError ? err.code : `not an AppError: ${String(err)}`;
  }
  return undefined;
}

describe('error codes', () => {
  it('are registered with plain codes and statuses', () => {
    const codes = new Map(listErrorCodes().map((c) => [c.code, c.status]));
    expect(codes.get('url_not_allowed')).toBe(400);
    for (const code of ['fetch_failed', 'fetch_timeout', 'fetch_too_large', 'too_many_redirects', 'redirect_not_followed']) expect(codes.has(code), code).toBe(true);
  });
});

describe('baseUrl', () => {
  async function run(appUrl: string | undefined, url: string): Promise<string> {
    const app = new Hono<AppEnv>();
    app.get('*', (c) => c.text(baseUrl(c)));
    const res = await app.request(url, {}, { APP_URL: appUrl } as Env);
    return res.text();
  }

  it('uses APP_URL when set, without a trailing slash', async () => {
    expect(await run('https://tools.example.com', 'http://localhost/x')).toBe('https://tools.example.com');
    expect(await run('https://tools.example.com/', 'http://localhost/x')).toBe('https://tools.example.com');
    expect(await run(' https://tools.example.com// ', 'http://localhost/x')).toBe('https://tools.example.com');
  });

  it('falls back to the request origin', async () => {
    expect(await run(undefined, 'https://abc.workers.dev/some/path?q=1')).toBe('https://abc.workers.dev');
    expect(await run('', 'http://127.0.0.1:8787/a')).toBe('http://127.0.0.1:8787');
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => new Request('https://example.com', { headers });

  it('reads CF-Connecting-IP first', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.7');
  });

  it('falls back to the first X-Forwarded-For entry', () => {
    expect(clientIp(req({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' }))).toBe('198.51.100.1');
  });

  it('is null when there is nothing to read', () => {
    expect(clientIp(req({}))).toBeNull();
    expect(clientIp(req({ 'x-forwarded-for': ' ' }))).toBeNull();
  });

  it('reads IPv6', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(req({ 'cf-connecting-ip': '::ffff:203.0.113.7' }))).toBe('::ffff:203.0.113.7');
  });

  it('ignores a value that is not an IP address, so it never reaches a rate-limit key or a log', () => {
    for (const bad of ['unknown', '203.0.113.256', '203.0.113', '203.0.113.7:8080', '203.0.113.7 extra', '[2001:db8::1]', 'fe80::1%eth0', ':::', '1:2:3:4:5:6:7:8:9', '<script>', 'a'.repeat(300)]) {
      expect(clientIp(req({ 'cf-connecting-ip': bad })), bad).toBeNull();
      expect(clientIp(req({ 'x-forwarded-for': bad })), bad).toBeNull();
    }
  });

  it('falls back to a valid X-Forwarded-For entry when CF-Connecting-IP is not an address', () => {
    expect(clientIp(req({ 'cf-connecting-ip': 'garbage', 'x-forwarded-for': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(clientIp(req({ 'cf-connecting-ip': 'garbage', 'x-forwarded-for': 'garbage, 198.51.100.1' }))).toBeNull();
  });
});

describe('geo', () => {
  it('reads request.cf', () => {
    const request = new Request('https://example.com');
    Object.defineProperty(request, 'cf', { value: { country: 'IN', region: 'Karnataka', city: 'Bengaluru', timezone: 'Asia/Kolkata', asn: 1 } });
    expect(geo(request)).toEqual({ country: 'IN', region: 'Karnataka', city: 'Bengaluru', timezone: 'Asia/Kolkata' });
  });

  it('keeps only what is there', () => {
    const request = new Request('https://example.com');
    Object.defineProperty(request, 'cf', { value: { country: 'DE', city: '', region: 5 } });
    expect(geo(request)).toEqual({ country: 'DE' });
  });

  it('never throws when cf is missing', () => {
    expect(geo(new Request('https://example.com'))).toEqual({});
    const request = new Request('https://example.com');
    Object.defineProperty(request, 'cf', { value: null });
    expect(geo(request)).toEqual({});
  });
});

describe('parseUserAgent', () => {
  const cases: [string, string, { device: string; browser: string; os: string }][] = [
    ['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', { device: 'desktop', browser: 'Chrome', os: 'Windows' }],
    ['Safari on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { device: 'desktop', browser: 'Safari', os: 'macOS' }],
    ['Firefox on Linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', { device: 'desktop', browser: 'Firefox', os: 'Linux' }],
    ['Edge on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', { device: 'desktop', browser: 'Edge', os: 'Windows' }],
    ['Opera on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0', { device: 'desktop', browser: 'Opera', os: 'macOS' }],
    ['Chrome on ChromeOS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', { device: 'desktop', browser: 'Chrome', os: 'ChromeOS' }],
    ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', { device: 'mobile', browser: 'Safari', os: 'iOS' }],
    ['Chrome on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1', { device: 'mobile', browser: 'Chrome', os: 'iOS' }],
    ['Firefox on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15', { device: 'mobile', browser: 'Firefox', os: 'iOS' }],
    ['Safari on iPad', 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', { device: 'tablet', browser: 'Safari', os: 'iPadOS' }],
    ['Chrome on Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', { device: 'mobile', browser: 'Chrome', os: 'Android' }],
    ['Chrome on Android tablet', 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', { device: 'tablet', browser: 'Chrome', os: 'Android' }],
    ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', { device: 'mobile', browser: 'Samsung Internet', os: 'Android' }],
    ['Firefox on Android', 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0', { device: 'mobile', browser: 'Firefox', os: 'Android' }],
    ['Instagram on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0.0 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00)', { device: 'mobile', browser: 'Instagram', os: 'iOS' }],
    ['Instagram on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Instagram 330.0.0.0.0 Android', { device: 'mobile', browser: 'Instagram', os: 'Android' }],
    ['Facebook on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.0.0;]', { device: 'mobile', browser: 'Facebook', os: 'Android' }],
    ['Facebook on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.0.0;FBBV/1;FBDV/iPhone14,5]', { device: 'mobile', browser: 'Facebook', os: 'iOS' }],
    ['TikTok on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 trill_340000 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/34.0.0', { device: 'mobile', browser: 'TikTok', os: 'Android' }],
    ['TikTok on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 BytedanceWebview/d8a21c6', { device: 'mobile', browser: 'TikTok', os: 'iOS' }],
    ['LinkedIn on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp/9.30.1234', { device: 'mobile', browser: 'LinkedIn', os: 'iOS' }],
  ];

  for (const [name, ua, want] of cases) {
    it(`reads ${name}`, () => {
      expect(parseUserAgent(ua)).toEqual(want);
    });
  }

  it('says Other for what it does not know', () => {
    expect(parseUserAgent('Mozilla/5.0 (PlayStation 5) Gecko')).toEqual({ device: 'other', browser: 'Other', os: 'Other' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0) SomeNewBrowser/1.0')).toEqual({ device: 'desktop', browser: 'Other', os: 'Windows' });
  });

  it('calls bots and missing user agents bots', () => {
    expect(parseUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').device).toBe('bot');
    expect(parseUserAgent('curl/8.4.0')).toEqual({ device: 'bot', browser: 'Other', os: 'Other' });
    expect(parseUserAgent(null)).toEqual({ device: 'bot', browser: 'Other', os: 'Other' });
    expect(parseUserAgent('')).toEqual({ device: 'bot', browser: 'Other', os: 'Other' });
  });

  it('copes with very long and odd strings', () => {
    expect(parseUserAgent('x'.repeat(100_000)).os).toBe('Other');
    expect(parseUserAgent('\u0000\ud800 😀')).toMatchObject({ browser: 'Other', os: 'Other' });
  });
});

describe('isBot and isPreviewBot', () => {
  const people = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 12; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  ];
  const previewBots = [
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Slackbot 1.0 (+https://api.slack.com/robots)',
    'Twitterbot/1.0',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'WhatsApp/2.23.20.0 A',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'TelegramBot (like TwitterBot)',
  ];
  const otherBots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    'Mozilla/5.0 (compatible; Pingdom.com_bot_version_1.4_(http://www.pingdom.com/))',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Chrome-Lighthouse',
    'curl/8.4.0',
    'Wget/1.21.4',
    'python-requests/2.32.0',
    'Python-urllib/3.12',
    'Go-http-client/2.0',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'axios/1.7.2',
    'PostmanRuntime/7.39.0',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'Mozilla/5.0 (compatible; CCBot/2.0; +http://commoncrawl.org/faq/)',
    'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)',
  ];

  it('lets people through', () => {
    for (const ua of people) {
      expect(isBot(ua), ua).toBe(false);
      expect(isPreviewBot(ua), ua).toBe(false);
    }
  });

  it('spots link-preview fetchers', () => {
    for (const ua of previewBots) {
      expect(isPreviewBot(ua), ua).toBe(true);
      expect(isBot(ua), ua).toBe(true);
    }
  });

  it('spots crawlers, monitors, headless browsers, scripts and AI crawlers, but they are not preview bots', () => {
    for (const ua of otherBots) {
      expect(isBot(ua), ua).toBe(true);
      expect(isPreviewBot(ua), ua).toBe(false);
    }
  });

  it('treats empty user agents as bots', () => {
    for (const ua of [null, '', '   ']) {
      expect(isBot(ua)).toBe(true);
      expect(isPreviewBot(ua)).toBe(false);
    }
  });

  it('ignores case', () => {
    expect(isBot('SLACKBOT')).toBe(true);
    expect(isPreviewBot('TWITTERBOT/1.0')).toBe(true);
  });
});

describe('visitorId', () => {
  const day1 = Date.UTC(2026, 10, 21, 12);
  const request = (ip: string, ua = 'Mozilla/5.0 Test') => new Request('https://example.com/', { headers: { 'cf-connecting-ip': ip, 'user-agent': ua } });

  it('gives 16 hex characters', async () => {
    const { env } = createTestEnv();
    expect(await visitorId(env, 'link_1', request('203.0.113.7'), day1)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is the same for the same visitor, scope and day', async () => {
    const { env } = createTestEnv();
    const a = await visitorId(env, 'link_1', request('203.0.113.7'), day1);
    expect(await visitorId(env, 'link_1', request('203.0.113.7'), day1 + 3600_000)).toBe(a);
  });

  it('differs by scope, address, user agent and day', async () => {
    const { env } = createTestEnv();
    const base = await visitorId(env, 'link_1', request('203.0.113.7'), day1);
    expect(await visitorId(env, 'link_2', request('203.0.113.7'), day1)).not.toBe(base);
    expect(await visitorId(env, 'link_1', request('203.0.113.8'), day1)).not.toBe(base);
    expect(await visitorId(env, 'link_1', request('203.0.113.7', 'Other UA'), day1)).not.toBe(base);
    expect(await visitorId(env, 'link_1', request('203.0.113.7'), day1 + DAY)).not.toBe(base);
  });

  it('works without an address or user agent', async () => {
    const { env } = createTestEnv();
    const bare = await visitorId(env, 'link_1', new Request('https://example.com/'), day1);
    expect(bare).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorId(env, 'link_1', new Request('https://example.com/'), day1)).toBe(bare);
  });

  it('keeps a random salt in KV for 48 hours and never stores the address or user agent', async () => {
    const t = createTestEnv();
    await visitorId(t.env, 'link_1', request('203.0.113.7', 'Secret UA'), day1);
    const keys = [...t.kv.store.keys()];
    expect(keys).toEqual(['salt:2026-11-21']);
    const entry = t.kv.store.get('salt:2026-11-21')!;
    expect(entry.value).toMatch(/^[0-9a-f]{32}$/);
    const ttl = entry.expiresAt! - Date.now();
    expect(ttl).toBeGreaterThan(47.9 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(48 * 3600_000);
    expect(JSON.stringify([...t.kv.store.values()])).not.toMatch(/203\.0\.113|Secret UA/);
  });

  it('uses the UTC day, with its own salt each day', async () => {
    const t = createTestEnv();
    await visitorId(t.env, 's', request('203.0.113.7'), Date.UTC(2026, 10, 21, 23, 59, 59));
    await visitorId(t.env, 's', request('203.0.113.7'), Date.UTC(2026, 10, 22, 0, 0, 0));
    expect([...t.kv.store.keys()].sort()).toEqual(['salt:2026-11-21', 'salt:2026-11-22']);
    expect(t.kv.store.get('salt:2026-11-21')!.value).not.toBe(t.kv.store.get('salt:2026-11-22')!.value);
  });

  it('reads KV once and writes once per day, however many visitors', async () => {
    const t = createTestEnv();
    const get = vi.spyOn(t.env.KV, 'get');
    const put = vi.spyOn(t.env.KV, 'put');
    await Promise.all(Array.from({ length: 20 }, (_, i) => visitorId(t.env, 's', request(`203.0.113.${i}`), day1)));
    for (let i = 0; i < 5; i++) await visitorId(t.env, 's', request('203.0.113.99'), day1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    await visitorId(t.env, 's', request('203.0.113.99'), day1 + DAY);
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('reuses a salt another isolate already stored, without writing', async () => {
    const t = createTestEnv();
    await t.env.KV.put('salt:2026-11-21', 'abcdef0123456789abcdef0123456789');
    const put = vi.spyOn(t.env.KV, 'put');
    await visitorId(t.env, 's', request('203.0.113.7'), day1);
    expect(put).not.toHaveBeenCalled();
    const other = createTestEnv();
    await other.env.KV.put('salt:2026-11-21', 'abcdef0123456789abcdef0123456789');
    expect(await visitorId(other.env, 's', request('203.0.113.7'), day1)).toBe(await visitorId(t.env, 's', request('203.0.113.7'), day1));
  });

  it('tries again after KV fails', async () => {
    const t = createTestEnv();
    const get = vi.spyOn(t.env.KV, 'get').mockRejectedValueOnce(new Error('KV down'));
    await expect(visitorId(t.env, 's', request('203.0.113.7'), day1)).rejects.toThrow('KV down');
    expect(await visitorId(t.env, 's', request('203.0.113.7'), day1)).toMatch(/^[0-9a-f]{16}$/);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('assertPublicUrl', () => {
  const allowed = [
    'http://example.com',
    'https://example.com/path?q=1#frag',
    'https://sub.example.co.uk:8443/a',
    'HTTPS://EXAMPLE.COM/',
    'https://example.com./',
    'https://xn--mnchen-3ya.example/',
    'https://münchen.example/',
    'https://日本語.example/',
    'http://8.8.8.8/',
    'http://1.1.1.1:8080/',
    'http://100.63.255.255/',
    'http://100.128.0.1/',
    'http://172.15.255.255/',
    'http://172.32.0.1/',
    'http://192.0.1.1/',
    'http://198.17.255.255/',
    'http://198.20.0.1/',
    'http://223.255.255.255/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[::ffff:0:8.8.8.8]/',
    'http://[2001:db8::1]/',
    'http://[2001:1::1]/',
    'http://[64:ff9b::808:808]/',
    'http://localhost.example.com/',
    'http://my.internal.example.com/',
    'http://notlocal.com/',
  ];
  const refused = [
    // schemes
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,hi',
    'gopher://example.com/',
    'ws://example.com/',
    // not a URL
    '',
    'example.com',
    '//example.com/',
    '/relative',
    'http://',
    'https://exa mple.com/',
    // credentials
    'https://user@example.com/',
    'https://user:pass@example.com/',
    'https://:pass@example.com/',
    'https://example.com@evil.internal/',
    // names
    'http://localhost/',
    'http://LOCALHOST:3000/',
    'http://localhost./',
    'http://foo.localhost/',
    'http://a.b.localhost./',
    'http://printer.local/',
    'http://db.internal/',
    'http://metadata.google.internal/',
    'http://router.home.arpa/',
    'http://home.arpa/',
    'http://intranet/',
    'http://intranet./',
    'http://nas:8080/',
    // IPv4
    'http://0.0.0.0/',
    'http://0.255.255.255/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://127.0.0.1/',
    'http://127.255.255.254:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://192.0.0.1/',
    'http://198.18.0.1/',
    'http://198.19.255.255/',
    'http://224.0.0.1/',
    'http://239.255.255.250/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    // IPv4 in other spellings
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://0177.0.0.01/',
    'http://017700000001/',
    'http://127.1/',
    'http://127.0.1/',
    'http://0/',
    'http://0x0/',
    'http://167772161/',
    'http://0xa9fea9fe/',
    'http://2852039166/',
    'http://3232235777/',
    'http://127.0.0.1./',
    'http://%31%32%37.0.0.1/',
    'http://１２７.０.０.１/',
    // IPv6
    'http://[::1]/',
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[0000:0000:0000:0000:0000:0000:0000:0001]:8080/',
    'http://[fc00::1]/',
    'http://[fd12:3456:789a::1]/',
    'http://[fe80::1]/',
    'http://[fe80::1%25eth0]/',
    'http://[febf::1]/',
    'http://[fec0::1]/',
    'http://[ff02::1]/',
    // IPv4-mapped, compatible, NAT64 and 6to4
    'http://[::ffff:127.0.0.1]/',
    'http://[::FFFF:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::ffff:0.0.0.0]/',
    'http://[::127.0.0.1]/',
    'http://[::7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b::127.0.0.1]/',
    'http://[64:ff9b::a00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[64:ff9b:1::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2002:a00:1::1]/',
    // IPv4-translated ::ffff:0:a.b.c.d, and Teredo 2001::/32
    'http://[::ffff:0:127.0.0.1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[0:0:0:0:ffff:0:a00:1]/',
    'http://[::ffff:0:169.254.169.254]/',
    'http://[2001::1]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
  ];

  for (const raw of allowed) {
    it(`allows ${raw}`, () => {
      expect(() => assertPublicUrl(raw)).not.toThrow();
    });
  }

  for (const raw of refused) {
    it(`refuses ${JSON.stringify(raw)}`, async () => {
      expect(await codeOf(() => assertPublicUrl(raw))).toBe('url_not_allowed');
    });
  }

  it('returns the parsed URL', () => {
    const url = assertPublicUrl('https://Example.com/a/b?x=1#y');
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe('example.com');
    expect(url.pathname).toBe('/a/b');
    expect(url.search).toBe('?x=1');
  });

  it('throws a 400 with a plain message', () => {
    try {
      assertPublicUrl('http://127.0.0.1/');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).message).toMatch(/public web address/);
    }
  });
});

describe('safeFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Call = { url: string; init: RequestInit };
  /** Replace fetch with a function that answers from `handler` and records the calls. */
  function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      // Snapshot the headers: safeFetch edits its Headers object between hops, as a real fetch would not see.
      const call = { url: String(input), init: { ...init, headers: new Headers(init.headers) } };
      calls.push(call);
      return handler(call, calls.length - 1);
    });
    return calls;
  }
  const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
  const headersOf = (call: Call) => new Headers(call.init.headers);

  it('returns a Response with the same status, headers and body', async () => {
    const calls = stubFetch(() => new Response('<p>hi</p>', { status: 201, statusText: 'Created', headers: { 'content-type': 'text/html', 'x-custom': 'yes' } }));
    const res = await safeFetch('https://example.com/page');
    expect(res.status).toBe(201);
    expect(res.statusText).toBe('Created');
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(await res.text()).toBe('<p>hi</p>');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.com/page');
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('can be read twice by the caller, since it is buffered', async () => {
    stubFetch(() => new Response('abc'));
    const res = await safeFetch('https://example.com/');
    expect(await res.clone().text()).toBe('abc');
    expect(await res.text()).toBe('abc');
  });

  it('accepts a URL object and passes the method, body and headers through', async () => {
    const calls = stubFetch(() => new Response('ok'));
    await safeFetch(new URL('https://example.com/post'), { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json', accept: 'text/html' } });
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(headersOf(calls[0]!).get('accept')).toBe('text/html');
    expect(headersOf(calls[0]!).get('content-type')).toBe('application/json');
  });

  it('sends User-Agent: Toolshed unless one is given', async () => {
    const calls = stubFetch(() => new Response('ok'));
    await safeFetch('https://example.com/');
    await safeFetch('https://example.com/', { headers: { 'User-Agent': 'MyBot/1.0' } });
    expect(headersOf(calls[0]!).get('user-agent')).toBe('Toolshed');
    expect(headersOf(calls[1]!).get('user-agent')).toBe('MyBot/1.0');
  });

  it('refuses a private address before any request is made', async () => {
    const calls = stubFetch(() => new Response('secret'));
    for (const url of ['http://127.0.0.1/', 'http://localhost:8787/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:pw@example.com/', 'not a url']) {
      expect(await codeOf(() => safeFetch(url)), url).toBe('url_not_allowed');
    }
    expect(calls).toHaveLength(0);
  });

  describe('redirects', () => {
    it('follows redirects, resolving relative ones', async () => {
      const calls = stubFetch((_, n) => (n === 0 ? redirect('/next') : n === 1 ? redirect('https://other.example.org/final', 301) : new Response('done')));
      const res = await safeFetch('https://example.com/start');
      expect(await res.text()).toBe('done');
      expect(calls.map((c) => c.url)).toEqual(['https://example.com/start', 'https://example.com/next', 'https://other.example.org/final']);
    });

    it('checks every hop, so a redirect to a private address is refused', async () => {
      for (const to of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'file:///etc/passwd', '//10.0.0.1/x', 'http://[::ffff:7f00:1]/']) {
        const calls = stubFetch((_, n) => (n === 0 ? redirect(to) : new Response('secret')));
        expect(await codeOf(() => safeFetch('https://example.com/')), to).toBe('url_not_allowed');
        expect(calls, to).toHaveLength(1);
      }
    });

    it('stops after maxRedirects (default 3)', async () => {
      let calls = stubFetch((_, n) => redirect(`/hop${n + 1}`));
      expect(await codeOf(() => safeFetch('https://example.com/'))).toBe('too_many_redirects');
      expect(calls).toHaveLength(4); // the first request plus three redirects
      calls = stubFetch((_, n) => redirect(`/hop${n + 1}`));
      expect(await codeOf(() => safeFetch('https://example.com/', { maxRedirects: 1 }))).toBe('too_many_redirects');
      expect(calls).toHaveLength(2);
      calls = stubFetch((_, n) => redirect(`/hop${n + 1}`));
      expect(await codeOf(() => safeFetch('https://example.com/', { maxRedirects: 0 }))).toBe('too_many_redirects');
      expect(calls).toHaveLength(1);
    });

    it('allows exactly maxRedirects redirects', async () => {
      stubFetch((_, n) => (n < 3 ? redirect(`/hop${n + 1}`) : new Response('arrived')));
      expect(await (await safeFetch('https://example.com/')).text()).toBe('arrived');
    });

    it('returns a redirect without a Location as it is', async () => {
      stubFetch(() => new Response('moved', { status: 301 }));
      const res = await safeFetch('https://example.com/');
      expect(res.status).toBe(301);
      expect(await res.text()).toBe('moved');
    });

    it('returns 304 and 204 answers, which have no body', async () => {
      stubFetch(() => new Response(null, { status: 304 }));
      expect((await safeFetch('https://example.com/')).status).toBe(304);
      stubFetch(() => new Response(null, { status: 204 }));
      expect((await safeFetch('https://example.com/')).status).toBe(204);
    });

    it('keeps every header on the same origin, and on leaving it keeps only the safe ones for good', async () => {
      const calls = stubFetch((_, n) => (n === 0 ? redirect('/same') : n === 1 ? redirect('https://other.example.org/x') : n === 2 ? redirect('https://example.com/back') : new Response('ok')));
      const sent = { cookie: 'a=1', authorization: 'Bearer t', 'proxy-authorization': 'x', 'x-api-key': 'k', 'x-webhook-signature': 's', accept: 'text/html', 'accept-language': 'en', 'user-agent': 'MyBot/1.0', 'content-type': 'text/plain' };
      await safeFetch('https://example.com/', { headers: sent });
      for (const [name, value] of Object.entries(sent)) expect(headersOf(calls[1]!).get(name), `same origin ${name}`).toBe(value);
      for (const i of [2, 3]) {
        for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-webhook-signature']) expect(headersOf(calls[i]!).get(name), `hop ${i} ${name}`).toBeNull();
        for (const name of ['accept', 'accept-language', 'user-agent', 'content-type']) expect(headersOf(calls[i]!).get(name), `hop ${i} ${name}`).toBe(sent[name as keyof typeof sent]);
      }
    });

    it('treats another port or scheme as another origin', async () => {
      let calls = stubFetch((_, n) => (n === 0 ? redirect('https://example.com:8443/') : new Response('ok')));
      await safeFetch('https://example.com/', { headers: { authorization: 'Bearer t' } });
      expect(headersOf(calls[1]!).get('authorization')).toBeNull();
      calls = stubFetch((_, n) => (n === 0 ? redirect('https://example.com/secure') : new Response('ok')));
      await safeFetch('http://example.com/', { headers: { authorization: 'Bearer t', cookie: 'a=1' } });
      expect(headersOf(calls[1]!).get('authorization')).toBeNull();
      expect(headersOf(calls[1]!).get('cookie')).toBeNull();
    });

    it('never follows a redirect from https to http, even on the same host', async () => {
      for (const to of ['http://example.com/plain', 'http://other.example.org/plain']) {
        const calls = stubFetch((_, n) => (n === 0 ? redirect(to) : new Response('leaked')));
        expect(await codeOf(() => safeFetch('https://example.com/', { headers: { authorization: 'Bearer t' } })), to).toBe('redirect_not_followed');
        expect(calls, to).toHaveLength(1);
      }
    });

    it('still follows http to https and http to http', async () => {
      stubFetch((_, n) => (n === 0 ? redirect('https://example.com/secure') : new Response('ok')));
      expect(await (await safeFetch('http://example.com/')).text()).toBe('ok');
      stubFetch((_, n) => (n === 0 ? redirect('/next') : new Response('ok')));
      expect(await (await safeFetch('http://example.com/')).text()).toBe('ok');
    });

    it('refuses to replay a request body to another origin on 307 and 308, and sends nothing', async () => {
      for (const status of [307, 308]) {
        const calls = stubFetch((_, n) => (n === 0 ? redirect('https://other.example.org/collect', status) : new Response('ok')));
        expect(await codeOf(() => safeFetch('https://example.com/hook', { method: 'POST', body: '{"secret":1}', headers: { 'content-type': 'application/json' } })), String(status)).toBe('redirect_not_followed');
        expect(calls, String(status)).toHaveLength(1);
      }
    });

    it('refuses a 301 that would carry a PUT body to another origin, but a POST becomes a GET and goes on', async () => {
      let calls = stubFetch((_, n) => (n === 0 ? redirect('https://other.example.org/x', 301) : new Response('ok')));
      expect(await codeOf(() => safeFetch('https://example.com/', { method: 'PUT', body: 'x=1' }))).toBe('redirect_not_followed');
      expect(calls).toHaveLength(1);
      calls = stubFetch((_, n) => (n === 0 ? redirect('https://other.example.org/x', 302) : new Response('ok')));
      await safeFetch('https://example.com/', { method: 'POST', body: 'x=1', headers: { 'x-api-key': 'k' } });
      expect(calls[1]!.init.method).toBe('GET');
      expect(calls[1]!.init.body).toBeUndefined();
      expect(headersOf(calls[1]!).get('x-api-key')).toBeNull();
    });

    it('replays a 307 body on the same origin, and a bodyless 307 to another origin', async () => {
      let calls = stubFetch((_, n) => (n === 0 ? redirect('/next', 307) : new Response('ok')));
      await safeFetch('https://example.com/', { method: 'POST', body: 'x=1' });
      expect(calls[1]!.init.body).toBe('x=1');
      calls = stubFetch((_, n) => (n === 0 ? redirect('https://other.example.org/x', 307) : new Response('ok')));
      expect((await safeFetch('https://example.com/', { headers: { 'x-api-key': 'k' } })).status).toBe(200);
      expect(headersOf(calls[1]!).get('x-api-key')).toBeNull();
    });

    it('turns a redirected POST into a GET, but keeps the method on 307', async () => {
      let calls = stubFetch((_, n) => (n === 0 ? redirect('/next', 302) : new Response('ok')));
      await safeFetch('https://example.com/', { method: 'POST', body: 'x=1', headers: { 'content-type': 'text/plain' } });
      expect(calls[1]!.init.method).toBe('GET');
      expect(calls[1]!.init.body).toBeUndefined();
      expect(headersOf(calls[1]!).get('content-type')).toBeNull();
      calls = stubFetch((_, n) => (n === 0 ? redirect('/next', 307) : new Response('ok')));
      await safeFetch('https://example.com/', { method: 'POST', body: 'x=1' });
      expect(calls[1]!.init.method).toBe('POST');
      expect(calls[1]!.init.body).toBe('x=1');
    });
  });

  describe('size', () => {
    const big = (n: number) => 'a'.repeat(n);

    it('fails with fetch_too_large over the cap (default 1,000,000 bytes)', async () => {
      stubFetch(() => new Response(big(1_000_001)));
      expect(await codeOf(() => safeFetch('https://example.com/'))).toBe('fetch_too_large');
      stubFetch(() => new Response(big(1_000_000)));
      expect((await (await safeFetch('https://example.com/')).text()).length).toBe(1_000_000);
    });

    it('honours maxBytes', async () => {
      stubFetch(() => new Response(big(101)));
      expect(await codeOf(() => safeFetch('https://example.com/', { maxBytes: 100 }))).toBe('fetch_too_large');
      stubFetch(() => new Response(big(100)));
      expect((await (await safeFetch('https://example.com/', { maxBytes: 100 })).text()).length).toBe(100);
    });

    it('refuses early when Content-Length is already over the cap', async () => {
      let cancelled = false;
      const body = new ReadableStream({ cancel: () => void (cancelled = true) });
      stubFetch(() => new Response(body, { headers: { 'content-length': '5000' } }));
      expect(await codeOf(() => safeFetch('https://example.com/', { maxBytes: 100 }))).toBe('fetch_too_large');
      expect(cancelled).toBe(true);
    });

    it('stops reading a body that lies about its length', async () => {
      let pulls = 0;
      const body = new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode(big(60)));
        },
      });
      stubFetch(() => new Response(body, { headers: { 'content-length': '10' } }));
      expect(await codeOf(() => safeFetch('https://example.com/', { maxBytes: 100 }))).toBe('fetch_too_large');
      expect(pulls).toBeLessThan(10);
    });

    it('cuts the body at maxBytes when truncate is true', async () => {
      stubFetch(() => new Response(big(500)));
      const res = await safeFetch('https://example.com/', { maxBytes: 100, truncate: true });
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBe(100);
    });

    it('truncates across chunks and at multi-byte text, without failing on Content-Length', async () => {
      const chunk = new TextEncoder().encode('é'.repeat(40)); // 80 bytes
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
        },
      });
      stubFetch(() => new Response(body, { headers: { 'content-length': '999999' } }));
      const res = await safeFetch('https://example.com/', { maxBytes: 100, truncate: true });
      expect((await res.arrayBuffer()).byteLength).toBe(100);
    });

    it('leaves a body under the cap alone when truncate is true', async () => {
      stubFetch(() => new Response('short'));
      expect(await (await safeFetch('https://example.com/', { truncate: true })).text()).toBe('short');
    });

    it('does not pass on headers that describe the wire body', async () => {
      stubFetch(() => new Response('abc', { headers: { 'content-length': '3', 'content-encoding': 'identity', 'content-type': 'text/plain' } }));
      const res = await safeFetch('https://example.com/');
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect(res.headers.get('content-encoding')).toBeNull();
    });
  });

  describe('failures', () => {
    it('times out a request that never answers (default 8 seconds, here 30 ms)', async () => {
      stubFetch(({ init }) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
      const started = Date.now();
      expect(await codeOf(() => safeFetch('https://example.com/', { timeoutMs: 30 }))).toBe('fetch_timeout');
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('times out a body that stalls', async () => {
      const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('partial')) });
      stubFetch(() => new Response(body));
      expect(await codeOf(() => safeFetch('https://example.com/', { timeoutMs: 30 }))).toBe('fetch_timeout');
    });

    it('counts the whole redirect chain against one timeout', async () => {
      stubFetch(async (_, n) => {
        await new Promise((r) => setTimeout(r, 25));
        return n < 3 ? redirect(`/h${n + 1}`) : new Response('ok');
      });
      expect(await codeOf(() => safeFetch('https://example.com/', { timeoutMs: 60 }))).toBe('fetch_timeout');
    });

    it('gives fetch_failed for network errors, whatever they say', async () => {
      stubFetch(() => {
        throw new TypeError('connect ECONNREFUSED 10.1.2.3:80');
      });
      try {
        await safeFetch('https://example.com/');
        expect.unreachable();
      } catch (err) {
        expect((err as AppError).code).toBe('fetch_failed');
        expect((err as AppError).message).not.toContain('10.1.2.3');
      }
    });

    it('gives fetch_failed when a redirect Location cannot be read', async () => {
      stubFetch(() => redirect('http://[bad/'));
      expect(await codeOf(() => safeFetch('https://example.com/'))).toBe('fetch_failed');
    });

    it('gives fetch_failed, and sends nothing, for a header fetch cannot send', async () => {
      const calls = stubFetch(() => new Response('ok'));
      expect(await codeOf(() => safeFetch('https://example.com/', { headers: { 'bad header': 'x' } }))).toBe('fetch_failed');
      expect(await codeOf(() => safeFetch('https://example.com/', { headers: { 'x-ok': 'line\nbreak' } }))).toBe('fetch_failed');
      expect(calls).toHaveLength(0);
    });

    it('honours a caller signal that is already aborted', async () => {
      const seen: boolean[] = [];
      stubFetch(({ init }) => {
        seen.push(init.signal?.aborted === true);
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return new Response('ok');
      });
      expect(await codeOf(() => safeFetch('https://example.com/', { signal: AbortSignal.abort(), timeoutMs: 5000 }))).toBe('fetch_failed');
      expect(seen).toEqual([true]);
    });

    it('stops waiting when the caller aborts', async () => {
      const controller = new AbortController();
      stubFetch(({ init }) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
      const pending = codeOf(() => safeFetch('https://example.com/', { signal: controller.signal, timeoutMs: 5000 }));
      controller.abort();
      expect(await pending).toBe('fetch_failed');
    });
  });
});
