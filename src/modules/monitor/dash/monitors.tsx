/** Monitor list, first run, detail, create and edit. */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import { z } from 'zod';
import { parse } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, CodeBlock, ConfirmButton, CopyField, EmptyState, Field, FilterBar, Input, KeyValueList, LineChart, LinkButton, PageHeader, Pill, Select, SearchInput, StatGrid, Stat, Table, Tabs, formatDateTime, formatNumber, renderPage, timeAgo } from '../../../ui';
import { listChannels } from '../channels';
import { fmtDuration, fmtPct } from '../fmt';
import { createMonitor, deleteMonitor, getMonitor, listMonitors, monitorView, setPaused, updateMonitor, viewBase, type MonitorView } from '../monitors';
import { createComponent, createPage, listPages, pageParts } from '../pages';
import { checkNow } from '../runner';
import { INTERVALS, METHODS, type ChannelRow, type MonitorRow } from '../schema';
import { dailySeries, hourlySeries, recentResults, summarize } from '../uptime';
import { Assets, AreaField, BASE, Back, Problems, StatusPill, TextField, Toggle, UptimeBars, failed, done, list, mctx, on, pctOf, readForm, record, text, type C, type Errors, type Values, INTERVAL_OPTIONS } from './common';

const app = new Hono<AppEnv>();

/* ------------------------------------------------------------ list and first run */

const listQuery = z.object({ q: z.string().max(100).optional(), status: z.enum(['all', 'up', 'down', 'paused']).default('all') });

app.get('/', async (c) => {
  const ctx = await mctx(c);
  const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
  const all = await listMonitors(ctx);
  if (all.length === 0) return firstRun(c);
  const series = await dailySeries(c.env, ctx.db.orgId, all.map((m) => m.id), 30);
  const needle = (q.q ?? '').trim().toLowerCase();
  const shown = all.filter((m) => {
    if (needle && !`${m.name} ${m.url ?? ''}`.toLowerCase().includes(needle)) return false;
    if (q.status === 'down') return m.status === 'down' && !m.paused;
    if (q.status === 'up') return m.status === 'up' && !m.paused;
    if (q.status === 'paused') return m.paused === 1;
    return true;
  });
  const down = all.filter((m) => m.status === 'down' && !m.paused).length;
  const paused = all.filter((m) => m.paused).length;
  const month = summarize(all.flatMap((m) => (series.get(m.id) ?? []).map((d) => d.b)));
  const rows = shown.map((m) => {
    const days = series.get(m.id) ?? [];
    const s = summarize(days.map((d) => d.b));
    return {
      name: (
        <a class="mon-name" href={`${BASE}/m/${m.id}`}>
          <b>{m.name}</b>
          <span class="trunc">{m.type === 'heartbeat' ? 'Cron heartbeat' : m.url}</span>
        </a>
      ),
      status: (
        <>
          <StatusPill m={m} />
          {m.since_at && !m.paused && m.status !== 'pending' ? <span class="mon-since">{timeAgo(m.since_at)}</span> : null}
        </>
      ),
      uptime: s.uptimePct === null ? <span class="muted">No data</span> : fmtPct(s.uptimePct),
      bars: <UptimeBars days={days.slice(-30)} label={`${m.name}, last 30 days`} />,
      every: m.type === 'heartbeat' ? 'On ping' : `${m.interval_min} min`,
    };
  });
  return renderPage(
    c,
    { title: 'Monitors', crumbs: [{ label: 'Monitors' }] },
    <>
      <Assets />
      <PageHeader
        title="Monitors"
        description="Websites and cron jobs we watch for you."
        actions={
          <>
            <LinkButton href={`${BASE}/settings#import`}>Import</LinkButton>
            <LinkButton variant="primary" icon="plus" href={`${BASE}/new`}>
              New monitor
            </LinkButton>
          </>
        }
      />
      <StatGrid>
        <Stat label="Monitors" value={formatNumber(all.length)} note={paused > 0 ? `${paused} paused` : 'All running'} icon="pulse" />
        <Stat label="Down now" value={formatNumber(down)} note={down === 0 ? 'Everything is answering.' : 'Needs a look.'} icon="alert" />
        <Stat label="Uptime, 30 days" value={month.uptimePct === null ? 'No data' : fmtPct(month.uptimePct)} note="Across every monitor" icon="chart" />
      </StatGrid>
      <Card flush>
        <div class="mon-tools">
          <FilterBar>
            <SearchInput label="Search monitors" value={q.q ?? ''} placeholder="Search by name or address" />
            <Select
              id="status"
              name="status"
              aria-label="Status"
              value={q.status}
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'paused', label: 'Paused' },
              ]}
            />
          </FilterBar>
        </div>
        <Table
          caption="Monitors"
          columns={[
            { key: 'name', label: 'Monitor' },
            { key: 'status', label: 'Status' },
            { key: 'uptime', label: '30 days', numeric: true },
            { key: 'bars', label: 'Last 30 days', hideOnMobile: true },
            { key: 'every', label: 'Checks', hideOnMobile: true },
          ]}
          rows={rows}
          empty={<EmptyState bare icon="search" title="No monitors match" body="Try a different word or status." actions={<LinkButton href={BASE}>Clear filters</LinkButton>} />}
        />
      </Card>
    </>,
  );
});

async function firstRun(c: C, errors: Errors = {}, values?: Values, status?: 422) {
  return renderPage(
    c,
    { title: 'Monitors', crumbs: [{ label: 'Monitors' }], status },
    <>
      <Assets />
      <PageHeader title="Monitors" description="Know when your site goes down, before your customers tell you." />
      <Card title="Start with one address" description="Paste your website. We check it right away and show you the result.">
        <form method="post" action={`${BASE}/quick`} class="stack" novalidate>
          <Problems errors={errors} shown={['url']} />
          <TextField id="url" label="Website address" v={values} errors={errors} type="text" placeholder="example.com" inputmode="url" autocomplete="url" hint="You can leave off https://." />
          <div class="row">
            <Button type="submit" variant="primary">
              Check it now
            </Button>
            <LinkButton href={`${BASE}/new`}>More options</LinkButton>
          </div>
        </form>
      </Card>
      <ol class="mon-steps" aria-label="What happens next">
        <li>
          <b>1. Paste a website address</b>
          <span>Any public page works.</span>
        </li>
        <li>
          <b>2. See the first result</b>
          <span>We check it straight away, then every minute.</span>
        </li>
        <li>
          <b>3. Share a status page</b>
          <span>One click gives you a public link for your customers.</span>
        </li>
      </ol>
      <p class="muted">Watching a cron job instead? <a href={`${BASE}/new?type=heartbeat`}>Create a heartbeat monitor</a>.</p>
    </>,
  );
}

function withScheme(input: string): string {
  const s = input.trim();
  return s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? `https://${s}` : s;
}

app.post('/quick', async (c) => {
  const v = await readForm(c);
  const ctx = await mctx(c);
  try {
    const m = await createMonitor(ctx, { url: withScheme(text(v, 'url')) });
    await record(c, 'monitor.created', 'monitor', m.id, `Created monitor ${m.name}`);
    await checkNow(c.env, ctx.db.orgId, m);
    return c.redirect(`${BASE}/m/${m.id}?first=1`);
  } catch (e) {
    return failed(c, e, BASE, (errors) => firstRun(c, errors, v, 422));
  }
});

/* ------------------------------------------------------------ detail */

const RANGES = ['24h', '7d', '30d', '90d'] as const;
const detailQuery = z.object({ range: z.enum(RANGES).default('24h'), first: z.string().optional() });

async function detail(c: C, id: string) {
  const ctx = await mctx(c);
  const m = await getMonitor(ctx, id);
  const q = parse(detailQuery, Object.fromEntries(new URL(c.req.url).searchParams));
  const now = Date.now();
  const view = monitorView(m, viewBase(c.env, c.req.url));
  const days = (await dailySeries(c.env, ctx.db.orgId, [m.id], 90, now)).get(m.id) ?? [];
  const hours24 = await hourlySeries(c.env, ctx.db.orgId, m.id, 24, now);
  const points =
    q.range === '24h'
      ? hours24.map((h) => ({ label: `${new Date(h.hour).getUTCHours()}:00`, ms: h.b?.avg ?? 0 }))
      : q.range === '7d'
        ? (await hourlySeries(c.env, ctx.db.orgId, m.id, 168, now)).map((h) => ({ label: formatDateTime(h.hour), ms: h.b?.avg ?? 0 }))
        : days.slice(q.range === '30d' ? -30 : -90).map((d) => ({ label: d.day, ms: d.b?.avg ?? 0 }));
  const s24 = summarize(hours24.map((h) => h.b));
  const s7 = summarize(days.slice(-7).map((d) => d.b));
  const s30 = summarize(days.slice(-30).map((d) => d.b));
  const s90 = summarize(days.map((d) => d.b));
  const changes = await ctx.db.all<{ status: string; at: number; status_code: number | null; error: string | null }>(
    'SELECT status, at, status_code, error FROM mon_state_changes WHERE org_id = :org AND monitor_id = ? ORDER BY at DESC LIMIT 8',
    m.id,
  );
  const alerts = await ctx.db.all<{ channel_name: string; kind: string; outcome: string; detail: string | null; at: number }>(
    'SELECT channel_name, kind, outcome, detail, at FROM mon_alerts WHERE org_id = :org AND monitor_id = ? ORDER BY at DESC LIMIT 8',
    m.id,
  );
  const latest = m.type === 'http' ? (await recentResults(c.env, ctx.db.orgId, m.id, 10, now)).slice(0, 8) : [];
  const pages = await listPages(ctx);
  let linkedPage: { slug: string; title: string } | null = null;
  for (const p of pages) {
    const parts = await pageParts(ctx, p.id);
    if (parts.components.some((x) => x.monitor_id === m.id)) {
      linkedPage = { slug: p.slug, title: p.title };
      break;
    }
  }
  const base = viewBase(c.env, c.req.url);
  const pending = m.status === 'pending' && !m.paused;
  // A heartbeat that has been pinged is no longer waiting for anything on this screen; the next minute's run marks it up.
  const waiting = pending && (m.type !== 'heartbeat' || m.hb_last_ping_at === null);
  const first = q.first === '1';
  return renderPage(
    c,
    { title: m.name, crumbs: [{ label: 'Monitors', href: BASE }, { label: m.name }] },
    <>
      <Assets />
      <Back href={BASE}>All monitors</Back>
      <PageHeader
        title={m.name}
        soft={<StatusPill m={m} />}
        description={m.type === 'heartbeat' ? 'Your job pings us. If it stops, we tell you.' : <span class="mono trunc-wide">{m.url}</span>}
        actions={
          <>
            {m.type === 'http' ? (
              <form method="post" action={`${BASE}/m/${m.id}/check`}>
                <Button type="submit" icon="refresh">
                  Check now
                </Button>
              </form>
            ) : null}
            <form method="post" action={`${BASE}/m/${m.id}/${m.paused ? 'resume' : 'pause'}`}>
              <Button type="submit">{m.paused ? 'Resume' : 'Pause'}</Button>
            </form>
            <LinkButton href={`${BASE}/m/${m.id}/edit`} icon="edit">
              Edit
            </LinkButton>
          </>
        }
      />
      {waiting ? <div data-poll="5000" hidden /> : null}
      {first || pending ? <FirstSteps m={m} latest={latest[0]} page={linkedPage} base={base} /> : null}
      {m.status === 'down' && !m.paused ? (
        <Callout tone="bad" title={`Down since ${m.since_at ? formatDateTime(m.since_at) : 'a moment ago'}`}>
          {m.last_error ?? 'The last check failed.'}
          {m.incident_id ? (
            <>
              {' '}
              <a href={`${BASE}/incidents/${m.incident_id}`}>See the incident</a>.
            </>
          ) : null}
        </Callout>
      ) : null}
      <StatGrid label="Uptime">
        <Stat label="Last 24 hours" value={fmtPct(s24.uptimePct)} note={s24.avgMs === null ? 'No checks yet' : `${formatNumber(Math.round(s24.avgMs))} ms average`} />
        <Stat label="Last 7 days" value={fmtPct(s7.uptimePct)} note={s7.down > 0 ? `${formatNumber(s7.down)} failed checks` : 'No failures'} />
        <Stat label="Last 30 days" value={fmtPct(s30.uptimePct)} note={s30.p95Ms === null ? undefined : `Slowest 5%: ${formatNumber(Math.round(s30.p95Ms))} ms`} />
        <Stat label="Last 90 days" value={fmtPct(s90.uptimePct)} />
      </StatGrid>
      <Card title="Last 90 days" description="One bar per day. Green is fully up, amber had trouble, red was mostly down." ruled>
        <UptimeBars days={days} label={`${m.name}, last 90 days`} />
      </Card>
      {m.type === 'http' ? (
        <Card
          title="Response time"
          description="Average time to answer, in milliseconds."
          actions={
            <nav class="mon-range" aria-label="Time range">
              {RANGES.map((r) => (
                <a href={`${BASE}/m/${m.id}?range=${r}`} aria-current={r === q.range ? 'true' : undefined}>
                  {r === '24h' ? '24 hours' : r === '7d' ? '7 days' : r === '30d' ? '30 days' : '90 days'}
                </a>
              ))}
            </nav>
          }
        >
          {points.some((p) => p.ms > 0) ? (
            <LineChart title={`Response time, ${q.range}`} labels={points.map((p) => p.label)} series={[{ label: 'Milliseconds', values: points.map((p) => p.ms) }]} />
          ) : (
            <EmptyState bare icon="chart" title="No response times yet" body="They appear here after the first few checks." />
          )}
        </Card>
      ) : (
        <Card title="Connect your job" description="Call this address when the job runs. We expect it on schedule.">
          <HeartbeatHelp view={view} />
        </Card>
      )}
      <div class="grid-2">
        <Card title="Status changes" flush>
          {changes.length === 0 ? (
            <EmptyState bare icon="history" title="No changes yet" body="Going down or coming back up shows here." />
          ) : (
            <ul class="rows">
              {changes.map((x) => (
                <li>
                  <span class="row-text">
                    <b>{x.status === 'down' ? 'Went down' : x.status === 'up' ? 'Came back up' : `Changed to ${x.status}`}</b>
                    <span>{x.error ?? (x.status_code ? `Answered ${x.status_code}` : formatDateTime(x.at))}</span>
                  </span>
                  <span class="muted">{timeAgo(x.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Alerts sent" flush>
          {alerts.length === 0 ? (
            <EmptyState bare icon="bell" title="No alerts yet" body={<>Add a channel under <a href={`${BASE}/alerts`}>Alerts</a> to hear about problems.</>} />
          ) : (
            <ul class="rows">
              {alerts.map((a) => (
                <li>
                  <span class="row-text">
                    <b>
                      {a.channel_name} <Pill tone={a.outcome === 'sent' ? 'good' : a.outcome === 'failed' ? 'bad' : 'neutral'}>{a.outcome}</Pill>
                    </b>
                    <span>{a.detail ?? a.kind}</span>
                  </span>
                  <span class="muted">{timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {m.type === 'http' && latest.length > 0 ? (
        <Card title="Latest checks" flush>
          <Table
            caption="Latest checks"
            columns={[
              { key: 'at', label: 'When' },
              { key: 'result', label: 'Result' },
              { key: 'code', label: 'Status code', numeric: true },
              { key: 'ms', label: 'Time', numeric: true },
            ]}
            rows={latest.map((r) => ({
              at: formatDateTime(r.minute),
              result: r.maintenance ? <Pill>Maintenance</Pill> : r.ok ? <Pill tone="good">Up</Pill> : <Pill tone="bad">{r.error || 'Failed'}</Pill>,
              code: r.code ?? '',
              ms: `${formatNumber(r.ms)} ms`,
            }))}
          />
        </Card>
      ) : null}
      <Card title="Settings in short" ruled>
        <KeyValueList
          items={[
            { label: 'Checks', value: m.type === 'heartbeat' ? `Expects a ping every ${fmtDuration((view.heartbeat?.periodSec ?? 0) * 1000)}, then waits ${fmtDuration((view.heartbeat?.graceSec ?? 0) * 1000)}` : `Every ${m.interval_min} minute${m.interval_min === 1 ? '' : 's'}, ${m.method}, expects ${m.expected_status}` },
            { label: 'Down after', value: `${m.fail_after} failed ${m.fail_after === 1 ? 'check' : 'checks'} in a row` },
            { label: 'Slow alert', value: m.slow_ms ? `Over ${formatNumber(m.slow_ms)} ms, ${m.slow_after} times in a row` : 'Off' },
            { label: 'Incidents', value: m.auto_incident ? 'Opened automatically when it goes down' : 'Not opened automatically' },
            { label: 'Status page', value: linkedPage ? <a href={`/status/${linkedPage.slug}`}>{linkedPage.title}</a> : 'Not on a status page yet' },
          ]}
        />
      </Card>
      <form method="post" action={`${BASE}/m/${m.id}/delete`}>
      <ConfirmButton id={`delete-${m.id}`} title={`Delete ${m.name}?`} body="Its history and any status page components that use it go too. This can’t be undone." confirmLabel="Delete monitor" icon="trash">
        Delete monitor
      </ConfirmButton>
      </form>
    </>,
  );
}

function HeartbeatHelp({ view }: { view: MonitorView }) {
  const url = view.heartbeat?.pingUrl ?? '';
  return (
    <div class="stack">
      <CopyField label="ping address" value={url} />
      <CodeBlock label="curl example" code={`# at the end of your job\ncurl -fsS -m 10 --retry 3 ${url}\n\n# optional: tell us when it starts, or that it failed\ncurl -fsS ${url}/start\ncurl -fsS ${url}/fail`} />
      <p class="muted">
        {view.heartbeat?.lastPingAt ? `Last ping ${timeAgo(view.heartbeat.lastPingAt)}.` : 'No ping yet. This page updates when the first one arrives.'} Add <code>?msg=text</code> to send a note, or <code>?code=1</code> to report a failure.
      </p>
    </div>
  );
}

function FirstSteps({ m, latest, page, base }: { m: MonitorRow; latest?: { ok: boolean; ms: number; code: number | null; error: string } | undefined; page: { slug: string; title: string } | null; base: string }) {
  const heartbeat = m.type === 'heartbeat';
  const have = heartbeat ? m.hb_last_ping_at !== null : !!latest || m.status !== 'pending';
  const result = heartbeat
    ? m.hb_last_ping_at
      ? `First ping received ${timeAgo(m.hb_last_ping_at)}.`
      : 'Waiting for your job to ping the address below.'
    : latest
      ? latest.ok
        ? `It answered${latest.code ? ` ${latest.code}` : ''} in ${formatNumber(latest.ms)} ms.`
        : `It didn’t answer well: ${latest.error || 'the check failed'}. Check the address and try Check now.`
      : 'Running the first check.';
  return (
    <Card class="mon-first" title="You’re set up" description="Three steps. You’ve done the first.">
      <ol class="mon-checklist">
        <li class="ok">
          <span class="tick">✓</span>
          <span>
            <b>Added {m.name}</b>
            <span>We check it {heartbeat ? 'whenever you ping' : `every ${m.interval_min === 1 ? 'minute' : `${m.interval_min} minutes`}`}.</span>
          </span>
        </li>
        <li class={have ? 'ok' : ''}>
          <span class="tick">{have ? '✓' : ''}</span>
          <span>
            <b>First result</b>
            <span>{result}</span>
          </span>
        </li>
        <li class={page ? 'ok' : ''}>
          <span class="tick">{page ? '✓' : ''}</span>
          <span>
            <b>Share a status page</b>
            {page ? (
              <span>
                Live at <a href={`/status/${page.slug}`}>{`${base}/status/${page.slug}`}</a>
              </span>
            ) : (
              <form method="post" action={`${BASE}/m/${m.id}/page`} class="row">
                <Button type="submit" variant="primary" size="sm">
                  Create status page
                </Button>
                <span>A public page that shows this monitor.</span>
              </form>
            )}
          </span>
        </li>
      </ol>
    </Card>
  );
}

app.get('/m/:id', (c) => detail(c, c.req.param('id')));

app.post('/m/:id/check', async (c) => {
  const ctx = await mctx(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const r = await checkNow(c.env, ctx.db.orgId, m);
  return done(c, r.ok ? `${m.name} answered${r.code ? ` ${r.code}` : ''} in ${formatNumber(r.ms)} ms.` : `${m.name} didn’t answer well: ${r.error ?? 'the check failed'}.`, `${BASE}/m/${m.id}`);
});

for (const [path, paused] of [['pause', true], ['resume', false]] as const) {
  app.post(`/m/:id/${path}`, async (c) => {
    const ctx = await mctx(c);
    const m = await setPaused(ctx, c.req.param('id'), paused);
    await record(c, `monitor.${paused ? 'paused' : 'resumed'}`, 'monitor', m.id, `${paused ? 'Paused' : 'Resumed'} ${m.name}`);
    return done(c, paused ? `${m.name} is paused. We won’t check it or send alerts.` : `${m.name} is running again.`, `${BASE}/m/${m.id}`);
  });
}

app.post('/m/:id/delete', async (c) => {
  const ctx = await mctx(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  await deleteMonitor(ctx, m.id);
  await record(c, 'monitor.deleted', 'monitor', m.id, `Deleted monitor ${m.name}`);
  return done(c, `${m.name} was deleted.`, BASE);
});

app.post('/m/:id/page', async (c) => {
  const ctx = await mctx(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  try {
    const existing = await listPages(ctx);
    const page = existing[0] ?? (await createPage(ctx, { title: `${m.name} status`, published: true }));
    await createComponent(ctx, page.id, { name: m.name, monitorId: m.id });
    await record(c, 'monitor.page_created', 'page', page.id, `Added ${m.name} to status page ${page.title}`);
    return done(c, `${m.name} is on your status page.`, `${BASE}/m/${m.id}?first=1`);
  } catch (e) {
    return failed(c, e, `${BASE}/m/${m.id}`, async () => c.redirect(`${BASE}/m/${m.id}`));
  }
});

/* ------------------------------------------------------------ create and edit */

const HB_PERIODS = [
  { value: '60', label: 'Every minute' },
  { value: '300', label: 'Every 5 minutes' },
  { value: '3600', label: 'Every hour' },
  { value: '86400', label: 'Every day' },
  { value: '604800', label: 'Every week' },
];
const MODES = [
  { value: 'none', label: 'Don’t look for a word' },
  { value: 'present', label: 'Down if the word is missing' },
  { value: 'absent', label: 'Down if the word is there' },
];

function valuesOf(m: MonitorRow | null, type: string): Values {
  if (!m) return { type, method: 'GET', intervalMin: '5', expectedStatus: '200-299', timeoutMs: '10000', followRedirects: '1', failAfter: '2', slowAfter: '3', autoIncident: '1', keywordMode: 'none', channelMode: 'all', hbPeriodSec: '86400', hbGraceMin: '15' };
  const v = monitorView(m, '');
  return {
    type: m.type,
    name: m.name,
    url: m.url ?? '',
    method: m.method,
    intervalMin: String(m.interval_min),
    expectedStatus: m.expected_status,
    keywordMode: m.keyword_mode,
    keyword: m.keyword ?? '',
    timeoutMs: String(m.timeout_ms),
    followRedirects: m.follow_redirects ? '1' : '0',
    headers: Object.entries(v.headers).map(([k, x]) => `${k}: ${x}`).join('\n'),
    body: m.body ?? '',
    failAfter: String(m.fail_after),
    slowMs: m.slow_ms ? String(m.slow_ms) : '',
    slowAfter: String(m.slow_after),
    autoIncident: m.auto_incident ? '1' : '0',
    channelMode: m.channel_ids === null ? 'all' : 'pick',
    channelIds: v.channelIds ?? [],
    hbPeriodSec: String(m.hb_period_sec ?? 86400),
    hbGraceMin: String(Math.round(m.hb_grace_sec / 60)),
  };
}

const SHOWN = ['name', 'url', 'method', 'intervalMin', 'expectedStatus', 'keyword', 'keywordMode', 'timeoutMs', 'headers', 'body', 'failAfter', 'slowMs', 'slowAfter', 'channelIds', 'hbPeriodSec', 'hbGraceSec', 'type'];

function MonitorForm({ v, errors, channels, action, editing }: { v: Values; errors: Errors; channels: ChannelRow[]; action: string; editing: boolean }) {
  const type = text(v, 'type', 'http');
  const picked = list(v, 'channelIds');
  return (
    <form method="post" action={action} class="stack mon-form" novalidate data-type={type}>
      <Problems errors={errors} shown={SHOWN} />
      <input type="hidden" name="type" value={type} />
      <Card title="What to watch" ruled>
        <div class="stack">
          <TextField id="name" label="Name" v={v} errors={errors} optional hint="Shown on alerts and status pages. We use the address if you leave it empty." maxlength={100} />
          {type === 'http' ? (
            <>
              <TextField id="url" label="Address" v={v} errors={errors} placeholder="https://example.com/health" inputmode="url" required />
              <div class="form-row">
                <Field id="method" label="Method" error={errors.method}>
                  <Select id="method" name="method" value={text(v, 'method', 'GET')} options={METHODS.map((m) => ({ value: m, label: m }))} />
                </Field>
                <Field id="intervalMin" label="Check" error={errors.intervalMin}>
                  <Select id="intervalMin" name="intervalMin" value={text(v, 'intervalMin', '5')} options={INTERVAL_OPTIONS.filter((o) => INTERVALS.includes(Number(o.value) as 1))} />
                </Field>
              </div>
            </>
          ) : (
            <div class="form-row">
              <Field id="hbPeriodSec" label="Your job runs" error={errors.hbPeriodSec}>
                <Select id="hbPeriodSec" name="hbPeriodSec" value={text(v, 'hbPeriodSec', '86400')} options={HB_PERIODS} />
              </Field>
              <TextField id="hbGraceMin" label="Wait before alerting (minutes)" v={v} errors={{ ...errors, hbGraceMin: errors.hbGraceSec ?? '' }} type="text" inputmode="numeric" hint="How late a ping can be before we call it down." />
            </div>
          )}
        </div>
      </Card>
      {type === 'http' ? (
        <Card title="What counts as up" ruled>
          <div class="stack">
            <div class="form-row">
              <TextField id="expectedStatus" label="Expected status" v={v} errors={errors} hint="Like 200, 200-299, or 2xx. Separate several with commas." />
              <TextField id="timeoutMs" label="Give up after (ms)" v={v} errors={errors} inputmode="numeric" hint="Between 1000 and 30000." />
            </div>
            <div class="form-row">
              <Field id="keywordMode" label="Look for a word on the page" error={errors.keywordMode}>
                <Select id="keywordMode" name="keywordMode" value={text(v, 'keywordMode', 'none')} options={MODES} />
              </Field>
              <TextField id="keyword" label="Word or phrase" v={v} errors={errors} optional />
            </div>
            <Toggle name="followRedirects" label="Follow redirects" description="Count the page it ends up on, up to 5 hops." checked={on(v, 'followRedirects', true)} />
            <details class="mon-more" open={!!errors.headers || !!errors.body || !!text(v, 'headers') || !!text(v, 'body')}>
              <summary>Headers and request body</summary>
              <div class="stack">
                <AreaField id="headers" label="Headers" v={v} errors={errors} optional rows={3} mono hint="One per line, like Authorization: Bearer token." />
                <AreaField id="body" label="Request body" v={v} errors={errors} optional rows={3} mono />
              </div>
            </details>
          </div>
        </Card>
      ) : null}
      <Card title="When to tell you" ruled>
        <div class="stack">
          <div class="form-row">
            <TextField id="failAfter" label="Down after this many failed checks" v={v} errors={errors} inputmode="numeric" hint="We re-check once straight away before counting a failure." />
            {type === 'http' ? <TextField id="slowMs" label="Slow alert over (ms)" v={v} errors={errors} optional inputmode="numeric" hint="Leave empty to turn it off." /> : null}
          </div>
          {type === 'http' ? <TextField id="slowAfter" label="Slow this many checks in a row" v={v} errors={errors} inputmode="numeric" /> : null}
          <Toggle name="autoIncident" label="Open an incident when it goes down" description="It shows on your status page and closes itself when the monitor recovers." checked={on(v, 'autoIncident', true)} />
          <fieldset class="mon-channels">
            <legend class="lbl">Who gets alerts</legend>
            <label class="check">
              <input type="radio" name="channelMode" value="all" checked={text(v, 'channelMode', 'all') === 'all'} />
              <span>
                <b>Every channel</b>
                <span>Including ones you add later.</span>
              </span>
            </label>
            <label class="check">
              <input type="radio" name="channelMode" value="pick" checked={text(v, 'channelMode') === 'pick'} />
              <span>
                <b>Only the ones I choose</b>
              </span>
            </label>
            {channels.length === 0 ? (
              <p class="muted">
                No channels yet. <a href={`${BASE}/alerts/new`}>Add one</a> after you save.
              </p>
            ) : (
              <div class="mon-pick">
                {channels.map((ch) => (
                  <label class="check">
                    <input type="checkbox" name="channelIds" value={ch.id} checked={picked.includes(ch.id)} />
                    <span>
                      <b>{ch.name}</b>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {errors.channelIds ? <p class="err-text">{errors.channelIds}</p> : null}
          </fieldset>
        </div>
      </Card>
      <div class="row">
        <Button type="submit" variant="primary">
          {editing ? 'Save changes' : 'Create monitor'}
        </Button>
        <LinkButton href={editing ? `${BASE}/m/${action.split('/')[4]}` : BASE}>Cancel</LinkButton>
      </div>
    </form>
  );
}

function monitorInput(v: Values): Record<string, unknown> {
  const heartbeat = text(v, 'type') === 'heartbeat';
  const input: Record<string, unknown> = {
    type: text(v, 'type', 'http'),
    name: text(v, 'name'),
    failAfter: text(v, 'failAfter'),
    autoIncident: on(v, 'autoIncident'),
    channelIds: text(v, 'channelMode', 'all') === 'pick' ? list(v, 'channelIds') : null,
  };
  if (heartbeat) {
    input.hbPeriodSec = text(v, 'hbPeriodSec');
    const grace = Number(text(v, 'hbGraceMin', '15'));
    input.hbGraceSec = Number.isFinite(grace) ? Math.round(grace * 60) : text(v, 'hbGraceMin');
  } else {
    Object.assign(input, {
      url: withScheme(text(v, 'url')),
      method: text(v, 'method'),
      intervalMin: text(v, 'intervalMin'),
      expectedStatus: text(v, 'expectedStatus'),
      timeoutMs: text(v, 'timeoutMs'),
      keywordMode: text(v, 'keywordMode', 'none'),
      keyword: text(v, 'keyword'),
      followRedirects: on(v, 'followRedirects'),
      headers: text(v, 'headers'),
      body: text(v, 'body'),
      slowMs: text(v, 'slowMs'),
      slowAfter: text(v, 'slowAfter'),
    });
  }
  return input;
}

async function formPage(c: C, opts: { title: string; v: Values; errors?: Errors; action: string; editing: boolean; monitor?: MonitorRow; status?: 422 }) {
  const ctx = await mctx(c);
  const channels = await listChannels(ctx);
  return renderPage(
    c,
    { title: opts.title, crumbs: [{ label: 'Monitors', href: BASE }, ...(opts.monitor ? [{ label: opts.monitor.name, href: `${BASE}/m/${opts.monitor.id}` }] : []), { label: opts.title }], status: opts.status },
    <>
      <Assets />
      <Back href={opts.monitor ? `${BASE}/m/${opts.monitor.id}` : BASE}>{opts.monitor ? opts.monitor.name : 'All monitors'}</Back>
      <PageHeader title={opts.title} description={text(opts.v, 'type') === 'heartbeat' ? 'For cron jobs and scripts. They ping us; we alert you when pings stop.' : 'We call this address on a schedule and tell you when it fails.'} />
      {!opts.editing ? (
        <Tabs
          label="Monitor type"
          active={text(opts.v, 'type', 'http')}
          items={[
            { id: 'http', label: 'Website or API', href: `${BASE}/new` },
            { id: 'heartbeat', label: 'Cron heartbeat', href: `${BASE}/new?type=heartbeat` },
          ]}
        />
      ) : null}
      <MonitorForm v={opts.v} errors={opts.errors ?? {}} channels={channels} action={opts.action} editing={opts.editing} />
    </>,
  );
}

app.get('/new', (c) => {
  const type = new URL(c.req.url).searchParams.get('type') === 'heartbeat' ? 'heartbeat' : 'http';
  return formPage(c, { title: 'New monitor', v: valuesOf(null, type), action: `${BASE}/new`, editing: false });
});

app.post('/new', async (c) => {
  const v = await readForm(c, ['channelIds']);
  const ctx = await mctx(c);
  try {
    const m = await createMonitor(ctx, monitorInput(v));
    await record(c, 'monitor.created', 'monitor', m.id, `Created monitor ${m.name}`);
    if (m.type === 'http') await checkNow(c.env, ctx.db.orgId, m);
    return c.redirect(`${BASE}/m/${m.id}?first=1`);
  } catch (e) {
    return failed(c, e, `${BASE}/new`, (errors) => formPage(c, { title: 'New monitor', v, errors, action: `${BASE}/new`, editing: false, status: 422 }));
  }
});

app.get('/m/:id/edit', async (c) => {
  const m = await getMonitor(await mctx(c), c.req.param('id'));
  return formPage(c, { title: 'Edit monitor', v: valuesOf(m, m.type), action: `${BASE}/m/${m.id}/edit`, editing: true, monitor: m });
});

app.post('/m/:id/edit', async (c) => {
  const ctx = await mctx(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const v = await readForm(c, ['channelIds']);
  v.type = m.type;
  try {
    const next = await updateMonitor(ctx, m.id, monitorInput(v));
    await record(c, 'monitor.updated', 'monitor', m.id, `Updated monitor ${next.name}`);
    return done(c, 'Changes saved.', `${BASE}/m/${m.id}`);
  } catch (e) {
    return failed(c, e, `${BASE}/m/${m.id}/edit`, (errors) => formPage(c, { title: 'Edit monitor', v, errors, action: `${BASE}/m/${m.id}/edit`, editing: true, monitor: m, status: 422 }));
  }
});

export default app;
