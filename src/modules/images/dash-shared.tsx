/** Small helpers every Images dashboard screen uses: the page wrapper, form reading and error handling. */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { AppError, type FieldErrors } from '../../core/errors';
import { needRole } from '../../core/guards';
import type { AppEnv } from '../../env';
import { LinkButton, renderPage, setFlash, Tabs } from '../../ui';
import type { Crumb } from '../../ui';
import type { TemplateSummary } from './templates';

export const HOME = '/app/images';
export const API = '/api/v1/images';

export type Ctx = Context<AppEnv>;

interface PageOptions {
  crumbs?: Crumb[];
  status?: 200 | 404 | 422;
  /** A script from the module's static folder that this screen needs, for example `share.js`. */
  script?: string;
}

/** The dashboard has no style or script hook, so each screen loads the module's files in its body. */
export function page(c: Ctx, title: string, body: Child, opts: PageOptions = {}): Promise<Response> {
  const crumbs = opts.crumbs ?? (title === 'Images' ? undefined : [{ label: 'Images', href: HOME }, { label: title }]);
  return renderPage(c, { title, crumbs, status: opts.status }, (
    <>
      <link rel="stylesheet" href="/m/images/images.css" />
      {opts.script ? <script type="module" src={`/m/images/${opts.script}`}></script> : null}
      {body}
    </>
  ));
}

export type Form = Record<string, string | File | (string | File)[]>;

export async function readForm(c: Ctx): Promise<Form> {
  return (await c.req.parseBody({ all: true })) as Form;
}

/** One text value, trimmed. Missing fields and file uploads read as an empty string. */
export function text(form: Form, key: string): string {
  const value = form[key];
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === 'string' ? one.trim() : '';
}

export const checked = (form: Form, key: string): boolean => text(form, key) !== '';

/** A whole number a person typed, or undefined when the box was left empty or holds something else. */
export function numberIn(form: Form, key: string): number | undefined {
  const raw = text(form, key);
  return /^-?[0-9]{1,7}(\.[0-9]{1,3})?$/.test(raw) ? Number(raw) : undefined;
}

/** An uploaded file from a form, or null when nothing was chosen. */
export function fileIn(form: Form, key: string): File | null {
  const value = form[key];
  const one = Array.isArray(value) ? value[0] : value;
  return one && typeof one !== 'string' && one.size > 0 ? one : null;
}

/** Writers only: viewers can look but not change anything. */
export const writer = (c: Ctx): void => needRole(c, 'member');

export function canWrite(c: Ctx): boolean {
  try {
    needRole(c, 'member');
    return true;
  } catch {
    return false;
  }
}

export function isAdmin(c: Ctx): boolean {
  try {
    needRole(c, 'admin');
    return true;
  } catch {
    return false;
  }
}

/** An error a person caused (a taken name, a bad file) reads out as a message; anything else is rethrown. */
export function plainError(err: unknown): { message: string; fields: FieldErrors } {
  if (err instanceof AppError && err.status < 500) return { message: err.message, fields: err.fields ?? {} };
  throw err;
}

/** The message of a refused action on one thing. When the thing itself is gone there is no page to go back to, so that stays a 404. */
export function refusal(err: unknown): string {
  if (err instanceof AppError && err.status === 404) throw err;
  return plainError(err).message;
}

export function flashAndGo(c: Ctx, kind: 'ok' | 'error' | 'info', message: string, to: string): Response {
  // A flash travels in a small cookie, so a long validation message is cut rather than dropped.
  setFlash(c, { kind, message: message.length > 230 ? `${message.slice(0, 229)}…` : message });
  return c.redirect(to, 303);
}

/** Field values typed into a share or preview form. They are sent as `f.<name>` so a field can never clash with a page option. */
export function fieldValues(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (key.startsWith('f.')) out[key.slice(2)] = value;
  return out;
}

export function TemplateTabs({ template, active }: { template: TemplateSummary; active: 'share' | 'edit' | 'settings' }) {
  const base = `${HOME}/t/${template.id}`;
  return (
    <Tabs
      label="Template sections"
      active={active}
      items={[
        { id: 'share', label: 'Use', href: base },
        { id: 'edit', label: 'Design', href: `${base}/edit` },
        { id: 'settings', label: 'Settings', href: `${base}/settings` },
      ]}
    />
  );
}

/** Lists page by cursor, so there is a link to the next page instead of page numbers. */
export function More({ href, label = 'Show older' }: { href: string | null; label?: string }) {
  return href ? (
    <p class="img-more">
      <LinkButton href={href} icon="down">{label}</LinkButton>
    </p>
  ) : null;
}

export function query(params: Record<string, string | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) out.set(key, value);
  const text = out.toString();
  return text ? `?${text}` : '';
}
