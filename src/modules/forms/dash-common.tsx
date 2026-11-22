/** Pieces every Forms screen shares: the page frame, the tab row and the way posts answer. */
import type { Context } from 'hono';
import { AppError } from '../../core/errors';
import type { AppEnv } from '../../env';
import { Pill, Tabs, setFlash } from '../../ui';
import type { Form } from './service';

export type C = Context<AppEnv>;
export const BASE = '/app/forms';

/** The module's stylesheet goes in the head through `renderPage`; only the script is part of the page. */
export const STYLES = ['/m/forms/dash.css'];
export const CSS = <script src="/m/forms/dash.js" defer />;

export function statusPill(form: Form) {
  if (form.trashedAt) return <Pill tone="bad">In trash</Pill>;
  if (form.status === 'live') return <Pill tone="good">Live</Pill>;
  if (form.status === 'closed') return <Pill tone="warn">Closed</Pill>;
  return <Pill>Draft</Pill>;
}

export type Section = 'responses' | 'summary' | 'edit' | 'share' | 'settings' | 'import';

/** The tab row under a form's name. */
export function FormTabs({ form, active }: { form: Form; active: Section }) {
  const href = (s: string) => `${BASE}/${form.id}/${s}`;
  return (
    <div class="fm-tabs">
      <Tabs
        label="Form sections"
        active={active}
        items={[
          { id: 'responses', label: 'Responses', count: form.responseCount, href: href('responses') },
          { id: 'summary', label: 'Summary', href: href('summary') },
          { id: 'edit', label: 'Edit', href: href('edit') },
          { id: 'share', label: 'Share', href: href('share') },
          { id: 'settings', label: 'Settings', href: href('settings') },
          { id: 'import', label: 'Import and export', href: href('import') },
        ]}
      />
    </div>
  );
}

export function crumbs(form: Form, last?: string) {
  return [{ label: 'Forms', href: BASE }, { label: form.name, ...(last ? { href: `${BASE}/${form.id}/responses` } : {}) }, ...(last ? [{ label: last }] : [])];
}

/** Only ever send people back to a screen of this module. */
export function safeBack(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.startsWith(`${BASE}/`) && !raw.includes('//') ? raw : fallback;
}

/** Runs a post, flashes the result and goes back. Service errors become an error message, not a crash. */
export async function act(c: C, back: string, fn: () => Promise<string | void>): Promise<Response> {
  try {
    const message = await fn();
    if (message) setFlash(c, { kind: 'ok', message });
  } catch (e) {
    if (e instanceof AppError) setFlash(c, { kind: 'error', message: e.message });
    else throw e;
  }
  return c.redirect(back, 303);
}

export async function body(c: C): Promise<Record<string, string | File | (string | File)[]>> {
  return (await c.req.parseBody({ all: true })) as Record<string, string | File | (string | File)[]>;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);
