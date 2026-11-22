/**
 * Members (/app/members): who is in the workspace, their roles, invites, and leaving.
 *
 * A thin front for the member and invite services in `auth/service`. They check the role, apply
 * the rules (last owner, only an owner touches an owner, no changes while signed in as someone
 * else) and write the audit entry. This screen turns each refusal into a message on the page.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ROLE_NAMES, cancelInvite, changeMemberRole, inviteMember, leaveWorkspace, listInvites, listMembers, removeMember, resendInvite } from '../../auth/service';
import { emailStatus } from '../../core/email';
import type { FieldErrors } from '../../core/errors';
import { errors } from '../../core/errors';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { renderPage, setFlash } from '../../ui';
import { inviteFailure, inviteFlash, readInvite, refusalFlash, short, textField } from './actions';
import type { InviteValues } from './actions';
import { BASE, listHref, pageOfPeople, readQuery } from './data';
import type { Tab } from './data';
import { MembersPage } from './view';

const screen = new Hono<AppEnv>();

interface Init {
  invite?: { values: InviteValues; fields: FieldErrors; message: string | null };
  status?: 403 | 404 | 409 | 422 | 429;
}

async function render(c: Context<AppEnv>, init: Init = {}) {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  const admin = roleAtLeast(org.role, 'admin');
  const now = Date.now();
  const [members, invites, email] = await Promise.all([listMembers(c), admin ? listInvites(c, now) : null, admin ? emailStatus(c.env) : null]);
  const query = readQuery((name) => c.req.query(name));
  // Someone who can't see invites asking for that tab, or a failed invite, gets a page that makes sense.
  const tab: Tab = admin && c.req.query('tab') === 'invites' && !init.invite ? 'invites' : 'people';
  return renderPage(
    c,
    { title: 'Members', crumbs: [{ label: 'Workspace' }, { label: 'Members' }], status: init.status },
    <MembersPage
      tab={tab}
      role={org.role}
      now={now}
      people={pageOfPeople(members, query)}
      query={query}
      everyone={members.length}
      invites={invites}
      email={email}
      invite={init.invite ?? { values: { email: '', role: 'member' }, fields: {}, message: null }}
    />,
  );
}

screen.get('/', (c) => render(c));

/** Run a change; a refusal becomes a message on the page it came from, anything else is a real error. */
async function change(c: Context<AppEnv>, to: string, work: () => Promise<{ kind: 'ok' | 'info' | 'error'; message: string }>) {
  try {
    setFlash(c, await work());
  } catch (err) {
    const flash = refusalFlash(err);
    if (!flash) throw err;
    setFlash(c, flash);
  }
  return c.redirect(to, 303);
}

screen.post('/invite', async (c) => {
  const values = readInvite(await c.req.parseBody());
  try {
    const sent = await inviteMember(c, values);
    setFlash(c, inviteFlash(sent.emailStatus, sent.email, 'sent'));
    return c.redirect(listHref({ tab: 'invites' }), 303);
  } catch (err) {
    const failure = inviteFailure(err);
    if (!failure) throw err;
    return render(c, { invite: { values, fields: failure.fields, message: failure.message }, status: failure.status });
  }
});

screen.post('/invites/:id/resend', (c) =>
  change(c, listHref({ tab: 'invites' }), async () => {
    const sent = await resendInvite(c, c.req.param('id'));
    return inviteFlash(sent.emailStatus, sent.email, 'sent again');
  }),
);

screen.post('/invites/:id/cancel', (c) =>
  change(c, listHref({ tab: 'invites' }), async () => {
    await cancelInvite(c, c.req.param('id'));
    return { kind: 'ok', message: 'Invite cancelled. Its link stops working now.' };
  }),
);

screen.post('/leave', (c) =>
  change(c, '/app', async () => {
    await leaveWorkspace(c);
    return { kind: 'ok', message: 'You left the workspace.' };
  }),
);

screen.post('/:userId/role', async (c) => {
  const userId = c.req.param('userId');
  const role = textField(await c.req.parseBody(), 'role');
  return change(c, BASE, async () => {
    const done = await changeMemberRole(c, userId, role);
    const who = (await listMembers(c)).find((m) => m.userId === userId);
    const name = short(who?.name || who?.email || 'That person');
    return { kind: 'ok', message: done.changed ? `${name} is now ${ROLE_NAMES[done.role]}.` : `${name} already has that role, so nothing changed.` };
  });
});

screen.post('/:userId/remove', (c) => {
  const userId = c.req.param('userId');
  return change(c, BASE, async () => {
    const who = (await listMembers(c)).find((m) => m.userId === userId);
    await removeMember(c, userId);
    return { kind: 'ok', message: `${short(who?.name || who?.email || 'That person')} was removed and signed out of this workspace.` };
  });
});

export default screen;
