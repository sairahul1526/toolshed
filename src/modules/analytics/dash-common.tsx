/** Pieces every Analytics screen shares: the page frame, the tab row and the way posts answer. */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { AppError, type FieldErrors } from '../../core/errors';
import { roleAtLeast, type AppEnv } from '../../env';
import { Pill, Tabs, renderPage, setFlash } from '../../ui';
import type { Crumb } from '../../ui';
import type { Site } from './sites';

export type C = Context<AppEnv>;
export const BASE = '/app/analytics';

export const siteHref = (site: Pick<Site, 'id'>, rest = ''): string => `${BASE}/sites/${site.id}${rest}`;

const STYLES = ['/m/analytics/report.css', '/m/analytics/analytics.css'];

export function page(c: C, title: string, crumbs: Crumb[], body: Child, status?: 200 | 404 | 422): Promise<Response> {
  return renderPage(c, { title, crumbs, status, styles: STYLES }, (
    <>
      <script src="/m/analytics/analytics.js" defer></script>
      {body}
    </>
  ));
}

/** Viewers can look at everything and change nothing, so their screens leave the buttons out. */
export function canWrite(c: C): boolean {
  const org = c.get('org');
  return !!org && roleAtLeast(org.role, 'member');
}

export function isAdmin(c: C): boolean {
  const org = c.get('org');
  return !!org && roleAtLeast(org.role, 'admin');
}

export type Section = 'dashboard' | 'goals' | 'share' | 'export' | 'settings' | 'setup';

/** The tab row under a site's name. `keep` carries the chosen date range from tab to tab. */
export function SiteTabs({ site, active, keep = '' }: { site: Site; active: Section; keep?: string }) {
  return (
    <div class="an-tabs">
      <Tabs
        label="Site sections"
        active={active}
        items={[
          { id: 'dashboard', label: 'Dashboard', href: siteHref(site, keep) },
          { id: 'goals', label: 'Goals and events', href: siteHref(site, `/goals${keep}`) },
          { id: 'share', label: 'Share', href: siteHref(site, '/share') },
          { id: 'export', label: 'Export', href: siteHref(site, '/export') },
          { id: 'settings', label: 'Settings', href: siteHref(site, '/settings') },
          { id: 'setup', label: 'Install', href: siteHref(site, '/setup') },
        ]}
      />
    </div>
  );
}

export function siteCrumbs(site: Site, last?: string): Crumb[] {
  return [{ label: 'Analytics', href: BASE }, last ? { label: site.name, href: siteHref(site) } : { label: site.name }, ...(last ? [{ label: last }] : [])];
}

export function SamplePill({ site }: { site: Pick<Site, 'sample'> }) {
  return site.sample === 1 ? <Pill>Sample</Pill> : null;
}

/** Runs a post, flashes the result and goes back. Service errors become a message, not a crash. */
export async function act(c: C, back: string, fn: () => Promise<string | void>): Promise<Response> {
  try {
    const message = await fn();
    if (message) setFlash(c, { kind: 'ok', message });
  } catch (e) {
    if (e instanceof AppError && e.status < 500) setFlash(c, { kind: 'error', message: Object.values(e.fields ?? {})[0] ?? e.message });
    else throw e;
  }
  return c.redirect(back, 303);
}

/** An error a person caused reads out next to the field; anything else is rethrown. */
export function plainError(e: unknown): { message: string; fields: FieldErrors } {
  if (e instanceof AppError && e.status < 500) return { message: e.message, fields: e.fields ?? {} };
  throw e;
}

export type Values = Record<string, string>;

/** What a person typed, as plain strings, so a form can be shown again with their values. Passwords are left out. */
export async function formValues(c: C): Promise<Values> {
  const out: Values = {};
  for (const [k, v] of Object.entries(await c.req.parseBody())) {
    if (typeof v === 'string' && k !== 'password') out[k] = v;
  }
  return out;
}
