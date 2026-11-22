import type { Child } from 'hono/jsx';
import { Button, Card, EmptyState, Icon, LinkButton, PageHeader, Tabs } from '../../ui';
import { formatDateTime, timeAgo } from '../../ui/format';
import type { Filter, Row } from './data';
import { sitePath } from './links';

/** One icon per kind of notification. Kinds are free text set by whoever sends it, so anything else gets the bell. */
const ICONS: Record<string, string> = {
  export: 'download',
  email: 'mail',
  update: 'refresh',
  security: 'shieldcheck',
  error: 'alert',
  warning: 'alert',
  info: 'info',
};

export function kindIcon(kind: string): string {
  return ICONS[kind] ?? 'bell';
}

function ReadForm({ action, next, children }: { action: string; next: string; children: Child }) {
  return (
    <form method="post" action={action}>
      <input type="hidden" name="next" value={next} />
      {children}
    </form>
  );
}

function Item({ row, next }: { row: Row; next: string }) {
  const link = sitePath(row.href);
  return (
    <li class={row.read ? 'is-read' : 'unread'}>
      <span class="tile">
        <Icon name={kindIcon(row.kind)} />
      </span>
      <span class="row-text">
        <b>
          {row.read ? null : <span class="sr-only">Unread: </span>}
          {row.title}
        </b>
        {row.body ? <span>{row.body}</span> : null}
        <span>
          <time datetime={new Date(row.at).toISOString()} title={formatDateTime(row.at)}>
            {timeAgo(row.at)}
          </time>
          {row.read ? null : ' · New'}
        </span>
      </span>
      <span class="note-actions">
        {link ? (
          <a class="btn sm" href={`/app/notifications/${encodeURIComponent(row.id)}/open`}>
            Open
          </a>
        ) : null}
        {row.read ? null : (
          <ReadForm action={`/app/notifications/${encodeURIComponent(row.id)}/read`} next={next}>
            <Button type="submit" size="sm" icon="check">
              Mark as read
            </Button>
          </ReadForm>
        )}
      </span>
    </li>
  );
}

export interface ListProps {
  rows: Row[];
  filter: Filter;
  unread: number;
  /** Cursor for the next (older) page, when there is one. */
  next: string | null;
  /** True when this is not the newest page. */
  later: boolean;
  /** This page's own path and query, so forms can bring the person back to it. */
  here: string;
}

function filterHref(filter: Filter): string {
  return filter === 'unread' ? '/app/notifications?filter=unread' : '/app/notifications';
}

export function NotificationList({ rows, filter, unread, next, later, here }: ListProps) {
  const empty = rows.length === 0 && !later;
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Updates, finished exports and warnings for you. Each person keeps their own read marks."
        actions={
          unread > 0 ? (
            <ReadForm action="/app/notifications/read-all" next={here}>
              <Button type="submit" icon="check">
                Mark all as read
              </Button>
            </ReadForm>
          ) : null
        }
      />
      <Tabs
        label="Show"
        active={filter}
        items={[
          { id: 'all', label: 'All', href: filterHref('all') },
          { id: 'unread', label: 'Unread', count: unread, href: filterHref('unread') },
        ]}
      />
      {empty ? (
        filter === 'unread' ? (
          <EmptyState
            icon="check"
            title="Nothing unread"
            body="You have read everything. Show all to look back at older notifications."
            actions={
              <LinkButton href={filterHref('all')} variant="primary">
                Show all
              </LinkButton>
            }
          />
        ) : (
          <EmptyState icon="bell" title="You are all caught up" body="Nothing has come in yet. Updates, finished exports and warnings will show up here and in the bell at the top." />
        )
      ) : (
        <Card flush>
          <ul class="rows note-list" aria-label="Notifications">
            {rows.map((row) => (
              <Item row={row} next={here} />
            ))}
          </ul>
          {next || later ? (
            <nav class="pagination" aria-label="Pagination">
              {later ? (
                <a class="btn sm" href={filterHref(filter)}>
                  Back to newest
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a class="btn sm" href={`${filterHref(filter)}${filter === 'unread' ? '&' : '?'}before=${encodeURIComponent(next)}`} rel="next">
                  Show older
                  <Icon name="right" />
                </a>
              ) : null}
            </nav>
          ) : null}
        </Card>
      )}
    </>
  );
}
