/** The Overview page body. Pure rendering: everything it shows comes from `OverviewData`. */
import {
  Button,
  Card,
  EmptyState,
  Icon,
  isIconName,
  KeyValueList,
  LinkButton,
  PageHeader,
  Pill,
  Sparkline,
  StatGrid,
  Table,
  Tabs,
  formatDateTime,
  formatNumber,
  plural,
  timeAgo,
} from '../../ui';
import { getModule } from '../../core/registry';
import type { RecentEvent } from '../../core/events';
import { RANGES, type ChecklistStep, type ModuleCard, type OverviewData, type Range } from './data';

export const DISMISS_PATH = '/app/overview/dismiss-checklist';

const rangeHref = (days: Range) => (days === 30 ? '/app' : `/app?days=${days}`);

/** "link.clicked" becomes "Link clicked". */
export function eventLabel(name: string): string {
  const text = name.replace(/[._-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Something happened';
}

function Checklist({ steps, range }: { steps: ChecklistStep[]; range: Range }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Card
      title="Finish setting up"
      description={`${done} of ${steps.length} done.`}
      ruled
      flush
      actions={
        <form method="post" action={DISMISS_PATH}>
          <input type="hidden" name="days" value={String(range)} />
          <Button size="sm" variant="ghost" type="submit" title="Hides this list. Every step is still available from the sidebar.">
            Dismiss
          </Button>
        </form>
      }
    >
      <ul class="rows">
        {steps.map((s) => (
          <li class={s.done ? 'done' : undefined}>
            <span class="tick">{s.done ? <Icon name="check" /> : null}</span>
            <span class="row-text">
              <b>{s.title}</b>
              <span>{s.done ? 'Done.' : s.body}</span>
            </span>
            {s.done ? null : (
              <LinkButton size="sm" href={s.href}>
                {s.action}
              </LinkButton>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ModuleCardView({ card, range }: { card: ModuleCard; range: Range }) {
  const needsSetup = card.status.status === 'needs_setup';
  const setup = card.status.status === 'needs_setup' ? card.status : null;
  return (
    <Card
      class="module-card"
      title={
        <a class="trunc" href={card.href} title={card.name}>
          {card.name}
        </a>
      }
      actions={<Pill tone={needsSetup ? 'warn' : 'good'}>{needsSetup ? 'Needs setup' : 'Ready'}</Pill>}
    >
      <div class="kpi-value">
        <span class="tile">
          <Icon name={isIconName(card.icon) ? card.icon : 'layers'} />
        </span>
        <span class="num">{card.count === null ? '–' : formatNumber(card.count)}</span>
      </div>
      <p class="kpi-note">
        {card.total === 0 ? `No activity in the last ${range} days.` : `${plural(card.total, 'event')} in the last ${range} days.`}
      </p>
      {card.total > 0 ? <Sparkline values={card.days.map((d) => d.count)} label={`Activity per day, last ${range} days`} /> : null}
      {card.stats.length > 0 ? (
        <KeyValueList
          items={card.stats.map((s) => ({
            label: s.label,
            value: (
              <>
                {s.href ? <a href={s.href}>{s.value}</a> : s.value}
                {s.delta ? <span class="muted"> {s.delta}</span> : null}
              </>
            ),
          }))}
        />
      ) : null}
      {setup ? (
        <p class="kpi-note">
          {setup.reason ?? 'This module needs setup before it can be used.'}{' '}
          <a href={setup.action?.href ?? card.href}>{setup.action?.label ?? 'Open it'}</a>
        </p>
      ) : (
        <p class="kpi-note">
          <a href={card.href}>Open {card.name}</a>
        </p>
      )}
    </Card>
  );
}

function Recent({ events, now }: { events: RecentEvent[]; now: number }) {
  return (
    <Card title="Recent activity" description="The latest things that happened in your modules." flush>
      <Table
        caption="Recent activity"
        columns={[
          { key: 'module', label: 'Module' },
          { key: 'what', label: 'What happened' },
          { key: 'when', label: 'When', numeric: true },
        ]}
        rows={events.map((e) => {
          const def = getModule(e.module);
          return {
            module: def ? <a href={`/app/${def.id}`}>{def.name}</a> : e.module,
            what: (
              <>
                {eventLabel(e.name)}
                {e.subject ? <span class="muted mono trunc"> {e.subject}</span> : null}
              </>
            ),
            when: (
              <time datetime={new Date(e.at).toISOString()} title={formatDateTime(e.at)}>
                {timeAgo(e.at, now)}
              </time>
            ),
          };
        })}
        empty={
          <EmptyState
            bare
            icon="pulse"
            title="No activity yet"
            body="Clicks, responses and other things that happen in your modules show up here."
          />
        }
      />
    </Card>
  );
}

export function OverviewView({ data, now }: { data: OverviewData; now: number }) {
  const { shell, cards, range, checklist, canManage } = data;
  return (
    <>
      <PageHeader
        title="Overview"
        soft={<span class="trunc">{shell.org.name}</span>}
        description="What is happening across your workspace."
        actions={
          canManage ? (
            <LinkButton variant="primary" icon="plus" href="/app/members">
              Invite people
            </LinkButton>
          ) : null
        }
      />
      {checklist ? <Checklist steps={checklist} range={range} /> : null}
      {cards.length === 0 ? (
        <EmptyState
          icon="layers"
          title="No modules are on yet"
          body={canManage ? 'Turn on a module and its numbers show up here.' : 'Ask a workspace admin to turn on a module. Its numbers will show up here.'}
          actions={
            canManage ? (
              <LinkButton variant="primary" href="/app/modules">
                Browse modules
              </LinkButton>
            ) : null
          }
        />
      ) : (
        <>
          <Tabs
            label="Date range"
            active={String(range)}
            items={RANGES.map((r) => ({ id: String(r), label: `Last ${r} days`, href: rangeHref(r) }))}
          />
          <StatGrid label="Modules">
            {cards.map((card) => (
              <ModuleCardView card={card} range={range} />
            ))}
          </StatGrid>
        </>
      )}
      <Recent events={data.recent} now={now} />
    </>
  );
}
