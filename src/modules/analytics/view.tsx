/**
 * The report itself: the range picker, the six numbers, the chart and the ranked lists.
 *
 * The dashboard and the public share page both draw it, so it only uses its own `an-*` classes
 * (styled by /m/analytics/report.css under either set of colour tokens) and the kit's charts.
 * Everything a person picked lives in the URL, so every view can be linked, shared and reloaded.
 */
import type { Child } from 'hono/jsx';
import { BarChart, LineChart, formatNumber } from '../../ui';
import type { OrgDb } from '../../core/db';
import { AppError } from '../../core/errors';
import { analyticsErrors, type Goal, type Site } from './sites';
import {
  breakdown, DEFAULT_PERIOD, derive, FILTER_KEYS, hasFilters, isDim, PERIODS, readFilters, report, resolveRange,
  type Dim, type FilterKey, type Filters, type Metrics, type Range, type Report, type Row,
} from './stats';

// ---------------------------------------------------------------------------------------------
// What is on screen, read from and written back to the query string
// ---------------------------------------------------------------------------------------------

export const PANELS = {
  pages: { param: 'v_pages', title: 'Pages', tabs: [['page', 'Top pages'], ['entry', 'Entry pages'], ['exit', 'Exit pages']] },
  sources: {
    param: 'v_sources', title: 'Sources',
    tabs: [['source', 'Sources'], ['channel', 'Channels'], ['utm_campaign', 'Campaigns'], ['utm_source', 'UTM source'], ['utm_medium', 'UTM medium'], ['utm_content', 'UTM content'], ['utm_term', 'UTM term']],
  },
  places: { param: 'v_places', title: 'Places', tabs: [['country', 'Countries'], ['region', 'Regions'], ['city', 'Cities']] },
  tech: { param: 'v_tech', title: 'Devices', tabs: [['device', 'Devices'], ['browser', 'Browsers'], ['os', 'Operating systems']] },
} as const satisfies Record<string, { param: string; title: string; tabs: readonly (readonly [Dim, string])[] }>;

export type PanelId = keyof typeof PANELS;
export const PANEL_IDS = Object.keys(PANELS) as PanelId[];

export interface View {
  range: Range;
  compare: boolean;
  filters: Filters;
  tabs: Record<PanelId, Dim>;
  /** Why the range a person asked for was not used, when it was not. */
  note: string | null;
  /** Public pages show totals only: no filters, no custom range, no region or city. */
  open: boolean;
}

type Get = (key: string) => string | undefined | null;

const defaultTab = (id: PanelId): Dim => PANELS[id].tabs[0][0];

export function readView(get: Get, site: Pick<Site, 'timezone'>, now: number, open = false): View {
  let range: Range;
  let note: string | null = null;
  const period = get('period');
  try {
    range = resolveRange(site, open ? { period: period === 'custom' ? null : period } : { period, from: get('from'), to: get('to') }, now);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    note = e.message;
    range = resolveRange(site, {}, now);
  }
  const tabs = {} as Record<PanelId, Dim>;
  for (const id of PANEL_IDS) {
    const asked = get(PANELS[id].param) ?? '';
    const known = PANELS[id].tabs.some(([dim]) => dim === asked) && isDim(asked) && !(open && (asked === 'region' || asked === 'city'));
    tabs[id] = known ? (asked as Dim) : defaultTab(id);
  }
  return { range, compare: get('compare') === '1', filters: open ? {} : readFilters(get), tabs, note, open };
}

export interface ViewPatch {
  filters?: Filters;
  tabs?: Partial<Record<PanelId, Dim>>;
  compare?: boolean;
}

/** The query string for a view, always in the same order so equal views get equal links. */
export function queryOf(view: View, patch: ViewPatch = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of pairsOf(view, patch)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function pairsOf(view: View, patch: ViewPatch = {}): [string, string][] {
  const out: [string, string][] = [];
  const { range } = view;
  if (range.period === 'custom') out.push(['from', range.from], ['to', range.to]);
  else if (range.period !== DEFAULT_PERIOD) out.push(['period', range.period]);
  if (patch.compare ?? view.compare) out.push(['compare', '1']);
  const filters = patch.filters ?? view.filters;
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v) out.push([k, v]);
  }
  const tabs = { ...view.tabs, ...patch.tabs };
  for (const id of PANEL_IDS) if (tabs[id] !== defaultTab(id)) out.push([PANELS[id].param, tabs[id]]);
  return out;
}

/** Only the dates, for links to screens that do not filter. */
export function rangeQuery(view: View): string {
  return queryOf({ ...view, filters: {}, tabs: Object.fromEntries(PANEL_IDS.map((id) => [id, defaultTab(id)])) as Record<PanelId, Dim> });
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export interface ReportData {
  report: Report;
  /** Regions and cities come from raw hits, so that one list can be out of reach while the rest is fine. */
  places: { rows: Row[]; blocked: Report['blocked'] } | null;
}

export async function loadReport(db: OrgDb, site: Site, view: View, goals: Goal[], limit: number): Promise<ReportData> {
  const rawPlaces = view.tabs.places !== 'country';
  const dims: Dim[] = [view.tabs.pages, view.tabs.sources, view.tabs.tech, 'event', ...(rawPlaces ? [] : [view.tabs.places])];
  const main = await report(db, site, view.range, view.filters, { compare: view.compare, dims, limit, goals });
  if (!rawPlaces || main.blocked) return { report: main, places: null };
  const places = await breakdown(db, site, view.range, view.filters, view.tabs.places, { limit, goals });
  return { report: main, places: { rows: places.items, blocked: places.blocked } };
}

// ---------------------------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------------------------

export const DIM_LABELS: Record<Dim, string> = {
  page: 'Page', entry: 'Entry page', exit: 'Exit page', source: 'Source', channel: 'Channel', utm_source: 'UTM source', utm_medium: 'UTM medium',
  utm_campaign: 'Campaign', utm_content: 'UTM content', utm_term: 'UTM term', country: 'Country', region: 'Region', city: 'City', device: 'Device',
  browser: 'Browser', os: 'Operating system', event: 'Event',
};

const FILTER_LABELS: Record<FilterKey, string> = { ...DIM_LABELS, goal: 'Goal' };

let regionNames: Intl.DisplayNames | null | undefined;

function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** A stored value as a person reads it: "DE" is Germany, "mobile" is Mobile, "DE · Berlin" is Berlin, Germany. */
export function valueLabel(dim: Dim | 'goal', value: string, goals: Goal[] = []): string {
  if (dim === 'country') return countryName(value);
  if (dim === 'device') return value.charAt(0).toUpperCase() + value.slice(1);
  if (dim === 'region' || dim === 'city') {
    const [cc, ...rest] = value.split(' · ');
    return rest.length && cc ? `${rest.join(' · ')}, ${countryName(cc)}` : value;
  }
  if (dim === 'goal') return goals.find((g) => g.id === value)?.name ?? 'Deleted goal';
  return value;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '–';
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? '–' : `${Math.round(ratio * 100)}%`;
}

interface Tile {
  label: string;
  value: string;
  delta: { text: string; tone: 'up' | 'down' | 'flat' } | null;
}

function change(now: number | null, before: number | null | undefined, lowerIsBetter = false): Tile['delta'] {
  if (now === null || before === null || before === undefined || before <= 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: '0%', tone: 'flat' };
  const better = lowerIsBetter ? pct < 0 : pct > 0;
  return { text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, tone: better ? 'up' : 'down' };
}

function tilesOf(totals: Metrics, prev: Metrics | null, partial: boolean): Tile[] {
  const d = derive(totals);
  const p = prev ? derive(prev) : null;
  const visitBased = (value: string, delta: Tile['delta']) => (partial ? { value: '–', delta: null } : { value, delta });
  return [
    { label: 'Visitors', value: formatNumber(totals.visitors), delta: change(totals.visitors, prev?.visitors) },
    { label: 'Visits', ...visitBased(formatNumber(totals.visits), change(totals.visits, prev?.visits)) },
    { label: 'Page views', value: formatNumber(totals.pageviews), delta: change(totals.pageviews, prev?.pageviews) },
    { label: 'Views per visit', ...visitBased(d.viewsPerVisit === null ? '–' : d.viewsPerVisit.toFixed(1), change(d.viewsPerVisit, p?.viewsPerVisit)) },
    { label: 'Bounce rate', ...visitBased(formatPercent(d.bounceRate), change(d.bounceRate, p?.bounceRate, true)) },
    { label: 'Visit duration', ...visitBased(formatDuration(d.visitSeconds), change(d.visitSeconds, p?.visitSeconds)) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

function Hidden({ pairs }: { pairs: [string, string][] }) {
  return (
    <>
      {pairs.map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/** The date range and the compare switch. A plain GET form: it works without script, and the script only saves the click. */
export function RangeForm({ action, view }: { action: string; view: View }) {
  const keep = pairsOf(view).filter(([k]) => k !== 'period' && k !== 'compare' && k !== 'from' && k !== 'to');
  const custom = view.range.period === 'custom';
  return (
    <div class="an-controls">
      <form class="an-range" method="get" action={action} data-an-auto>
        <label class="sr-only" for="an-period">Date range</label>
        <select class="an-select" id="an-period" name="period">
          {PERIODS.filter((p) => p.id !== 'custom' || custom).map((p) => (
            <option value={p.id} selected={p.id === view.range.period}>
              {p.id === 'custom' ? view.range.label : p.label}
            </option>
          ))}
        </select>
        {custom ? <Hidden pairs={[['from', view.range.from], ['to', view.range.to]]} /> : null}
        <label class="an-check">
          <input type="checkbox" name="compare" value="1" checked={view.compare} />
          <span>Compare to previous period</span>
        </label>
        <Hidden pairs={keep} />
        <button class="an-btn" type="submit" data-an-go>Show</button>
      </form>
      {view.open ? null : (
        <details class="an-custom" open={!!view.note}>
          <summary>Custom range</summary>
          <form class="an-range" method="get" action={action}>
            <label class="an-date">
              <span>From</span>
              <input class="an-input" type="date" name="from" value={custom ? view.range.from : ''} max={view.range.today} required />
            </label>
            <label class="an-date">
              <span>To</span>
              <input class="an-input" type="date" name="to" value={custom ? view.range.to : ''} max={view.range.today} required />
            </label>
            <Hidden pairs={[['period', 'custom'], ...(view.compare ? ([['compare', '1']] as [string, string][]) : []), ...keep]} />
            <button class="an-btn" type="submit">Apply</button>
          </form>
          {view.note ? <p class="an-note an-bad" role="alert">{view.note}</p> : null}
        </details>
      )}
    </div>
  );
}

export function Chips({ base, view, goals }: { base: string; view: View; goals: Goal[] }) {
  const set = FILTER_KEYS.filter((k) => view.filters[k]);
  if (!set.length) return null;
  return (
    <p class="an-chips" aria-label="Filters">
      {set.map((k) => {
        const rest = { ...view.filters };
        delete rest[k];
        const text = `${FILTER_LABELS[k]}: ${valueLabel(k, view.filters[k] ?? '', goals)}`;
        return (
          <span class="an-chip">
            {text}
            <a href={`${base}${queryOf(view, { filters: rest })}`} aria-label={`Remove filter ${text}`}>Remove</a>
          </span>
        );
      })}
      {set.length > 1 ? <a href={`${base}${queryOf(view, { filters: {} })}`}>Clear all</a> : null}
    </p>
  );
}

function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <dl class="an-tiles">
      {tiles.map((t) => (
        <div class="an-tile">
          <dt>{t.label}</dt>
          <dd>
            <b>{t.value}</b>
            {t.delta ? (
              <span class={`an-delta ${t.delta.tone}`}>
                {t.delta.text}
                <span class="sr-only"> against the period before</span>
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Chart({ rep, compare }: { rep: Report; compare: boolean }) {
  const { series, range } = rep;
  const title = 'Visitors over time';
  if (range.bucket === 'hour' && !series.prevVisitors) {
    return <BarChart title={title} description={`Visitors per hour, ${range.label}.`} unit="visitors" data={series.labels.map((label, i) => ({ label, value: series.visitors[i] ?? 0 }))} />;
  }
  const second = compare && series.prevVisitors ? { label: 'Period before', values: series.prevVisitors } : { label: 'Page views', values: series.pageviews };
  return <LineChart title={title} labels={series.labels} series={[{ label: 'Visitors', values: series.visitors }, second]} />;
}

export interface ListColumn {
  label: string;
  cell: (row: Row) => string;
}

/** The two numbers shown beside each kind of row. The first one is what the list is ranked by. */
export function columnsFor(dim: Dim, totalVisitors: number): ListColumn[] {
  const visitors: ListColumn = { label: 'Visitors', cell: (r) => formatNumber(r.visitors) };
  if (dim === 'page') return [visitors, { label: 'Views', cell: (r) => formatNumber(r.pageviews) }];
  if (dim === 'entry') return [{ label: 'Entries', cell: (r) => formatNumber(r.visits) }, { label: 'Bounce', cell: (r) => formatPercent(r.visits > 0 ? Math.max(0, r.visits - r.unbounces) / r.visits : null) }];
  if (dim === 'exit') return [{ label: 'Exits', cell: (r) => formatNumber(r.visits) }];
  if (dim === 'event') return [visitors, { label: 'Events', cell: (r) => formatNumber(r.events) }];
  return [visitors, { label: 'Share', cell: (r) => formatPercent(totalVisitors > 0 ? Math.min(1, r.visitors / totalVisitors) : null) }];
}

const rankOf = (dim: Dim, r: Row): number => (dim === 'entry' || dim === 'exit' ? r.visits : dim === 'event' ? r.events : r.visitors);

/** Entry and exit rows are pages, so they filter by page. */
const filterKeyOf = (dim: Dim): FilterKey => (dim === 'entry' || dim === 'exit' ? 'page' : dim);

interface ListRow {
  label: string;
  href: string | null;
  cells: string[];
  /** 0 to 100, against the first row. */
  share: number;
}

function Rows({ caption, first, columns, rows, empty }: { caption: string; first: string; columns: string[]; rows: ListRow[]; empty: string }) {
  if (!rows.length) return <p class="an-empty">{empty}</p>;
  return (
    <table class="an-rows">
      <caption class="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{first}</th>
          {columns.map((c) => (
            <th scope="col" class="an-n">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <th scope="row" class="an-name">
              <svg class="an-bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <rect width={r.share} height="1" />
              </svg>
              {r.href ? <a href={r.href} title={r.label}>{r.label}</a> : <span title={r.label}>{r.label}</span>}
            </th>
            {r.cells.map((cell) => (
              <td class="an-n">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Box({ title, nav, more, children }: { title: string; nav?: Child; more?: Child; children?: Child }) {
  return (
    <section class="an-panel">
      <header>
        <h3>{title}</h3>
        {nav}
      </header>
      {children}
      {more ? <p class="an-more">{more}</p> : null}
    </section>
  );
}

function dimRows(dim: Dim, rows: Row[], totalVisitors: number, link: ((value: string) => string) | null): { columns: string[]; rows: ListRow[] } {
  const cols = columnsFor(dim, totalVisitors);
  const top = Math.max(1, ...rows.map((r) => rankOf(dim, r)));
  return {
    columns: cols.map((c) => c.label),
    rows: rows.map((r) => ({ label: valueLabel(dim, r.value), href: link ? link(r.value) : null, cells: cols.map((c) => c.cell(r)), share: Math.round((rankOf(dim, r) / top) * 100) })),
  };
}

export interface ReportProps {
  /** Where this report lives: the links for ranges, tabs and filters all start here. */
  base: string;
  view: View;
  data: ReportData;
  goals: Goal[];
  /** Rows per list; a full list means there may be more behind "See all". */
  limit: number;
  /** The link to the full list of one breakdown. The dashboard has them, public pages do not. */
  moreHref?: (dim: Dim) => string;
  retentionDays: number;
}

export function BlockedNote({ blocked, clearHref }: { blocked: NonNullable<Report['blocked']>; clearHref: string | null }) {
  const message = blocked === 'expired' ? analyticsErrors.raw_expired().message : analyticsErrors.too_much_data().message;
  return (
    <div class="an-blocked" role="status">
      <p>{message}</p>
      {clearHref ? <p><a href={clearHref}>Clear filters</a></p> : null}
    </div>
  );
}

/** Everything under the range picker. */
export function ReportView({ base, view, data, goals, limit, moreHref, retentionDays }: ReportProps) {
  const rep = data.report;
  const filtered = hasFilters(view.filters);
  if (rep.blocked) {
    return (
      <div class="an-report">
        <Chips base={base} view={view} goals={goals} />
        <BlockedNote blocked={rep.blocked} clearHref={`${base}${queryOf(view, { filters: {} })}`} />
      </div>
    );
  }
  const link = (dim: Dim) => (view.open ? null : (value: string) => `${base}${queryOf(view, { filters: { ...view.filters, [filterKeyOf(dim)]: value } })}`);
  const panel = (id: PanelId): Child => {
    const def = PANELS[id];
    const dim = view.tabs[id];
    const tabs = def.tabs.filter(([d]) => !(view.open && (d === 'region' || d === 'city')));
    const raw = id === 'places' && data.places ? data.places : null;
    const rows = raw ? raw.rows : (rep.panels[dim] ?? []);
    const list = dimRows(dim, rows, rep.totals.visitors, link(dim));
    return (
      <Box
        title={def.title}
        nav={
          tabs.length > 1 ? (
            <nav class="an-ptabs" aria-label={`${def.title}: pick a list`}>
              {tabs.map(([d, label]) => (
                <a href={`${base}${queryOf(view, { tabs: { [id]: d } })}`} aria-current={d === dim ? 'true' : undefined}>{label}</a>
              ))}
            </nav>
          ) : undefined
        }
        more={moreHref && rows.length >= limit ? <a href={moreHref(dim)}>See all</a> : undefined}
      >
        {raw?.blocked ? (
          <p class="an-empty">
            {raw.blocked === 'expired' ? `Regions and cities are kept for ${retentionDays} days. Pick a more recent range to see them.` : analyticsErrors.too_much_data().message}
          </p>
        ) : (
          <Rows caption={def.tabs.find(([d]) => d === dim)?.[1] ?? def.title} first={DIM_LABELS[dim]} columns={list.columns} rows={list.rows} empty={filtered ? 'Nothing matches these filters.' : 'Nothing here for these dates yet.'} />
        )}
      </Box>
    );
  };
  const events = dimRows('event', rep.panels.event ?? [], rep.totals.visitors, link('event'));
  const goalTop = Math.max(1, ...rep.goals.map((g) => g.uniques));
  const goalRows: ListRow[] = rep.goals.map((g) => ({
    label: g.goal.name,
    href: view.open ? null : `${base}${queryOf(view, { filters: { ...view.filters, goal: g.goal.id } })}`,
    cells: [formatNumber(g.uniques), formatPercent(g.rate)],
    share: Math.round((g.uniques / goalTop) * 100),
  }));
  return (
    <div class="an-report">
      <Chips base={base} view={view} goals={goals} />
      <Tiles tiles={tilesOf(rep.totals, rep.prev, rep.partial)} />
      {rep.partial ? <p class="an-note">A page or event filter counts single hits, so visits, bounce rate and visit duration are left out.</p> : null}
      {view.compare && !rep.prev ? <p class="an-note">The period before is older than the detail kept for filters, so there is nothing to compare with.</p> : null}
      <section class="an-panel an-chart">
        <Chart rep={rep} compare={view.compare} />
      </section>
      {rep.range.from !== rep.range.to ? (
        <p class="an-note">Visitors over several days are each day’s visitors added up, so someone who comes back on another day counts again.</p>
      ) : null}
      <div class="an-grid">
        {panel('pages')}
        {panel('sources')}
        {panel('places')}
        {panel('tech')}
        {goalRows.length ? (
          <Box title="Goals">
            <Rows caption="Goals" first="Goal" columns={['Visitors', 'Rate']} rows={goalRows} empty="" />
          </Box>
        ) : null}
        {events.rows.length || goalRows.length ? (
          <Box title="Events" more={moreHref && events.rows.length >= limit ? <a href={moreHref('event')}>See all</a> : undefined}>
            <Rows caption="Events" first="Event" columns={events.columns} rows={events.rows} empty="No events for these dates." />
          </Box>
        ) : null}
      </div>
    </div>
  );
}
