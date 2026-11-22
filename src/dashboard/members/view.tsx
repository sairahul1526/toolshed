/** The page at /app/members: people, pending invites, the invite form and what each role can do. */
import type { Invite, Member } from '../../auth/service';
import { ROLE_NAMES } from '../../auth/service';
import type { EmailSetup } from '../../core/email';
import type { FieldErrors } from '../../core/errors';
import type { Role } from '../../env';
import { roleAtLeast } from '../../env';
import {
  Avatar,
  Button,
  Callout,
  Card,
  ConfirmButton,
  EmptyState,
  Field,
  FilterBar,
  IconButton,
  Icon,
  Input,
  LinkButton,
  PageHeader,
  Pill,
  SearchInput,
  Select,
  Table,
  Tabs,
  plural,
  timeAgo,
} from '../../ui';
import type { InviteValues } from './actions';
import { assignableRoles, BASE, canManage, listHref } from './data';
import type { PeoplePage, PeopleQuery, Tab } from './data';

const DAY = 86_400_000;

export interface MembersPageProps {
  tab: Tab;
  role: Role;
  now: number;
  people: PeoplePage;
  query: PeopleQuery;
  /** Everyone in the workspace, whatever the filter says. */
  everyone: number;
  /** Null for people who may not see invites. */
  invites: Invite[] | null;
  email: EmailSetup | null;
  invite: { values: InviteValues; fields: FieldErrors; message: string | null };
}

const roleOptions = (roles: Role[]) => roles.map((r) => ({ value: r, label: ROLE_NAMES[r] }));

export function MembersPage(props: MembersPageProps) {
  const { tab, role, now, people, invites, email, invite } = props;
  const admin = roleAtLeast(role, 'admin');
  const waiting = invites?.length ?? 0;
  return (
    <>
      <PageHeader
        title="Members"
        description={`${plural(props.everyone, 'person', 'people')}${waiting > 0 ? ` and ${plural(waiting, 'invite')} waiting` : ''}. Everyone signs in with a code, a passkey or a password.`}
        actions={
          admin ? (
            <LinkButton variant="primary" icon="plus" href="#invite">
              Invite people
            </LinkButton>
          ) : undefined
        }
      />
      <div class="stack">
        {admin ? <InviteCard role={role} email={email} invite={invite} /> : <Callout title="You can look but not change">Only workspace admins and owners can invite people, change roles or remove anyone.</Callout>}
        <Card flush>
          {admin ? (
            <Tabs
              label="Members and invites"
              active={tab}
              items={[
                { id: 'people', label: 'People', count: props.everyone, href: listHref({}) },
                { id: 'invites', label: 'Invites', count: waiting, href: listHref({ tab: 'invites' }) },
              ]}
            />
          ) : null}
          {tab === 'invites' && invites ? <InvitesList invites={invites} now={now} role={role} /> : <PeopleList role={role} now={now} people={people} query={props.query} everyone={props.everyone} />}
        </Card>
        <RolesCard />
      </div>
    </>
  );
}

/* ---------- Invite ---------- */

function EmailNotice({ email }: { email: EmailSetup }) {
  if (email.mode === 'live') return null;
  if (email.mode === 'dev') {
    return (
      <Callout tone="info" title="Dev mode" actions={<LinkButton size="sm" href="/dev/outbox">Open the outbox</LinkButton>}>
        Invite emails are saved to the outbox instead of being sent.
      </Callout>
    );
  }
  return (
    <Callout
      tone="warn"
      title="Email sending isn’t set up"
      actions={email.action ? <LinkButton size="sm" href={email.action.href}>{email.action.label}</LinkButton> : undefined}
    >
      Invites are still made, but nobody gets an email. After you invite someone, copy the invite link from the Invites tab and send it yourself.
    </Callout>
  );
}

function InviteCard({ role, email, invite }: { role: Role; email: EmailSetup | null; invite: MembersPageProps['invite'] }) {
  const { values, fields, message } = invite;
  return (
    <Card id="invite" title="Invite people" description="They get a link by email. It works for 7 days and only for that address.">
      <form method="post" action={`${BASE}/invite`} class="stack">
        {message ? (
          <Callout tone="bad" title="The invite wasn’t sent">
            {message}
          </Callout>
        ) : null}
        {email ? <EmailNotice email={email} /> : null}
        <div class="form-row">
          <Field id="invite-email" label="Email address" error={fields.email}>
            <Input id="invite-email" name="email" type="email" value={values.email} placeholder="name@example.com" autocomplete="off" required invalid={!!fields.email} />
          </Field>
          <Field id="invite-role" label="Role" error={fields.role}>
            <Select id="invite-role" name="role" value={values.role} options={roleOptions(assignableRoles(role))} invalid={!!fields.role} />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="primary" icon="send">
            Send invite
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ---------- People ---------- */

function TwoStep({ m }: { m: Member }) {
  const on = (m.passkeys ?? 0) > 0 || m.twoStep === true;
  return (
    <span class="row">
      {m.passkeys ? (
        <Pill tone="good">
          <Icon name="finger" />
          Passkey
        </Pill>
      ) : null}
      {m.twoStep ? <Pill tone="good">App code</Pill> : null}
      {on ? null : <Pill tone="warn">Off</Pill>}
    </span>
  );
}

function PersonCell({ m }: { m: Member }) {
  return (
    <span class="who">
      <Avatar name={m.name || m.email} src={m.image} size="sm" />
      <span class="row-text">
        <b class="trunc" title={m.name}>
          {m.name || m.email}
          {m.isYou ? <span class="muted"> (you)</span> : null}
        </b>
        <span class="trunc" title={m.email}>
          {m.email}
        </span>
      </span>
    </span>
  );
}

function RoleCell({ m, role, i }: { m: Member; role: Role; i: number }) {
  if (!canManage(role, m)) return <span class="muted">{ROLE_NAMES[m.role]}</span>;
  return (
    <form method="post" action={`${BASE}/${encodeURIComponent(m.userId)}/role`} class="row">
      <Select name="role" value={m.role} options={roleOptions(assignableRoles(role))} aria-label={`Role for ${m.name || m.email}`} id={`role-${i}`} />
      <Button type="submit" size="sm">
        Save
      </Button>
    </form>
  );
}

function ActionCell({ m, role, i }: { m: Member; role: Role; i: number }) {
  if (m.isYou) {
    return (
      <form method="post" action={`${BASE}/leave`}>
        <ConfirmButton
          id={`leave-${i}`}
          size="sm"
          icon="logout"
          title="Leave this workspace?"
          body="You lose access right away and are signed out of it on every device. Your personal API keys here stop working. Anything you made stays in the workspace. An owner has to invite you to come back."
          confirmLabel="Leave workspace"
        >
          Leave
        </ConfirmButton>
      </form>
    );
  }
  if (!canManage(role, m)) return null;
  return (
    <form method="post" action={`${BASE}/${encodeURIComponent(m.userId)}/remove`}>
      <ConfirmButton
        id={`remove-${i}`}
        size="sm"
        icon="trash"
        title={`Remove ${m.name || m.email}?`}
        body="They lose access right away and are signed out of this workspace on every device. Their personal API keys stop working and the invites they sent are cancelled. Links, forms and anything else they made stay in the workspace."
        confirmLabel="Remove"
      >
        Remove
      </ConfirmButton>
    </form>
  );
}

function PeopleList({ role, now, people, query, everyone }: { role: Role; now: number; people: PeoplePage; query: PeopleQuery; everyone: number }) {
  const admin = roleAtLeast(role, 'admin');
  const filtered = query.q !== '' || query.role !== '';
  const paged = query.after !== null;
  const columns = [
    { key: 'person', label: 'Person' },
    { key: 'role', label: 'Role' },
    ...(admin ? [{ key: 'two', label: 'Two-step', hideOnMobile: true }, { key: 'seen', label: 'Last active', hideOnMobile: true }] : []),
    { key: 'actions', label: 'Actions', srOnly: true },
  ];
  return (
    <>
      <div class="card-head">
        <FilterBar action={BASE}>
          <SearchInput name="q" label="Search members" placeholder="Search by name or email" value={query.q} />
          <Select name="role" aria-label="Filter by role" value={query.role} options={[{ value: '', label: 'All roles' }, ...roleOptions(['owner', 'admin', 'member', 'viewer'])]} />
        </FilterBar>
      </div>
      {people.rows.length === 0 ? (
        <EmptyState
          bare
          icon="search"
          title={filtered ? 'No one matches' : 'No one here yet'}
          body={filtered ? 'Try part of a name or an email address, or pick another role.' : 'This is unusual: a workspace always has an owner. Reload the page.'}
          actions={filtered ? <LinkButton href={BASE}>Clear filters</LinkButton> : undefined}
        />
      ) : (
        <Table
          caption="People in this workspace"
          columns={columns}
          rows={people.rows.map((m, i) => ({
            person: <PersonCell m={m} />,
            role: <RoleCell m={m} role={role} i={i} />,
            two: <TwoStep m={m} />,
            seen: <span class="muted">{m.lastSeenAt ? timeAgo(m.lastSeenAt, now) : '–'}</span>,
            actions: <ActionCell m={m} role={role} i={i} />,
          }))}
        />
      )}
      <div class="card-foot">
        <span class="note">{filtered ? `${plural(people.matched, 'match', 'matches')} out of ${everyone}.` : 'Roles change what a person can do the next time they open a page.'}</span>
        {paged ? <LinkButton size="sm" href={listHref({ q: query.q, role: query.role })}>Back to first page</LinkButton> : null}
        {people.next ? (
          <LinkButton size="sm" rel="next" href={listHref({ q: query.q, role: query.role, after: people.next })}>
            Next
          </LinkButton>
        ) : null}
      </div>
    </>
  );
}

/* ---------- Invites ---------- */

function Status({ invite, now }: { invite: Invite; now: number }) {
  if (invite.status === 'expired') return <Pill tone="bad">Expired</Pill>;
  const days = Math.ceil((invite.expiresAt - now) / DAY);
  return <Pill>{days <= 1 ? 'Works for less than a day' : `Works ${days} more days`}</Pill>;
}

function InviteActions({ invite, i }: { invite: Invite; i: number }) {
  return (
    <div class="row">
      <IconButton icon="copy" label={`Copy invite link for ${invite.email}`} size="sm" data-copy={invite.link} data-copied="Invite link copied." />
      <form method="post" action={`${BASE}/invites/${encodeURIComponent(invite.id)}/resend`}>
        <Button type="submit" size="sm">
          {invite.status === 'expired' ? 'Send again' : 'Resend'}
        </Button>
      </form>
      <form method="post" action={`${BASE}/invites/${encodeURIComponent(invite.id)}/cancel`}>
        <ConfirmButton
          id={`cancel-${i}`}
          size="sm"
          variant="ghost"
          title={`Cancel the invite for ${invite.email}?`}
          body="The link stops working right away. You can invite the same address again later."
          confirmLabel="Cancel invite"
        >
          Cancel
        </ConfirmButton>
      </form>
    </div>
  );
}

function InvitesList({ invites, now, role }: { invites: Invite[]; now: number; role: Role }) {
  if (invites.length === 0) {
    return (
      <EmptyState
        bare
        icon="mail"
        title="No invites waiting"
        body="When you invite someone, their invite shows here until they join. You can send it again or cancel it."
        actions={
          <LinkButton variant="primary" icon="plus" href="#invite">
            Invite people
          </LinkButton>
        }
      />
    );
  }
  return (
    <>
      <Table
        caption="Pending invites"
        columns={[
          { key: 'email', label: 'Email' },
          { key: 'role', label: 'Role' },
          { key: 'by', label: 'Sent by', hideOnMobile: true },
          { key: 'status', label: 'Status' },
          { key: 'actions', label: 'Actions', srOnly: true },
        ]}
        rows={invites.map((inv, i) => ({
          email: (
            <span class="row-text">
              <b class="trunc" title={inv.email}>
                {inv.email}
              </b>
              <span>Sent {timeAgo(inv.createdAt, now)}</span>
            </span>
          ),
          role: ROLE_NAMES[inv.role],
          by: <span class="trunc">{inv.invitedBy.name}</span>,
          status: <Status invite={inv} now={now} />,
          actions: inv.role === 'owner' && role !== 'owner' ? <span class="muted">Only an owner can manage this</span> : <InviteActions invite={inv} i={i} />,
        }))}
      />
      <div class="card-foot">
        <span class="note">Sending an invite again gives it a fresh 7 days. Inviting an address that already has an invite replaces the old one.</span>
      </div>
    </>
  );
}

/* ---------- Roles ---------- */

const CAN: [string, boolean, boolean, boolean, boolean][] = [
  ['Use the tools and see their data', true, true, true, true],
  ['Create and change things in the tools', true, true, true, false],
  ['Invite people and change roles', true, true, false, false],
  ['Switch modules on and off', true, true, false, false],
  ['Make API keys', true, true, false, false],
  ['Change appearance and email setup', true, true, false, false],
  ['Delete the workspace', true, false, false, false],
];

function Tick({ yes }: { yes: boolean }) {
  return yes ? (
    <span class="yes">
      <Icon name="check" label="Yes" />
    </span>
  ) : (
    <span class="no" aria-label="No">
      –
    </span>
  );
}

function RolesCard() {
  return (
    <Card title="What each role can do" description="The owner can do everything. An owner is the only one who can add, change or remove another owner." flush>
      <Table
        caption="What each role can do"
        columns={[{ key: 'can', label: 'Can' }, ...(['Owner', 'Admin', 'Member', 'Viewer'] as const).map((r) => ({ key: r, label: r }))]}
        rows={CAN.map(([can, ...rest]) => ({
          can,
          Owner: <Tick yes={rest[0]} />,
          Admin: <Tick yes={rest[1]} />,
          Member: <Tick yes={rest[2]} />,
          Viewer: <Tick yes={rest[3]} />,
        }))}
      />
    </Card>
  );
}
