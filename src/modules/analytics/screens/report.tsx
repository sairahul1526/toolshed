/** A site's dashboard, the full list behind each "See all", event properties and the files to download. */
import { Hono } from 'hono';
import { toCsv } from '../../../core/csv';
import { errors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Card, EmptyState, LinkButton, PageHeader, Table, formatNumber } from '../../../ui';
import { page, SamplePill, siteCrumbs, siteHref, SiteTabs, type C } from '../dash-common';
import { csvResponse, ctxOf, freshSite, throwIfBlocked, withRatios } from '../http';
import { ensureFresh } from '../rollup';
import { domainNote, getSite, listGoals, type Site } from '../sites';
import { breakdown, derive, eventProps, HIT_COLUMNS, hitsCursorAfter, isDim, live, rawHits, report as buildReport, STORED_DIMS } from '../stats';
import {
  BlockedNote, Chips, columnsFor, DIM_LABELS, formatDuration, formatPercent, loadReport, queryOf, rangeQuery, RangeForm, readView, ReportView, valueLabel,
} from '../view';

export const report = new Hono<AppEnv>();

const PANEL_ROWS = 10;
const PAGE_ROWS = 50;
const CSV_ROWS = 1000;
/** Rows in one part of the raw export: small enough to build inside one request. */
export const EXPORT_PART = 5000;

const viewOf = (c: C, site: Site, now: number) => readView((key) => c.req.query(key), site, now);

function Live({ site, visitors }: { site: Site; visitors: number }) {
  return (
    <span class="an-live" data-an-live={siteHref(site, '/live.json')}>
      <span class="an-dot" aria-hidden="true"></span>
      <b data-an-live-n>{formatNumber(visitors)}</b> on the site now
    </span>
  );
}

report.get('/sites/:id', async (c: C) => {
  const ctx = ctxOf(c);
  const now = Date.now();
  let site = await freshSite(ctx, c.req.param('id') ?? '', now);
  const view = viewOf(c, site, now);
  const base = siteHref(site);
  const state = await live(ctx.db, site, now);
  // Someone who has just seen "It works" opens this page next. Totals may be up to a minute behind,
  // so count the very first visits now: the first look at the dashboard is never a page of zeros.
  if (state.firstHitAt !== null && site.first_hit_at === null) site = await ensureFresh(ctx.env, site, now, 0);
  if (state.firstHitAt === null) {
    return page(c, site.name, siteCrumbs(site), (
      <>
        <PageHeader title={site.name} soft={domainNote(site)} />
        <SiteTabs site={site} active="dashboard" />
        <EmptyState
          icon="chart"
          title="Waiting for the first page view"
          body={`Nothing has arrived from ${site.domain} yet. Paste the tracking line into your pages and open one of them.`}
          actions={<LinkButton href={siteHref(site, '/setup')} variant="primary">See the install steps</LinkButton>}
        />
      </>
    ));
  }
  const goals = await listGoals(ctx.db, site.id);
  const data = await loadReport(ctx.db, site, view, goals, PANEL_ROWS);
  return page(c, site.name, siteCrumbs(site), (
    <>
      <PageHeader title={site.name} soft={domainNote(site)} actions={<><SamplePill site={site} /><Live site={site} visitors={state.visitors} /></>} />
      <SiteTabs site={site} active="dashboard" keep={rangeQuery(view)} />
      <RangeForm action={base} view={view} />
      <ReportView base={base} view={view} data={data} goals={goals} limit={PANEL_ROWS} retentionDays={site.retention_days} moreHref={(dim) => `${base}/breakdown/${dim}${queryOf(view)}`} />
      {data.report.blocked ? null : (
        <p class="an-note">
          <a href={`${base}/timeseries.csv${queryOf(view)}`}>Download the chart as CSV</a>
        </p>
      )}
    </>
  ));
});

report.get('/sites/:id/timeseries.csv', async (c: C) => {
  const ctx = ctxOf(c);
  const now = Date.now();
  const site = await freshSite(ctx, c.req.param('id') ?? '', now);
  const view = viewOf(c, site, now);
  const res = await buildReport(ctx.db, site, view.range, view.filters, { compare: view.compare, dims: [], goals: await listGoals(ctx.db, site.id) });
  throwIfBlocked(res.blocked);
  const rows = res.series.labels.map((label, i) => ({
    [view.range.bucket]: label,
    visitors: res.series.visitors[i] ?? 0,
    pageviews: res.series.pageviews[i] ?? 0,
    ...(res.series.prevVisitors ? { visitors_period_before: res.series.prevVisitors[i] ?? 0 } : {}),
  }));
  return csvResponse(toCsv(rows), `${site.domain}-visitors-${view.range.from}-to-${view.range.to}.csv`);
});

report.get('/sites/:id/breakdown/:dim', async (c: C) => {
  const ctx = ctxOf(c);
  const now = Date.now();
  const dim = c.req.param('dim') ?? '';
  if (!isDim(dim)) throw errors.not_found();
  const site = await freshSite(ctx, c.req.param('id') ?? '', now);
  const view = viewOf(c, site, now);
  const goals = await listGoals(ctx.db, site.id);
  const csv = c.req.query('format') === 'csv';
  const res = await breakdown(ctx.db, site, view.range, view.filters, dim, { limit: csv ? CSV_ROWS : PAGE_ROWS, cursor: c.req.query('cursor'), goals });
  if (csv) {
    throwIfBlocked(res.blocked);
    const rows = res.items.map(({ value, ...m }) => ({ [dim]: value, ...withRatios(m) }));
    return csvResponse(toCsv(rows), `${site.domain}-${dim}-${view.range.from}-to-${view.range.to}.csv`);
  }
  const base = siteHref(site);
  const here = `${base}/breakdown/${dim}`;
  const query = queryOf(view);
  const join = query ? `${query}&` : '?';
  const title = `${DIM_LABELS[dim]} list`;
  const filterKey = dim === 'entry' || dim === 'exit' ? 'page' : dim;
  const lead = columnsFor(dim, 0)[0]?.label ?? 'Visitors';
  return page(c, `${title}, ${site.name}`, siteCrumbs(site, title), (
    <>
      <PageHeader
        title={title}
        soft={view.range.label}
        description={`Ranked by ${lead.toLowerCase()}.`}
        actions={res.blocked ? undefined : <LinkButton href={`${here}${join}format=csv`} icon="download">Download CSV</LinkButton>}
      />
      <RangeForm action={here} view={view} />
      <div class="an-report">
        <Chips base={here} view={view} goals={goals} />
        {res.blocked ? <BlockedNote blocked={res.blocked} clearHref={dim === 'region' || dim === 'city' ? null : `${here}${queryOf(view, { filters: {} })}`} /> : null}
      </div>
      {res.blocked ? null : (
        <Card flush footer={res.nextCursor ? <a href={`${here}${join}cursor=${encodeURIComponent(res.nextCursor)}`}>Next {PAGE_ROWS}</a> : undefined}>
          <Table
            caption={title}
            empty={<EmptyState bare icon="chart" title="Nothing here for these dates" body="Pick a longer range, or clear the filters." actions={<LinkButton href={`${base}${query}`}>Back to the dashboard</LinkButton>} />}
            columns={[
              { key: 'value', label: DIM_LABELS[dim] },
              { key: 'visitors', label: 'Visitors', numeric: true },
              { key: 'visits', label: 'Visits', numeric: true, hideOnMobile: true },
              { key: 'pageviews', label: 'Page views', numeric: true },
              { key: 'events', label: 'Events', numeric: true, hideOnMobile: true },
              { key: 'bounce', label: 'Bounce rate', numeric: true, hideOnMobile: true },
              { key: 'time', label: dim === 'page' ? 'Time on page' : 'Visit duration', numeric: true, hideOnMobile: true },
              ...(dim === 'event' ? [{ key: 'more', label: 'Properties', srOnly: true }] : []),
            ]}
            rows={res.items.map((r) => {
              const d = derive(r);
              const pageTime = dim === 'page' ? (r.pageviews > 0 ? r.duration / r.pageviews / 1000 : null) : d.visitSeconds;
              return {
                value: (
                  <a class="an-clip" href={`${base}${queryOf(view, { filters: { ...view.filters, [filterKey]: r.value } })}`} title={r.value}>
                    {valueLabel(dim, r.value)}
                  </a>
                ),
                visitors: formatNumber(r.visitors),
                visits: res.partial ? '–' : formatNumber(r.visits),
                pageviews: formatNumber(r.pageviews),
                events: formatNumber(r.events),
                bounce: res.partial || dim === 'page' || dim === 'event' ? '–' : formatPercent(d.bounceRate),
                time: res.partial || dim === 'event' ? '–' : formatDuration(pageTime),
                more: <a href={`${base}/events/${encodeURIComponent(r.value)}${rangeQuery(view)}`}>Properties</a>,
              };
            })}
          />
        </Card>
      )}
    </>
  ));
});

report.get('/sites/:id/events/:name', async (c: C) => {
  const ctx = ctxOf(c);
  const now = Date.now();
  const site = await getSite(ctx.db, c.req.param('id') ?? '');
  const view = viewOf(c, site, now);
  const name = (c.req.param('name') ?? '').slice(0, 120);
  const res = await eventProps(ctx.db, site, view.range, name);
  const here = `${siteHref(site)}/events/${encodeURIComponent(name)}`;
  return page(c, `${name}, ${site.name}`, siteCrumbs(site, name), (
    <>
      <PageHeader title={name} soft={view.range.label} description="The properties sent with this event, most common first." actions={<LinkButton href={siteHref(site, `/goals${rangeQuery(view)}`)}>Goals and events</LinkButton>} />
      <RangeForm action={here} view={{ ...view, filters: {} }} />
      {res.blocked ? (
        <div class="an-report">
          <div class="an-blocked" role="status">
            <p>Event properties are kept for {site.retention_days} days. Pick a more recent range to see them.</p>
          </div>
        </div>
      ) : (
        <Card flush>
          <Table
            caption={`Properties of ${name}`}
            empty={<EmptyState bare icon="chart" title="No properties for these dates" body="This event was not sent with any properties in this range." />}
            columns={[
              { key: 'key', label: 'Property' },
              { key: 'value', label: 'Value' },
              { key: 'events', label: 'Events', numeric: true },
              { key: 'visitors', label: 'Visitors', numeric: true },
            ]}
            rows={res.items.map((r) => ({ key: r.key, value: <span class="an-clip" title={r.value}>{r.value}</span>, events: formatNumber(r.events), visitors: formatNumber(r.visitors) }))}
          />
        </Card>
      )}
    </>
  ));
});

report.get('/sites/:id/export', async (c: C) => {
  const ctx = ctxOf(c);
  const now = Date.now();
  const site = await getSite(ctx.db, c.req.param('id') ?? '');
  const view = viewOf(c, site, now);
  const base = siteHref(site);
  const query = rangeQuery(view);
  const join = query ? `${query}&` : '?';
  const cursor = c.req.query('cursor') ?? '';
  const part = Math.max(1, Math.min(100_000, Math.floor(Number(c.req.query('part'))) || 1));
  const next = await hitsCursorAfter(ctx.db, site, cursor || null, EXPORT_PART);
  return page(c, `Export, ${site.name}`, siteCrumbs(site, 'Export'), (
    <>
      <PageHeader title={site.name} soft={domainNote(site)} actions={<SamplePill site={site} />} />
      <SiteTabs site={site} active="export" keep={query} />
      <Card title="Reports as CSV" description={`Each list on the dashboard as a file, for ${view.range.label.toLowerCase()}. Up to ${formatNumber(CSV_ROWS)} rows each.`}>
        <RangeForm action={`${base}/export`} view={{ ...view, filters: {}, compare: false }} />
        <ul class="an-files">
          <li><a href={`${base}/timeseries.csv${query}`}>Visitors over time</a></li>
          {STORED_DIMS.map((dim) => (
            <li><a href={`${base}/breakdown/${dim}${join}format=csv`}>{DIM_LABELS[dim]}</a></li>
          ))}
        </ul>
      </Card>
      <Card
        title="Every hit"
        description={`One row per page view and event, oldest first, for the ${site.retention_days} days this site keeps full detail. The file comes in parts of ${formatNumber(EXPORT_PART)} rows.`}
      >
        <div class="row">
          <LinkButton href={`${base}/hits.csv${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`} variant="primary" icon="download">Download part {formatNumber(part)}</LinkButton>
          {next ? <LinkButton href={`${base}/export?part=${part + 1}&cursor=${encodeURIComponent(next)}`}>Go to part {formatNumber(part + 1)}</LinkButton> : null}
          {part > 1 ? <LinkButton href={`${base}/export`} variant="ghost">Back to part 1</LinkButton> : null}
        </div>
        <p class="muted an-gap">{next ? 'There is more after this part.' : 'This is the last part.'} Visitor ids change every day and cannot be traced back to a person.</p>
      </Card>
    </>
  ));
});

report.get('/sites/:id/hits.csv', async (c: C) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id') ?? '');
  const res = await rawHits(ctx.db, site, { limit: EXPORT_PART, cursor: c.req.query('cursor') });
  const first = res.items[0];
  const stamp = first ? new Date(Number(first.at)).toISOString().slice(0, 19).replace(/[:T]/g, '') : 'empty';
  return csvResponse(toCsv(res.items, { columns: HIT_COLUMNS }), `${site.domain}-hits-${stamp}.csv`);
});
