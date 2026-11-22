/** The list page: everyone with an account, and a second tab with every workspace. */
import type { AdminUser, AdminWorkspace, Page } from '../../auth/service';
import { Avatar, Card, EmptyState, FilterBar, formatDate, LinkButton, PageHeader, Pill, plural, SearchInput, Table, Tabs, timeAgo } from '../../ui';
import { clip, listHref, userHref, workspaceHref, type ListState } from './data';

interface ListProps {
  state: ListState;
  now: number;
}

function Pager({ state, next }: { state: ListState; next: string | null }) {
  return (
    <>
      {state.after ? (
        <LinkButton size="sm" href={listHref(state, { after: '' })}>
          Back to first page
        </LinkButton>
      ) : null}
      {next ? (
        <LinkButton size="sm" href={listHref(state, { after: next })} rel="next">
          Next
        </LinkButton>
      ) : null}
    </>
  );
}

function Search({ state }: { state: ListState }) {
  const people = state.tab === 'people';
  return (
    <FilterBar action="/app/users">
      {people ? null : <input type="hidden" name="tab" value="workspaces" />}
      <SearchInput label={people ? 'Search people' : 'Search workspaces'} placeholder={people ? 'Search name, email or username' : 'Search name or short name'} value={state.q} />
      {state.q ? (
        <a class="btn sm ghost" href={listHref(state, { q: '', after: '' })}>
          Clear search
        </a>
      ) : null}
    </FilterBar>
  );
}

function StatusPill({ user }: { user: AdminUser }) {
  if (user.banned) return <Pill tone="bad">Banned</Pill>;
  return <Pill tone="good">Active</Pill>;
}

function Security({ user }: { user: AdminUser }) {
  const parts = [user.passkeys > 0 ? plural(user.passkeys, 'passkey') : null, user.twoStep ? 'Two-step on' : null].filter(Boolean);
  return parts.length ? <span>{parts.join(', ')}</span> : <span class="muted">None</span>;
}

export function PeopleList({ state, now, page }: ListProps & { page: Page<AdminUser> }) {
  if (page.items.length === 0) {
    return (
      <EmptyState
        icon={state.q ? 'search' : 'users'}
        title={state.q ? 'No one matches that' : 'No one here yet'}
        body={state.q ? 'No name, email or username has that text in it. Check the spelling or search for less.' : 'People show up here as soon as they make an account.'}
        actions={state.q ? <LinkButton href={listHref(state, { q: '', after: '' })}>Clear search</LinkButton> : undefined}
      />
    );
  }
  const rows = page.items.map((u) => ({
    person: (
      <span class="who">
        <Avatar name={u.name || u.email} src={u.image} size="sm" />
        <span class="row-text">
          <a class="trunc" href={userHref(u.id)} title={u.name}>
            <b>{clip(u.name || u.email, 40)}</b>
          </a>
          <span class="trunc" title={u.email}>
            {clip(u.email, 48)}
          </span>
        </span>
      </span>
    ),
    workspaces: u.workspaces === 0 ? <span class="muted">None</span> : plural(u.workspaces, 'workspace'),
    security: <Security user={u} />,
    seen: u.lastSeenAt ? <time datetime={new Date(u.lastSeenAt).toISOString()}>{timeAgo(u.lastSeenAt, now)}</time> : <span class="muted">Not signed in</span>,
    status: (
      <span class="row">
        <StatusPill user={u} />
        {u.isInstanceOwner ? <Pill>{u.isYou ? 'You, owner' : 'Owner'}</Pill> : null}
      </span>
    ),
  }));
  return (
    <Card
      title="People"
      description={`${plural(page.items.length, 'person', 'people')} on this page, newest first`}
      flush
      footer={
        <>
          <span class="muted">Open a person to see their workspaces and manage their account.</span>
          <span class="spacer" />
          <Pager state={state} next={page.nextCursor} />
        </>
      }
    >
      <Table
        caption="People with an account"
        columns={[
          { key: 'person', label: 'Person' },
          { key: 'workspaces', label: 'Workspaces', hideOnMobile: true },
          { key: 'security', label: 'Security', hideOnMobile: true },
          { key: 'seen', label: 'Last seen' },
          { key: 'status', label: 'Status' },
        ]}
        rows={rows}
      />
    </Card>
  );
}

export function WorkspaceList({ state, page }: ListProps & { page: Page<AdminWorkspace> }) {
  if (page.items.length === 0) {
    return (
      <EmptyState
        icon={state.q ? 'search' : 'shed'}
        title={state.q ? 'No workspace matches that' : 'No workspaces yet'}
        body={state.q ? 'No workspace name or short name has that text in it.' : 'Workspaces appear here once someone makes one.'}
        actions={state.q ? <LinkButton href={listHref(state, { q: '', after: '' })}>Clear search</LinkButton> : undefined}
      />
    );
  }
  const rows = page.items.map((w) => ({
    workspace: (
      <span class="row-text">
        <a class="trunc" href={workspaceHref(w.id)} title={w.name}>
          <b>{clip(w.name, 40)}</b>
        </a>
        <span class="mono trunc" title={w.slug}>
          {clip(w.slug, 40)}
        </span>
      </span>
    ),
    owner:
      w.owners.length === 0 ? (
        <span class="muted">No owner</span>
      ) : (
        <span class="row-text">
          <span class="trunc" title={w.owners.join(', ')}>
            {clip(w.owners[0] ?? '', 40)}
          </span>
          {w.owners.length > 1 ? <span class="muted">and {w.owners.length - 1} more</span> : null}
        </span>
      ),
    people: plural(w.members, 'person', 'people'),
    made: <span class="muted">{formatDate(w.createdAt)}</span>,
  }));
  return (
    <Card
      title="Workspaces"
      description={`${plural(page.items.length, 'workspace')} on this page, newest first`}
      flush
      footer={
        <>
          <span class="muted">Open a workspace to rename it or delete it.</span>
          <span class="spacer" />
          <Pager state={state} next={page.nextCursor} />
        </>
      }
    >
      <Table
        caption="Workspaces on this install"
        columns={[
          { key: 'workspace', label: 'Workspace' },
          { key: 'owner', label: 'Owner' },
          { key: 'people', label: 'People', hideOnMobile: true },
          { key: 'made', label: 'Made', hideOnMobile: true },
        ]}
        rows={rows}
      />
    </Card>
  );
}

export function ListPage(props: { state: ListState; now: number; people?: Page<AdminUser>; workspaces?: Page<AdminWorkspace> }) {
  const { state, now } = props;
  return (
    <>
      <PageHeader title="Users" description="Everyone with an account on this Toolshed, across all workspaces. Only you, the owner, can see this page." />
      <div class="stack">
        <Tabs
          label="Users and workspaces"
          active={state.tab}
          items={[
            { id: 'people', label: 'People', href: listHref(state, { tab: 'people', q: '', after: '' }) },
            { id: 'workspaces', label: 'Workspaces', href: listHref(state, { tab: 'workspaces', q: '', after: '' }) },
          ]}
        />
        <Search state={state} />
        {props.people ? <PeopleList state={state} now={now} page={props.people} /> : null}
        {props.workspaces ? <WorkspaceList state={state} now={now} page={props.workspaces} /> : null}
      </div>
    </>
  );
}
