import type { AuditRecord, AuditRetention } from '../../core/audit';
import type { FieldErrors } from '../../core/errors';
import { Avatar, Button, Callout, Card, EmptyState, Icon, Input, LinkButton, PageHeader, Section, SearchInput, Segmented, Table, formatNumber, plural, timeAgo, formatDateTime } from '../../ui';
import { EntryDetails, actorKind, actorName, clip } from './details';
import { isFiltered, logHref, type FilterState } from './filters';
import { actionMenuName, categoryOf, describeAction } from './labels';

export interface Menus {
  actions: string[];
  actors: { id: string; label: string }[];
}

export interface LogViewProps {
  now: number;
  state: FilterState;
  errors: FieldErrors;
  /** Null when the filters are not valid, so there is nothing to list. */
  items: AuditRecord[] | null;
  nextCursor: string | null;
  menus: Menus;
  exportLimit: number;
  retention: AuditRetention;
  retentionError?: string;
  canChangeRetention: boolean;
  isInstanceOwner: boolean;
}

const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
  { value: 'forever', label: 'Forever' },
];

export const retentionText = (r: AuditRetention) => (r === 'forever' ? 'forever' : r === 365 ? '1 year' : `${r} days`);

function ActionSelect({ value, actions }: { value: string; actions: string[] }) {
  const all = value && !actions.includes(value) ? [...actions, value] : actions;
  const groups = new Map<string, string[]>();
  for (const action of all) {
    const category = categoryOf(action);
    groups.set(category, [...(groups.get(category) ?? []), action]);
  }
  return (
    <select class="input" name="action" aria-label="Action">
      <option value="" selected={value === ''}>
        Any action
      </option>
      {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([category, list]) => (
        <optgroup label={category}>
          {list.map((action) => (
            <option value={action} selected={action === value}>
              {actionMenuName(action)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Filters({ state, errors, menus, isInstanceOwner }: Pick<LogViewProps, 'state' | 'errors' | 'menus' | 'isInstanceOwner'>) {
  const actors = state.actor && !menus.actors.some((a) => a.id === state.actor) ? [...menus.actors, { id: state.actor, label: state.actor }] : menus.actors;
  return (
    <form class="toolbar" method="get" action="/app/audit-log" role="search">
      <SearchInput label="Search the audit log" placeholder="Search the log" value={state.q} aria-invalid={errors.q ? 'true' : undefined} />
      <select class="input" name="actor" aria-label="Person">
        <option value="" selected={state.actor === ''}>
          Everyone
        </option>
        {actors.map((a) => (
          <option value={a.id} selected={a.id === state.actor}>
            {clip(a.label, 60)}
          </option>
        ))}
      </select>
      <ActionSelect value={state.action} actions={menus.actions} />
      <div class="input-group">
        <span class="addon">From</span>
        <Input type="date" name="from" value={state.from} aria-label="From date, UTC" invalid={Boolean(errors.from)} />
      </div>
      <div class="input-group">
        <span class="addon">To</span>
        <Input type="date" name="to" value={state.to} aria-label="To date, UTC" invalid={Boolean(errors.to)} />
      </div>
      {isInstanceOwner ? (
        <select class="input" name="scope" aria-label="Which entries">
          <option value="workspace" selected={state.scope === 'workspace'}>
            This workspace
          </option>
          <option value="all" selected={state.scope === 'all'}>
            Whole install
          </option>
        </select>
      ) : null}
      <button class="btn sm" type="submit">
        Apply
      </button>
      {isFiltered(state) ? (
        <a class="btn sm ghost" href={logHref({ ...state, actor: '', action: '', q: '', from: '', to: '' })}>
          Clear filters
        </a>
      ) : null}
    </form>
  );
}

function buildRows(items: AuditRecord[], now: number, showWorkspace: boolean) {
  return items.map((r) => {
    const kind = actorKind(r);
    const name = actorName(r);
    const { text, known } = describeAction(r.action, r.targetId);
    const iso = new Date(r.at).toISOString();
    const note = r.summary && r.summary !== text ? r.summary : null;
    return {
      when: (
        <time datetime={iso} title={formatDateTime(r.at)}>
          {timeAgo(r.at, now)}
        </time>
      ),
      who: (
        <span class="who">
          <Avatar name={name} size="sm" />
          <span class="row-text" title={name}>
            <b>{clip(name, 20)}</b>
            {kind ? <span>{kind}</span> : null}
          </span>
        </span>
      ),
      what: (
        <>
          <span class="row-text">
            <b class={known ? undefined : 'mono'}>{text}</b>
            {note ? <span>{clip(note, 160)}</span> : null}
          </span>
          <details>
            <summary>Details</summary>
            <EntryDetails record={r} showWorkspace={showWorkspace} />
          </details>
        </>
      ),
      target:
        r.targetType || r.targetId ? (
          <span class="row-text">
            {r.targetId ? <b class="mono" title={r.targetId}>{clip(r.targetId, 16)}</b> : null}
            {r.targetType ? <span title={r.targetType}>{clip(r.targetType, 16)}</span> : null}
          </span>
        ) : (
          <span class="muted">None</span>
        ),
      from: r.ip ? <span class="mono" title={r.ip}>{clip(r.ip, 20)}</span> : <span class="muted">Not recorded</span>,
    };
  });
}

function Empty({ state, filtered }: { state: FilterState; filtered: boolean }) {
  if (filtered || state.before) {
    return (
      <EmptyState
        bare
        icon="list"
        title="Nothing matches"
        body="No entries fit these filters. Try another person, action or date range."
        actions={
          <LinkButton href={logHref({ ...state, actor: '', action: '', q: '', from: '', to: '' })}>Clear filters</LinkButton>
        }
      />
    );
  }
  return (
    <EmptyState
      bare
      icon="list"
      title="Nothing has been recorded yet"
      body="Sign-ins, invites, key changes and settings changes show up here as they happen."
      actions={<LinkButton href="/app">Go to the overview</LinkButton>}
    />
  );
}

export function LogView(props: LogViewProps) {
  const { state, errors, items, nextCursor, menus, now } = props;
  const filtered = isFiltered(state);
  const problems = Object.values(errors);
  const exportHref = logHref(state, {}, '/app/audit-log/export.csv');
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, and when. Nobody can edit or delete entries, including you."
        actions={
          problems.length === 0 ? (
            <LinkButton icon="download" href={exportHref}>
              Export CSV
            </LinkButton>
          ) : null
        }
      />
      {problems.length > 0 ? (
        <Callout tone="bad" title="Those filters need fixing">
          {problems.join(' ')}
        </Callout>
      ) : null}
      <Card flush>
        <Filters state={state} errors={errors} menus={menus} isInstanceOwner={props.isInstanceOwner} />
        {items ? (
          <Table
            caption="Audit log entries, newest first"
            columns={[
              { key: 'when', label: 'When' },
              { key: 'who', label: 'Who' },
              { key: 'what', label: 'What happened' },
              { key: 'target', label: 'Target', hideOnMobile: true },
              { key: 'from', label: 'IP address', hideOnMobile: true },
            ]}
            rows={buildRows(items, now, state.scope === 'all')}
            empty={<Empty state={state} filtered={filtered} />}
          />
        ) : null}
        {items && items.length > 0 ? (
          <nav class="pagination" aria-label="Pages of entries">
            <span class="muted">
              {state.before ? 'Older entries: ' : 'Newest entries: '}
              {plural(items.length, 'entry', 'entries')} shown
            </span>
            <span class="row">
              {state.before ? (
                <a class="btn sm" href={logHref(state)}>
                  <Icon name="left" />
                  Back to newest
                </a>
              ) : null}
              {nextCursor ? (
                <a class="btn sm" href={logHref(state, { before: nextCursor })} rel="next">
                  Load older entries
                  <Icon name="right" />
                </a>
              ) : (
                <span class="muted">That is everything.</span>
              )}
            </span>
          </nav>
        ) : null}
      </Card>
      <p class="hint">
        Export CSV saves every entry that matches the filters, newest first, up to {formatNumber(props.exportLimit)}. Times are in UTC.
      </p>
      <Retention {...props} />
    </>
  );
}

function Retention({ retention, retentionError, canChangeRetention }: LogViewProps) {
  return (
    <Section title="Keep entries for" description="Older ones are deleted each night. Longer means a bigger database.">
      <Card>
        {canChangeRetention ? (
          <form class="form" method="post" action="/app/audit-log/retention">
            <Segmented name="retention" label="Keep entries for" value={String(retention)} options={RETENTION_OPTIONS} />
            {retentionError ? (
              <p class="err-text" role="alert">
                {retentionError}
              </p>
            ) : null}
            <p class="hint">Takes effect at the next nightly cleanup. Saving it is added to the audit log.</p>
            <div>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        ) : (
          <p>
            Entries are kept for <b>{retentionText(retention)}</b>. Only the owner of this install can change that.
          </p>
        )}
      </Card>
    </Section>
  );
}
