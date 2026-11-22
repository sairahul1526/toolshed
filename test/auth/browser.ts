/**
 * A pretend browser for auth tests: it keeps cookies between requests the way a real one does,
 * sends a same-site Origin header with every form post, and never follows redirects on its own,
 * so a test can assert each hop.
 */
import type { Hono } from 'hono';
import { createApp } from '../../src/app';
import { devOutbox } from '../../src/core/email';
import type { AppEnv, Env } from '../../src/env';

export const ORIGIN = 'http://localhost';

export function testApp(): Hono<AppEnv> {
  return createApp({ screens: {} });
}

export class Browser {
  readonly cookies = new Map<string, string>();
  /** The referrer policy of the page this browser is on. */
  private policy: string | null = null;

  constructor(
    private readonly app: Hono<AppEnv>,
    private readonly env: Env,
    private readonly ip = '198.51.100.20',
  ) {}

  /** A second browser holding the same cookies, for "what if the old cookie is replayed" tests. */
  clone(): Browser {
    const copy = new Browser(this.app, this.env, this.ip);
    for (const [name, value] of this.cookies) copy.cookies.set(name, value);
    return copy;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    return { 'cf-connecting-ip': this.ip, 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36', ...(cookie ? { cookie } : {}), ...extra };
  }

  /** Apply a response's Set-Cookie headers to the jar. */
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      const expires = attrs.find((a) => /^expires=/i.test(a));
      const gone = value === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0) || (expires && Date.parse(expires.slice(8)) <= Date.now());
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const res = await this.app.request(path, init, this.env);
    this.absorb(res);
    this.policy = res.headers.get('referrer-policy');
    return res;
  }

  /** What a real browser puts in Origin for a form on the current page: `null` when the page said `no-referrer`. */
  private origin(): string {
    return this.policy === 'no-referrer' ? 'null' : ORIGIN;
  }

  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, { headers: this.headers(headers) });
  }

  post(path: string, form: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: this.headers({ origin: this.origin(), 'content-type': 'application/x-www-form-urlencoded', ...headers }),
      body: new URLSearchParams(form).toString(),
    });
  }

  postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: this.headers({ origin: this.origin(), 'content-type': 'application/json', ...headers }),
      body: JSON.stringify(body),
    });
  }

  /** True when the app sees this browser as signed in. */
  async signedIn(): Promise<boolean> {
    const res = await this.get('/sign-in');
    return res.status === 302 && res.headers.get('location') === '/app';
  }
}

/** The newest email to an address, as the dev outbox keeps it. */
export async function lastEmail(env: Env, to: string): Promise<{ subject: string; text: string; template: string | null } | null> {
  const [mail] = await devOutbox(env, { to, limit: 1 });
  return mail ? { subject: mail.subject, text: mail.text ?? '', template: mail.template } : null;
}

/** The 6-digit code in the newest email to an address. */
export async function lastCode(env: Env, to: string): Promise<string> {
  const code = (await lastEmail(env, to))?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`No code was emailed to ${to}`);
  return code;
}

/** The path of the one-time link in the newest email to an address. */
export async function lastLink(env: Env, to: string, prefix = '/sign-in/link/'): Promise<string> {
  const text = (await lastEmail(env, to))?.text ?? '';
  const at = text.indexOf(prefix);
  const path = at < 0 ? null : text.slice(at).match(/^[^\s"'<>)]+/)?.[0];
  if (!path) throw new Error(`No link was emailed to ${to}`);
  return path;
}

/** Sign a browser in with an emailed code, the way a person would. Ends on the page after sign-in. */
export async function signInByCode(browser: Browser, env: Env, email: string): Promise<Response> {
  const start = await browser.post('/sign-in', { email, intent: 'code' });
  if (start.status !== 303) throw new Error(`Asking for a code answered ${start.status}`);
  return browser.post('/sign-in/code', { code: await lastCode(env, email) });
}

/** Put a ready-made session cookie (from `createTestSession`) into a browser. */
export function adopt(browser: Browser, cookie: string): Browser {
  const eq = cookie.indexOf('=');
  browser.cookies.set(cookie.slice(0, eq), cookie.slice(eq + 1));
  return browser;
}
