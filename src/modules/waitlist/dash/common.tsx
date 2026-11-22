/** Shared pieces of the dashboard screens: finding the waitlist, tabs, the email notice and form helpers. */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { auditFromRequest } from '../../../core/audit';
import { orgDb, type OrgDb } from '../../../core/db';
import { emailStatus } from '../../../core/email';
import { AppError, errors } from '../../../core/errors';
import { requireOrg } from '../../../core/guards';
import { shellData } from '../../../core/shell-data';
import type { AppEnv } from '../../../env';
import { AppShell, Callout, LinkButton, Select, Switch, Tabs, setFlash, takeFlash, type Crumb } from '../../../ui';
import { STYLES } from '../views';
import { baseUrl } from '../platform';
import { listWaitlists } from '../waitlists';
import type { Waitlist } from '../types';

export type C = Context<AppEnv>;

export const ROOT = '/app/waitlist';

/** Changing things needs the Member role; viewers can look. */
export const write = requireOrg('member');

export interface Scope {
  db: OrgDb;
  base: string;
  orgId: string;
}

export function scopeOf(c: C): Scope {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return { db: orgDb(c.env.DB, org.id), base: baseUrl(c), orgId: org.id };
}

/** A link inside this module that keeps the chosen waitlist. */
export const to = (path: string, wl: Pick<Waitlist, 'id'>, extra: Record<string, string | number | undefined> = {}): string => {
  const q = new URLSearchParams({ w: wl.id });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') q.set(k, String(v));
  return `${ROOT}/${path}?${q.toString()}`;
};

/** The waitlist named by `?w=`, else the newest one. Null when the workspace has none yet. */
export async function pickList(c: C, db: OrgDb): Promise<{ wl: Waitlist | null; lists: Waitlist[] }> {
  const lists = await listWaitlists(db);
  const asked = c.req.query('w');
  return { lists, wl: lists.find((l) => l.id === asked) ?? lists[0] ?? null };
}

/** Form fields as plain strings; repeated fields come back as arrays. */
export async function formOf(c: C): Promise<Record<string, string | File | (string | File)[]>> {
  return (await c.req.parseBody({ all: true })) as Record<string, string | File | (string | File)[]>;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function ids(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 500);
}

/** Run a form action. A plain-language error goes back to the page as a message instead of an error page. */
export async function attempt(c: C, back: string, ok: string | null, work: () => Promise<string | void>): Promise<Response> {
  try {
    const dest = await work();
    if (ok) setFlash(c, { kind: 'ok', message: ok });
    return c.redirect(dest || back, 303);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const detail = err.fields ? Object.values(err.fields)[0] : '';
    setFlash(c, { kind: 'error', message: detail || err.message });
    return c.redirect(back, 303);
  }
}

export const audit = (c: C, action: string, wl: Waitlist, summary: string) => auditFromRequest(c, { action, targetType: 'waitlist', targetId: wl.id, summary });

/** Said at the top of screens when mail will not go out. Signups still work. */
export async function EmailNotice({ c }: { c: C }) {
  const mail = await emailStatus(c.env);
  if (mail.status === 'ready') return null;
  return (
    <Callout tone="warn" title="Email is not set up" actions={mail.action ? <LinkButton href={mail.action.href} size="sm">{mail.action.label}</LinkButton> : undefined}>
      Signups still work, but nobody gets a confirmation or welcome email. People who join are marked unconfirmed, and invites and broadcasts cannot be sent.
    </Callout>
  );
}

const SECTIONS = [
  ['edit', 'Page and rules'],
  ['people', 'Signups'],
  ['review', 'Review'],
  ['launch', 'Launch'],
  ['stats', 'Stats'],
  ['data', 'Import and export'],
] as const;

/** Pick a waitlist, and move between its screens. */
export function ListNav({ lists, wl, active, counts }: { lists: Waitlist[]; wl: Waitlist; active: string; counts?: { review?: number } }): Child {
  return (
    <>
      {lists.length > 1 ? (
        <form method="get" class="wl-switch" data-no-busy>
          <label class="sr-only" for="wl-pick">Waitlist</label>
          <Select id="wl-pick" name="w" value={wl.id} options={lists.map((l) => ({ value: l.id, label: l.name }))} />
          <button class="btn sm" type="submit">Switch</button>
        </form>
      ) : null}
      <Tabs
        label={`${wl.name} screens`}
        active={active}
        items={SECTIONS.map(([id, label]) => ({ id, label, href: to(id, wl), count: id === 'review' && counts?.review ? counts.review : undefined }))}
      />
    </>
  );
}

/** Like the shared `renderPage`, plus the module's stylesheet. */
export async function renderPage(c: C, options: { title: string; crumbs?: Crumb[]; status?: 422 | 200 }, body: Child): Promise<Response> {
  const shell = await shellData(c);
  const flash = takeFlash(c);
  c.header('cache-control', 'no-store');
  return c.html(
    <AppShell shell={shell} path={new URL(c.req.url).pathname} title={options.title} crumbs={options.crumbs ?? [{ label: options.title }]} flash={flash} styles={STYLES}>
      {body}
    </AppShell>,
    options.status,
  );
}

/** A switch with its text beside it, so the label is visible as well as announced. */
export function Toggle(props: Parameters<typeof Switch>[0]) {
  return (
    <label class="wl-toggle">
      <Switch {...props} />
      <span>{props.label}</span>
    </label>
  );
}
