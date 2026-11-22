/** Small helpers every dashboard screen uses: the page wrapper, form reading and error handling. */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../../env';
import { AppError, type FieldErrors } from '../../core/errors';
import { needRole } from '../../core/guards';
import { renderPage, setFlash, Callout, LinkButton } from '../../ui';
import type { Crumb } from '../../ui';

export const HOME = '/app/links';

/** The dashboard has no style or script hook, so each screen loads the module's files in its body. */
export function Assets() {
  return (
    <>
      <link rel="stylesheet" href="/m/links/links.css" />
      <script src="/m/links/links.js" defer></script>
    </>
  );
}

export function page(c: Context<AppEnv>, title: string, body: Child, crumbs?: Crumb[], status?: 200 | 404 | 422 | 500): Promise<Response> {
  const trail = crumbs ?? (title === 'Links' ? undefined : [{ label: 'Links', href: HOME }, { label: title }]);
  return renderPage(c, { title, crumbs: trail, status }, (
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

/** One text value, trimmed. Missing fields and file uploads read as an empty string. */
export function text(f: Form, key: string): string {
  const v = f[key];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === 'string' ? one.trim() : '';
}

export function many(f: Form, key: string): string[] {
  const v = f[key];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.filter((x): x is string => typeof x === 'string' && x !== '');
}

export const checked = (f: Form, key: string): boolean => text(f, key) !== '';

/** Everything a person typed, as plain strings, so a form can be shown again with their values. */
export function valuesOf(f: Form): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === 'string' && k !== 'password') out[k] = one;
  }
  return out;
}

/** Writers only: viewers can look but not change anything. */
export const writer = (c: Context<AppEnv>): void => needRole(c, 'member');

/** An error a person caused (bad address, taken code) reads out as a message; anything else is rethrown. */
export function plainError(e: unknown): { message: string; fields: FieldErrors } {
  if (e instanceof AppError && e.status < 500) return { message: e.message, fields: e.fields ?? {} };
  throw e;
}

export function flashAndGo(c: Context<AppEnv>, kind: 'ok' | 'error' | 'info', message: string, to: string): Response {
  setFlash(c, { kind, message });
  return c.redirect(to, 303);
}

/** Runs a screen's data loading; if the database fails, shows a retry box instead of a bare error. */
export async function safely(c: Context<AppEnv>, title: string, build: () => Promise<Child>): Promise<Response> {
  let body: Child;
  try {
    body = await build();
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error(`[links] ${title} failed to load`, e);
    return page(c, title, (
      <Callout tone="bad" title="This didn’t load" actions={<LinkButton href={new URL(c.req.url).pathname + new URL(c.req.url).search}>Try again</LinkButton>}>
        We couldn’t read your links just now. Nothing was lost. Try again in a moment.
      </Callout>
    ), undefined, 500);
  }
  return page(c, title, body);
}

export const csvResponse = (name: string, body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
