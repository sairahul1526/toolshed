/** Small helpers every Mail screen uses: the page wrapper, form reading, error handling and the sub navigation. */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../../env';
import { AppError, type FieldErrors } from '../../core/errors';
import { needRole } from '../../core/guards';
import { Callout, LinkButton, renderPage, setFlash } from '../../ui';
import type { Crumb } from '../../ui';

export const HOME = '/app/mail';

export function Assets() {
  return <script src="/m/mail/mail.js" defer></script>;
}

export function page(c: Context<AppEnv>, title: string, body: Child, crumbs?: Crumb[], status?: 200 | 404 | 422 | 500): Promise<Response> {
  const trail = crumbs ?? (title === 'Broadcasts' ? undefined : [{ label: 'Mail', href: HOME }, { label: title }]);
  return renderPage(c, { title, crumbs: trail, status, styles: ['/m/mail/mail.css'] }, (
    <>
      <Assets />
      {body}
    </>
  ));
}

export type Form = Record<string, string | File | (string | File)[]>;

export async function readForm(c: Context<AppEnv>): Promise<Form> {
  return (await c.req.parseBody({ all: true })) as Form;
}

export function text(f: Form, key: string): string {
  const v = f[key];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === 'string' ? one.trim() : '';
}

/** The raw value, not trimmed: email bodies keep their line breaks. */
export function raw(f: Form, key: string): string {
  const v = f[key];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === 'string' ? one : '';
}

export const checked = (f: Form, key: string): boolean => text(f, key) !== '';

export function valuesOf(f: Form): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === 'string') out[k] = one;
  }
  return out;
}

export const writer = (c: Context<AppEnv>): void => needRole(c, 'member');
export const canWrite = (c: Context<AppEnv>): boolean => ['member', 'admin', 'owner'].includes(c.get('org')?.role ?? '');

export function plainError(e: unknown): { message: string; fields: FieldErrors } {
  if (e instanceof AppError && e.status < 500) return { message: e.message, fields: e.fields ?? {} };
  throw e;
}

export function flashAndGo(c: Context<AppEnv>, kind: 'ok' | 'error' | 'info', message: string, to: string): Response {
  setFlash(c, { kind, message });
  return c.redirect(to, 303);
}

export async function safely(c: Context<AppEnv>, title: string, build: () => Promise<Child>): Promise<Response> {
  let body: Child;
  try {
    body = await build();
  } catch (e) {
    if (e instanceof AppError) throw e;
    const here = new URL(c.req.url);
    return page(c, title, (
      <Callout tone="bad" title="This didn’t load" actions={<LinkButton href={here.pathname + here.search}>Try again</LinkButton>}>
        We couldn’t read your mail data just now. Nothing was lost. Try again in a moment.
      </Callout>
    ), undefined, 500);
  }
  return page(c, title, body);
}

export const csvResponse = (name: string, body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });

export const utcLocal = (ms: number): string => new Date(ms).toISOString().slice(0, 16);
export const fromUtcLocal = (s: string): number => Date.parse(`${s}:00Z`);

/** Like `safely`, for screens that build their own response (they need a status code for errors). */
export async function guard(c: Context<AppEnv>, title: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AppError) throw e;
    const here = new URL(c.req.url);
    return page(c, title, (
      <Callout tone="bad" title="This didn’t load" actions={<LinkButton href={here.pathname + here.search}>Try again</LinkButton>}>
        We couldn’t read your mail data just now. Nothing was lost. Try again in a moment.
      </Callout>
    ), undefined, 500);
  }
}
