/** Markup for the Modules screen and a module's detail page. No data loading happens here. */
import type { Child } from 'hono/jsx';
import {
  Button,
  Callout,
  Card,
  ConfirmButton,
  EmptyState,
  FilterBar,
  Icon,
  KeyValueList,
  LinkButton,
  PageHeader,
  Pill,
  SearchInput,
  Table,
  Tabs,
  formatDate,
  isIconName,
  plural,
} from '../../ui';
import type { PillTone } from '../../ui';
import {
  CATEGORY_LABEL,
  hasSampleData,
  safeHref,
  stateLabel,
  type ListQuery,
  type ModuleRow,
  type StateFilter,
  type StateLabel,
} from './data';

const TONE: Record<StateLabel, PillTone> = { On: 'good', Off: 'neutral', 'Needs setup': 'solid' };

const READ_ONLY_NOTE = 'Only workspace admins and owners can turn modules on or off. Ask an admin if you need one.';

const TURN_OFF_NOTE = 'Your data is kept. Public pages for this module stop working until you turn it back on.';

/** `/app/modules` with the search and filter the person had, so every link keeps their place. */
export function listHref({ q, filter }: ListQuery): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (filter !== 'all') params.set('filter', filter);
  const qs = params.toString();
  return qs ? `/app/modules?${qs}` : '/app/modules';
}

function iconFor(name: string): string {
  return isIconName(name) ? name : 'layers';
}

function categoryLabel(row: ModuleRow): string {
  return CATEGORY_LABEL[row.def.category] ?? row.def.category;
}

/** The sentence under the pill on a card: what is missing, or what kind of module it is. */
function cardNote(row: ModuleRow): string {
  if (row.status.status === 'needs_setup') return row.status.reason ?? 'Open it to finish setup.';
  return categoryLabel(row);
}

interface ToggleFormProps {
  row: ModuleRow;
  view: 'list' | 'detail';
  query: ListQuery;
  size?: 'md' | 'sm';
}

/** Turn a module on, or off after a question. Plain form posts, so it works without JavaScript. */
function ToggleForm({ row, view, query, size = 'sm' }: ToggleFormProps) {
  const { def, state } = row;
  return (
    <form method="post" action={`/app/modules/${def.id}/toggle`}>
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="q" value={query.q} />
      <input type="hidden" name="filter" value={query.filter} />
      {state.enabled ? (
        <ConfirmButton id={`off-${def.id}`} size={size} danger={false} title={`Turn off ${def.name}?`} body={TURN_OFF_NOTE} confirmLabel="Turn off" name="enabled" value="0">
          Turn off<span class="sr-only"> {def.name}</span>
        </ConfirmButton>
      ) : (
        <Button type="submit" variant="primary" size={size} name="enabled" value="1">
          Turn on<span class="sr-only"> {def.name}</span>
        </Button>
      )}
    </form>
  );
}

function ModuleCard({ row, canEdit, query }: { row: ModuleRow; canEdit: boolean; query: ListQuery }) {
  const label = stateLabel(row);
  const note = cardNote(row);
  return (
    <article class="card mod-card" data-id={row.def.id}>
      <div class="mc-top">
        <span class={`mod-icon${row.state.enabled ? ' ok' : ''}`}>
          <Icon name={iconFor(row.def.icon)} />
        </span>
        <h3 class="row-text">
          <b>
            <a href={`/app/modules/${row.def.id}`}>{row.def.name}</a>
          </b>
        </h3>
      </div>
      <p class="row-text">
        <span>{row.def.description}</span>
      </p>
      <div class="mc-foot">
        <Pill tone={TONE[label]}>{label}</Pill>
        <span class="trunc" title={note}>
          {note}
        </span>
        {canEdit ? (
          <>
            <span class="spacer" />
            <ToggleForm row={row} view="list" query={query} />
          </>
        ) : null}
      </div>
    </article>
  );
}

interface ListEmptyProps {
  total: number;
  query: ListQuery;
}

/** Three different "nothing here" cases, each with its own next step. */
function ListEmpty({ total, query }: ListEmptyProps) {
  if (total === 0) {
    return (
      <EmptyState
        icon="layers"
        title="No modules are installed"
        body="Modules are added when Toolshed is built and deployed. Add one, deploy again, and it shows up here for you to turn on."
        actions={
          <LinkButton variant="primary" href="/app">
            Back to overview
          </LinkButton>
        }
      />
    );
  }
  if (query.q) {
    return (
      <EmptyState
        icon="search"
        title={`No modules match “${query.q}”`}
        body="Check the spelling, or try a shorter word."
        actions={
          <LinkButton variant="primary" href={listHref({ q: '', filter: query.filter })}>
            Clear search
          </LinkButton>
        }
      />
    );
  }
  const none = query.filter === 'on' ? 'No modules are on yet' : 'Every module is on';
  const body = query.filter === 'on' ? 'Pick one from the full list and turn it on.' : 'There is nothing left to turn on.';
  return (
    <EmptyState
      icon="layers"
      title={none}
      body={body}
      actions={
        <LinkButton variant="primary" href="/app/modules">
          Show all modules
        </LinkButton>
      }
    />
  );
}

export interface ModulesPageProps {
  orgName: string;
  /** Rows after search and filter. */
  rows: ModuleRow[];
  counts: Record<StateFilter, number>;
  query: ListQuery;
  canEdit: boolean;
}

export function ModulesPage({ orgName, rows, counts, query, canEdit }: ModulesPageProps) {
  const tab = (id: StateFilter, label: string) => ({ id, label, count: counts[id], href: listHref({ q: query.q, filter: id }) });
  return (
    <>
      <PageHeader title="Modules" description={`Switch on what ${orgName} needs. Every module is free and runs on your own Cloudflare account.`} />
      {canEdit ? null : <Callout tone="info" title="You can look, not change">{READ_ONLY_NOTE}</Callout>}
      {counts.all === 0 ? (
        <ListEmpty total={0} query={query} />
      ) : (
        <>
          <Tabs label="Filter modules" active={query.filter} items={[tab('all', 'All'), tab('on', 'On'), tab('off', 'Off')]} />
          <FilterBar action="/app/modules">
            {query.filter === 'all' ? null : <input type="hidden" name="filter" value={query.filter} />}
            <SearchInput label="Search modules" placeholder="Search modules" value={query.q} maxlength={100} />
          </FilterBar>
          {rows.length === 0 ? (
            <ListEmpty total={counts.all} query={query} />
          ) : (
            <section class="grid-3" aria-label={`${plural(rows.length, 'module')}`}>
              {rows.map((row) => (
                <ModuleCard row={row} canEdit={canEdit} query={query} />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

/* ---------- detail page ---------- */

function StatusText({ row }: { row: ModuleRow }) {
  const { status, state } = row;
  if (!state.enabled) return <>Off. Nothing runs and its public pages are closed. Your data is kept, and it all comes back when you turn it on.</>;
  if (status.status === 'needs_setup') return <>{status.reason ?? 'This module needs one more setup step.'}</>;
  return <>On and ready to use.</>;
}

function SampleForm({ row }: { row: ModuleRow }) {
  const { def, state } = row;
  return (
    <form method="post" action={`/app/modules/${def.id}/sample`}>
      {state.sample ? (
        <ConfirmButton
          id={`sample-off-${def.id}`}
          danger={false}
          title="Remove the sample data?"
          body={`Only the sample rows ${def.name} added are removed. Anything you created yourself stays.`}
          confirmLabel="Remove sample data"
          name="sample"
          value="0"
        >
          Remove sample data
        </ConfirmButton>
      ) : (
        <Button type="submit" name="sample" value="1" disabled={!state.enabled}>
          Add sample data
        </Button>
      )}
    </form>
  );
}

const code = (text: string): Child => <code class="mono">{text}</code>;

export interface ModuleDetailProps {
  row: ModuleRow;
  canEdit: boolean;
}

export function ModuleDetail({ row, canEdit }: ModuleDetailProps) {
  const { def, state, status } = row;
  const label = stateLabel(row);
  const query: ListQuery = { q: '', filter: 'all' };
  const actionHref = status.status === 'needs_setup' && status.action ? safeHref(status.action.href) : null;
  const prefixes = def.publicPrefixes ?? [];
  const scopes = def.permissions ?? [];

  const facts: { label: string; value: Child }[] = [
    { label: 'Category', value: categoryLabel(row) },
    { label: 'Version', value: def.version },
    { label: 'Turned on', value: state.enabledAt ? formatDate(state.enabledAt) : 'Not yet' },
    { label: 'Dashboard', value: def.dashboard ? code(`/app/${def.id}`) : 'None' },
    { label: 'Public pages', value: prefixes.length ? <span class="row">{prefixes.map((p) => code(`${p}`))}</span> : 'None' },
    { label: 'API', value: def.api ? code(`/api/v1/${def.id}`) : 'None' },
  ];

  return (
    <>
      <PageHeader
        title={def.name}
        description={def.description}
        actions={
          <>
            <LinkButton href="/app/modules" icon="left">
              All modules
            </LinkButton>
            {state.enabled && def.dashboard ? (
              <LinkButton variant="primary" href={`/app/${def.id}`}>
                Open {def.name}
              </LinkButton>
            ) : null}
          </>
        }
      />
      {canEdit ? null : <Callout tone="info" title="You can look, not change">{READ_ONLY_NOTE}</Callout>}

      <Card
        title="Status"
        ruled
        actions={<Pill tone={TONE[label]}>{label}</Pill>}
        footer={
          canEdit ? (
            <>
              <span class="note">{state.enabled ? TURN_OFF_NOTE : 'Turning it on shows it in the sidebar. It takes a second.'}</span>
              <ToggleForm row={row} view="detail" query={query} size="md" />
            </>
          ) : undefined
        }
      >
        <p class="row-text">
          <span>
            <StatusText row={row} />
          </span>
        </p>
        {actionHref && status.status === 'needs_setup' && status.action ? (
          <div class="row">
            <LinkButton variant="primary" href={actionHref}>
              {status.action.label}
            </LinkButton>
          </div>
        ) : null}
      </Card>

      <Card title="About this module" ruled>
        <KeyValueList items={facts} />
      </Card>

      <Card title="Permissions for API keys" description="Scopes you can give an API key to let it use this module." ruled flush={scopes.length > 0}>
        {scopes.length === 0 ? (
          <p class="muted">This module has no API permissions of its own.</p>
        ) : (
          <Table
            caption={`API permissions for ${def.name}`}
            columns={[
              { key: 'scope', label: 'Permission' },
              { key: 'label', label: 'What it allows' },
            ]}
            rows={scopes.map((s) => ({ scope: code(s.scope), label: s.label }))}
          />
        )}
      </Card>

      {hasSampleData(def) ? (
        <Card
          title="Sample data"
          ruled
          footer={
            canEdit ? (
              <>
                <span class="note">{state.enabled ? 'Sample rows are marked, so removing them never touches your own data.' : 'Turn the module on to add sample data.'}</span>
                <SampleForm row={row} />
              </>
            ) : undefined
          }
        >
          <p class="muted">{state.sample ? `${def.name} is showing sample data.` : `Fill ${def.name} with believable examples so you can look around before adding your own.`}</p>
        </Card>
      ) : null}

      {def.onboarding ? (
        <Card title="Good first step" ruled>
          <p class="row-text">
            <span>
              <b>{def.onboarding.title}</b>
              <br />
              {def.onboarding.body}
            </span>
          </p>
        </Card>
      ) : null}
    </>
  );
}
