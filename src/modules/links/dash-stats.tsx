/** Stats for the whole workspace or one link: clicks and unique visitors by day, and where visits came from. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { BarChart, Callout, Card, EmptyState, LineChart, PageHeader, Stat, StatGrid, Table, formatNumber, LinkButton } from '../../ui';
import { HOME, safely } from './dash-shared';
import { ctxOf } from './ctx';
import { getLink } from './links';
import { getStats, topLinks, type Dim } from './stats';

export const statsScreen = new Hono<AppEnv>();

const RANGES = [7, 30, 90];

const PANELS: { dim: Dim; title: string }[] = [
  { dim: 'referrer', title: 'Referrers' },
  { dim: 'country', title: 'Countries' },
  { dim: 'city', title: 'Cities' },
  { dim: 'device', title: 'Devices' },
  { dim: 'browser', title: 'Browsers' },
  { dim: 'os', title: 'Systems' },
  { dim: 'utm_source', title: 'UTM source' },
  { dim: 'utm_medium', title: 'UTM medium' },
  { dim: 'utm_campaign', title: 'UTM campaign' },
];

statsScreen.get('/stats', (c) =>
  safely(c, 'Stats', async () => {
    const ctx = ctxOf(c);
    const days = RANGES.includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 30;
    const linkId = c.req.query('link') ?? '';
    const link = linkId ? await getLink(ctx, linkId) : null;
    const [stats, top] = await Promise.all([getStats(ctx, { targetId: link?.id, days, top: 8 }), link ? Promise.resolve([]) : topLinks(ctx, { days, limit: 10 })]);
    const scope = link ? `?link=${link.id}&` : '?';
    const quiet = stats.totals.clicks === 0 && stats.totals.bots === 0;
    return (
      <>
        <PageHeader
          title={link ? `Stats for ${link.title || `/${link.code}`}` : 'Stats'}
          description={`Clicks from ${stats.from} to ${stats.to}. Days are counted in UTC.`}
          actions={
            <nav class="lk-range" aria-label="Date range">
              {RANGES.map((d) => <a href={`${HOME}/stats${scope}days=${d}`} aria-current={d === days ? 'true' : undefined} class="btn sm">{`${d} days`}</a>)}
            </nav>
          }
        />
        {link ? <p class="lk-back"><a href={`${HOME}/${link.id}`}>Back to the link</a></p> : null}
        <StatGrid>
          <Stat label="Clicks" value={formatNumber(stats.totals.clicks)} icon="pulse" />
          <Stat label="Unique visitors" value={formatNumber(stats.totals.uniques)} icon="users" />
          <Stat label="QR scans" value={formatNumber(stats.totals.qr)} icon="grid" />
          <Stat label="Bots and previews" value={formatNumber(stats.totals.bots)} note="Counted apart from clicks" icon="shield" />
        </StatGrid>
        {quiet ? <Callout tone="info" title="No clicks in this range yet">Share the short link and they will show up here. Empty days are shown as zero.</Callout> : null}
        <Card title="Clicks by day">
          <LineChart title="Clicks and unique visitors by day" labels={stats.days.map((d) => d.day.slice(5))} series={[{ label: 'Clicks', values: stats.days.map((d) => d.clicks) }, { label: 'Unique visitors', values: stats.days.map((d) => d.uniques) }]} />
        </Card>
        <div class="grid-2 lk-panels">
          {PANELS.map((p) => {
            const slices = stats.breakdowns[p.dim] ?? [];
            return (
              <Card title={p.title}>
                {slices.length ? <BarChart title={p.title} data={slices.map((s) => ({ label: s.value || 'Unknown', value: s.clicks }))} unit="clicks" /> : <p class="muted">No data yet.</p>}
              </Card>
            );
          })}
        </div>
        {!link ? (
          <Card title="Top links" flush>
            <Table
              caption="Links with the most clicks"
              columns={[{ key: 'link', label: 'Link' }, { key: 'clicks', label: 'Clicks', numeric: true }]}
              rows={top.map((t) => ({ link: <a href={`${HOME}/stats?link=${t.id}&days=${days}`}>{t.title || `/${t.code}`}</a>, clicks: formatNumber(t.clicks) }))}
              empty={<EmptyState icon="chart" title="No clicks yet" body="Your most clicked links will be listed here." actions={<LinkButton href={HOME}>Back to links</LinkButton>} bare />}
            />
          </Card>
        ) : null}
      </>
    );
  }),
);
