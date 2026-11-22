/**
 * The invite page and the page for a signed-in person with no workspace.
 *
 * Opening an invite link changes nothing: mail scanners and link previews fetch it too. Joining
 * takes a form post from someone signed in as the invited address, and the only way to become
 * that is a code sent to the invited inbox.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { AppError } from '../../core/errors';
import { sameOrigin } from '../../core/guards';
import type { AppEnv } from '../../env';
import { formatDate, renderAuthPage, setFlash } from '../../ui';
import { INVITE_TTL_MS } from '../config';
import { keepAddressPrivate } from '../http';
import { findInvite, inviteExpired, openInvitesFor, type InviteRow } from '../invites';
import { InviteExpired, inviteFooter, InviteGone, InviteJoin, InviteStart, InviteWrongAccount, Welcome, type InviteFacts } from '../pages/invite';
import { acceptInvite, changeName, createWorkspace, mayCreateWorkspace, personNameSchema, switchWorkspace, workspacesOf } from '../service';
import { isRole, ROLE_HELP, ROLE_NAMES } from '../service/roles';
import { sessionFromRequest } from '../session';
import { defaultName, signOut, startCodeSignIn } from '../signin';
import { limited } from './sign-in';

type C = Context<AppEnv>;

export const inviteRoutes = new Hono<AppEnv>();

inviteRoutes.use('/invite/*', sameOrigin);
inviteRoutes.use('/welcome', sameOrigin);
inviteRoutes.use('/invite/*', async (c, next) => {
  keepAddressPrivate(c);
  await next();
});

const DAYS = Math.round(INVITE_TTL_MS / 86_400_000);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const page = (c: C, title: string, body: Parameters<typeof renderAuthPage>[2], status?: 404 | 410 | 422) =>
  renderAuthPage(c, { title, footer: inviteFooter, ...(status ? { status } : {}) }, body);

const gone = (c: C) => page(c, 'Invite', <InviteGone />, 404);
const expired = (c: C, row: InviteRow) =>
  page(c, 'Invite', <InviteExpired inviter={row.inviterName} sentOn={formatDate(Date.parse(row.createdAt))} days={DAYS} />, 410);

type Found = { state: 'ok'; row: InviteRow; facts: InviteFacts } | { state: 'expired'; row: InviteRow } | { state: 'accepted'; row: InviteRow } | { state: 'gone' };

async function look(c: C): Promise<Found> {
  const row = await findInvite(c.env, c.req.param('id') ?? '');
  if (!row || !isRole(row.role)) return { state: 'gone' };
  if (row.status === 'accepted') return { state: 'accepted', row };
  if (row.status !== 'pending') return { state: 'gone' };
  if (inviteExpired(row)) return { state: 'expired', row };
  return {
    state: 'ok',
    row,
    facts: { id: row.id, workspace: row.workspaceName, inviter: row.inviterName, role: ROLE_NAMES[row.role], roleHelp: ROLE_HELP[row.role], email: row.email },
  };
}

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The page for an invite that cannot be used. */
async function refuse(c: C, found: Exclude<Found, { state: 'ok' }>): Promise<Response> {
  if (found.state === 'expired') return expired(c, found.row);
  // Used by this very person, perhaps in another tab: they are in, so take them there.
  const user = c.get('user');
  if (found.state === 'accepted' && user && sameEmail(user.email, found.row.email)) return c.redirect('/app', 303);
  return gone(c);
}

inviteRoutes.get('/invite/:id', async (c) => {
  const found = await look(c);
  if (found.state !== 'ok') return refuse(c, found);
  const user = c.get('user');
  if (!user) return page(c, `Join ${found.facts.workspace}`, <InviteStart invite={found.facts} />);
  if (!sameEmail(user.email, found.row.email)) return page(c, 'Invite', <InviteWrongAccount invite={found.facts} current={user.email} />);
  return page(c, `Join ${found.facts.workspace}`, <InviteJoin invite={found.facts} askName={user.name === defaultName(user.email)} />);
});

/** Start proving the invited inbox: sign out anyone else, then email a code and come back here after it. */
inviteRoutes.post('/invite/:id/start', async (c) => {
  const found = await look(c);
  if (found.state !== 'ok') return refuse(c, found);
  const here = `/invite/${found.row.id}`;
  const user = c.get('user');
  if (user && sameEmail(user.email, found.row.email)) return c.redirect(here, 303);
  if (user) await signOut(c);
  const wait = await startCodeSignIn(c, found.row.email, here);
  if (wait) return limited(c, { email: found.row.email, wait, reason: 'requests', next: here });
  return c.redirect('/sign-in/code', 303);
});

inviteRoutes.post('/invite/:id', async (c) => {
  const found = await look(c);
  if (found.state !== 'ok') return refuse(c, found);
  const user = c.get('user');
  if (!user || !sameEmail(user.email, found.row.email)) return c.redirect(`/invite/${found.row.id}`, 303);

  const form = await c.req.parseBody();
  const typed = text(form.name).trim();
  const name = typed ? personNameSchema.safeParse(typed) : null;
  if (name && !name.success) {
    const error = name.error.issues[0]?.message ?? 'Enter your name.';
    return page(c, `Join ${found.facts.workspace}`, <InviteJoin invite={found.facts} askName name={typed.slice(0, 80)} error={error} />, 422);
  }
  try {
    const workspace = await acceptInvite(c, found.row.id);
    if (name?.success) await changeName(c, { name: name.data });
    setFlash(c, { kind: 'ok', message: `You joined ${workspace.name}.` });
    return c.redirect('/app', 303);
  } catch (err) {
    // The invite changed between the page and the press.
    if (err instanceof AppError && err.code === 'auth.invite_expired') return expired(c, found.row);
    if (err instanceof AppError && err.code === 'auth.invite_not_found') return gone(c);
    throw err;
  }
});

/* ---- Signed in, but in no workspace ---- */

async function welcome(c: C, user: { id: string; email: string }, form?: { name: string; error: string }): Promise<Response> {
  const [invites, canCreate] = await Promise.all([openInvitesFor(c.env, user.email), mayCreateWorkspace(c.env, user.id)]);
  return page(
    c,
    'Welcome',
    <Welcome
      email={user.email}
      canCreate={canCreate}
      invites={invites.flatMap((i) => (isRole(i.role) ? [{ id: i.id, workspace: i.workspaceName, inviter: i.inviterName, role: ROLE_NAMES[i.role] }] : []))}
      {...(form ? { name: form.name, error: form.error } : {})}
    />,
    form ? 422 : undefined,
  );
}

inviteRoutes.get('/welcome', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/sign-in?next=/welcome');
  if ((await sessionFromRequest(c))?.org) return c.redirect('/app');
  // In a workspace, but this browser points at none (the one it had open was deleted): open the first.
  const first = (await workspacesOf(c.env, user.id))[0];
  if (first) {
    await switchWorkspace(c, first.id);
    return c.redirect('/app');
  }
  return welcome(c, user);
});

inviteRoutes.post('/welcome', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/sign-in?next=/welcome', 303);
  const form = await c.req.parseBody();
  const name = text(form.name);
  try {
    const workspace = await createWorkspace(c, { name });
    setFlash(c, { kind: 'ok', message: `Created ${workspace.name}.` });
    return c.redirect('/app', 303);
  } catch (err) {
    if (err instanceof AppError && err.code === 'validation_failed') return welcome(c, user, { name: name.slice(0, 60), error: err.fields?.name ?? err.message });
    throw err;
  }
});
