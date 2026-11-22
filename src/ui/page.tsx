/**
 * The two helpers screens call to answer a request with a full page.
 *
 *   screen.get('/', async (c) => renderPage(c, { title: 'Overview' }, <Overview />));
 *
 * `renderPage` loads the shell data (sidebar, workspace, user), picks up a pending flash message and
 * sends the HTML. `renderAuthPage` does the same for the centred sign-in style pages, with no shell.
 */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getSetting } from '../core/settings';
import { shellData } from '../core/shell-data';
import type { AppEnv } from '../env';
import { parseAppearance } from './appearance';
import type { Crumb } from './components/feedback';
import { takeFlash } from './flash';
import { AppShell, AuthLayout } from './layout';

export interface PageOptions {
  /** The page name, shown in the tab. */
  title: string;
  /** Crumbs after the workspace name. Defaults to a single crumb with `title`. */
  crumbs?: Crumb[];
  status?: ContentfulStatusCode;
  description?: string;
  /** Extra stylesheets for this page, for example a module's `/m/<id>/<id>.css`. Loaded in the head, after toolshed.css. */
  styles?: string[];
}

/** A dashboard page inside the shell. The caller has already passed `requireUser` and `requireOrg`. */
export async function renderPage(c: Context<AppEnv>, options: PageOptions, body: Child): Promise<Response> {
  const shell = await shellData(c);
  const flash = takeFlash(c);
  c.header('cache-control', 'no-store');
  return c.html(
    <AppShell shell={shell} path={new URL(c.req.url).pathname} title={options.title} description={options.description} crumbs={options.crumbs ?? [{ label: options.title }]} flash={flash} styles={options.styles}>
      {body}
    </AppShell>,
    options.status,
  );
}

export interface AuthPageOptions {
  title: string;
  /** Name above the card. Defaults to the signed-in workspace, or "Toolshed". */
  brand?: string;
  footer?: Child;
  wide?: boolean;
  status?: ContentfulStatusCode;
}

/** A centred page with no sidebar. Works without a session; uses the workspace look when there is one. */
export async function renderAuthPage(c: Context<AppEnv>, options: AuthPageOptions, body: Child): Promise<Response> {
  const org = c.get('org');
  const saved = org ? await getSetting<Record<string, string>>(c.env, org.id, 'appearance', {}) : {};
  const flash = takeFlash(c);
  c.header('cache-control', 'no-store');
  return c.html(
    <AuthLayout title={options.title} brand={options.brand ?? org?.name ?? 'Toolshed'} footer={options.footer} wide={options.wide} appearance={parseAppearance(saved)} flash={flash}>
      {body}
    </AuthLayout>,
    options.status,
  );
}
