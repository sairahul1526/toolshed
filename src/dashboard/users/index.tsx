/**
 * Users (/app/users): the owner of the install looks at every account and workspace, bans or
 * deletes people, signs in as someone to help them, and renames or deletes any workspace.
 *
 * Everything is done by `auth/service` (`admin.ts`). It checks ownership against the database,
 * refuses what a "sign in as" session may not do and writes the audit entries, so this file only
 * turns forms into calls and refusals into messages. The one route that is not owner-only is
 * "stop signing in as": while it is active the browser is the other person's.
 */
import { Hono, type Context } from 'hono';
import {
  banUser,
  deleteAnyWorkspace,
  deleteUser,
  getUser,
  listAllWorkspaces,
  listUsers,
  renameAnyWorkspace,
  startImpersonation,
  stopImpersonation,
  unbanUser,
} from '../../auth/service';
import { findWorkspace } from '../../auth/workspace-store';
import { AppError, errors } from '../../core/errors';
import { requireInstanceOwner } from '../../core/guards';
import type { AppEnv } from '../../env';
import { renderPage, setFlash } from '../../ui';
import { BASE, clip, readListState, userHref, workspaceHref } from './data';
import { ListPage } from './list-view';
import { emptyForms, UserPage, type UserForms } from './user-view';
import { WorkspacePage, workspaceForms, type WorkspaceForms } from './workspace-view';

const PAGE_SIZE = 50;

const screen = new Hono<AppEnv>();

/* ---------- Stop signing in as someone (open to the person being signed in as) ---------- */

screen.post('/impersonation/stop', async (c) => {
  const { signedOut } = await stopImpersonation(c);
  if (signedOut) return c.redirect('/sign-in', 303);
  setFlash(c, { kind: 'ok', message: 'You’re back in your own account.' });
  return c.redirect(BASE, 303);
});

screen.use('*', requireInstanceOwner);

/* ---------- Helpers ---------- */

/**
 * Runs an action. A refusal the person can act on (sole owner, sign in again, banned account)
 * becomes a message on `back`; a form problem goes to `onFields` to show next to the field.
 */
async function attempt(
  c: Context<AppEnv>,
  back: string,
  run: () => Promise<string>,
  onFields: (fields: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  try {
    return c.redirect(await run(), 303);
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500 || err.status === 401) throw err;
    if (err.code === 'validation_failed' && err.fields) return onFields(err.fields);
    setFlash(c, { kind: 'error', message: err.message });
    return c.redirect(back, 303);
  }
}

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

const nameOf = (u: { name: string; email: string }) => clip(u.name || u.email, 60);

/* ---------- The list ---------- */

screen.get('/', async (c) => {
  const state = readListState(new URL(c.req.url).searchParams);
  const now = Date.now();
  const input = { query: state.q, cursor: state.after || null, limit: PAGE_SIZE };
  const [people, workspaces] = await Promise.all([
    state.tab === 'people' ? listUsers(c, input, now) : undefined,
    state.tab === 'workspaces' ? listAllWorkspaces(c, input) : undefined,
  ]);
  return renderPage(c, { title: 'Users', crumbs: [{ label: 'Owner' }, { label: 'Users' }] }, <ListPage state={state} now={now} people={people} workspaces={workspaces} />);
});

/* ---------- Workspaces ---------- */

async function showWorkspace(c: Context<AppEnv>, forms?: WorkspaceForms, status?: 422): Promise<Response> {
  const workspace = await findWorkspace(c.env, c.req.param('id') ?? '');
  if (!workspace) throw errors.not_found('We couldn’t find that workspace. It may have been deleted.');
  return renderPage(
    c,
    { title: workspace.name, crumbs: [{ label: 'Owner' }, { label: 'Users', href: BASE }, { label: clip(workspace.name, 40) }], ...(status ? { status } : {}) },
    <WorkspacePage workspace={workspace} forms={forms ?? workspaceForms(workspace)} />,
  );
}

screen.get('/workspaces/:id', (c) => showWorkspace(c));

screen.post('/workspaces/:id/rename', async (c) => {
  const id = c.req.param('id');
  const { name = '', slug = '' } = await form(c);
  return attempt(
    c,
    workspaceHref(id),
    async () => {
      const saved = await renameAnyWorkspace(c, id, { name, slug });
      setFlash(c, { kind: 'ok', message: `Saved. The workspace is now ${clip(saved.name, 60)}.` });
      return workspaceHref(saved.id);
    },
    (errs) => showWorkspace(c, { name, slug, deleteConfirm: '', errors: errs }, 422),
  );
});

screen.post('/workspaces/:id/delete', async (c) => {
  const id = c.req.param('id');
  const { confirm = '' } = await form(c);
  const workspace = await findWorkspace(c.env, id);
  return attempt(
    c,
    workspaceHref(id),
    async () => {
      await deleteAnyWorkspace(c, id, { confirm });
      setFlash(c, { kind: 'ok', message: `Deleted ${clip(workspace?.name ?? 'the workspace', 60)} and everything in it.` });
      return `${BASE}?tab=workspaces`;
    },
    (errs) => showWorkspace(c, { ...workspaceForms(workspace ?? { id, name: '', slug: '', createdAt: '' }), deleteConfirm: confirm, errors: errs }, 422),
  );
});

/* ---------- One person ---------- */

async function showUser(c: Context<AppEnv>, forms: UserForms = emptyForms(), status?: 422): Promise<Response> {
  const now = Date.now();
  const user = await getUser(c, c.req.param('id') ?? '', now);
  return renderPage(
    c,
    { title: nameOf(user), crumbs: [{ label: 'Owner' }, { label: 'Users', href: BASE }, { label: clip(user.name || user.email, 40) }], ...(status ? { status } : {}) },
    <UserPage user={user} now={now} forms={forms} />,
  );
}

screen.get('/:id', (c) => showUser(c));

screen.post('/:id/ban', async (c) => {
  const id = c.req.param('id');
  const { reason = '', days = '' } = await form(c);
  return attempt(
    c,
    userHref(id),
    async () => {
      await banUser(c, id, { reason, days: days === '' ? null : Number(days) });
      const user = await getUser(c, id);
      setFlash(c, { kind: 'ok', message: `${nameOf(user)} is banned and signed out everywhere.` });
      return userHref(id);
    },
    (errs) => showUser(c, { ...emptyForms(), banReason: reason, banDays: days, errors: errs }, 422),
  );
});

screen.post('/:id/unban', (c) => {
  const id = c.req.param('id');
  return attempt(
    c,
    userHref(id),
    async () => {
      await unbanUser(c, id);
      setFlash(c, { kind: 'ok', message: 'The ban is lifted. They can sign in again.' });
      return userHref(id);
    },
    async () => c.redirect(userHref(id), 303),
  );
});

screen.post('/:id/delete', async (c) => {
  const id = c.req.param('id');
  const { confirm = '' } = await form(c);
  const before = await getUser(c, id);
  return attempt(
    c,
    userHref(id),
    async () => {
      await deleteUser(c, id, { confirm });
      setFlash(c, { kind: 'ok', message: `Deleted the account of ${clip(before.email, 80)}.` });
      return BASE;
    },
    (errs) => showUser(c, { ...emptyForms(), deleteConfirm: confirm, errors: errs }, 422),
  );
});

screen.post('/:id/sign-in-as', (c) => {
  const id = c.req.param('id');
  return attempt(
    c,
    userHref(id),
    async () => {
      const session = await startImpersonation(c, id);
      setFlash(c, { kind: 'info', message: `You’re signed in as ${clip(session.user.name || session.user.email, 60)}. Every action is logged under your name.` });
      return '/app';
    },
    async () => c.redirect(userHref(id), 303),
  );
});

export default screen;
