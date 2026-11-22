/** Stats: signups by day, the growth loop, where people came from and who brings the most friends. */
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import { BarChart, Card, EmptyState, PageHeader, Stat, StatGrid, Table } from '../../../ui';
import { formatNumber } from '../../../ui/format';
import { reviewCount } from '../review';
import { waitlistStats } from '../stats';
import { ListNav, pickList, ROOT, scopeOf, renderPage } from './common';

export const stats = new Hono<AppEnv>();

stats.get('/stats', async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const days = c.req.query('days') === '7' ? 7 : 30;
  const [s, held] = await Promise.all([waitlistStats(db, wl, days), reviewCount(db, wl.id)]);
  const inPeriod = s.signups.reduce((a, b) => a + b, 0);
  return renderPage(c, { title: `${wl.name} stats`, crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name }] }, (
    <>
      <PageHeader title={wl.name} description="Preview and test signups are never counted here." />
      {ListNav({ lists, wl, active: 'stats', counts: { review: held } })}
      <StatGrid>
        <Stat label="On the list" value={formatNumber(s.total)} note={`${formatNumber(inPeriod)} in the last ${days} days`} />
        <Stat label="Confirmed" value={formatNumber(s.confirmed)} note={s.total ? `${Math.round((s.confirmed / s.total) * 100)}% of the list` : 'No one yet'} />
        <Stat label="Referral growth" value={s.kFactor.toFixed(2)} note={`${formatNumber(s.credited)} credited referrals. Above 1 means it grows by itself.`} />
        <Stat label="Views to signup" value={s.conversion === null ? 'No views' : `${s.conversion}%`} note={`${formatNumber(s.views)} page views`} />
      </StatGrid>
      <Card title="Signups by day" actions={<nav class="wl-range" aria-label="Range"><a href={`?w=${wl.id}&days=7`} aria-current={days === 7 ? 'page' : undefined}>7 days</a><a href={`?w=${wl.id}&days=30`} aria-current={days === 30 ? 'page' : undefined}>30 days</a></nav>}>
        {inPeriod ? <BarChart title="Signups by day" unit="signups" data={s.labels.map((l, i) => ({ label: l, value: s.signups[i] ?? 0 }))} /> : <EmptyState bare icon="chart" title="No signups in this period" body="Share your signup page and the chart fills in." />}
      </Card>
      <div class="wl-two">
        <Card title="Where people came from" flush>
          <Table caption="Sources" empty={<EmptyState bare title="No sources yet" />} columns={[{ key: 'src', label: 'Source' }, { key: 'n', label: 'People', numeric: true }]} rows={s.sources.map((r) => ({ src: r.label, n: formatNumber(r.count) }))} />
        </Card>
        <Card title="Top referrers" flush>
          <Table caption="Top referrers" empty={<EmptyState bare title="No referrals yet" body="Confirmed referrals show up here." />} columns={[{ key: 'who', label: 'Person' }, { key: 'n', label: 'Referrals', numeric: true }]} rows={s.topReferrers.map((r) => ({ who: r.name || r.email, n: formatNumber(r.referrals) }))} />
        </Card>
      </div>
    </>
  ));
});
