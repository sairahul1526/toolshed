/** How many images were made and served, which ones are asked for most, and what went wrong. */
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import { BarChart, Callout, Card, EmptyState, PageHeader, Pill, Stat, StatGrid, Table, Tabs, formatBytes, formatDateTime, formatNumber, timeAgo } from '../../../ui';
import { HOME, More, isAdmin, page, query } from '../dash-shared';
import { scopeOf } from '../http';
import { getSettings } from '../settings';
import { listTemplates } from '../templates';
import { listLog, topImages, usageSummary, type RenderSource } from '../usage';

const SOURCES: Record<RenderSource, string> = { url: 'Image URL', api: 'API', batch: 'Batch', bake: 'Made in the browser' };
const PERIODS = [7, 30, 90];

const usage = new Hono<AppEnv>();

usage.get('/usage', async (c) => {
  const s = scopeOf(c);
  const q = c.req.query();
  const days = PERIODS.includes(Number(q.days)) ? Number(q.days) : 30;
  const errorsOnly = q.errors === '1';
  const [summary, top, log, settings, templates] = await Promise.all([
    usageSummary(s.db, { days }),
    q.cursor ? Promise.resolve([]) : topImages(s.db, 10),
    listLog(s.db, { limit: 25, cursor: q.cursor ?? null, errorsOnly }),
    getSettings(s.env, s.db.orgId),
    listTemplates(s.db, { limit: 100 }),
  ]);
  const names = new Map(templates.items.map((t) => [t.id, t.name]));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'A deleted template') : 'Unknown');
  const { totals } = summary;
  const served = totals.renders + totals.hits;
  const capLeft = Math.max(0, settings.dailyCap - summary.today);
  const nearCap = settings.dailyCap > 0 && summary.today >= settings.dailyCap * 0.8;

  const topRows = top.map((image) => ({
    image: (
      <div class="img-cell">
        <span class="img-name">{nameOf(image.templateId)}</span>
        <span class="muted img-small trunc">{image.query || 'Default values'}</span>
      </div>
    ),
    kind: `${image.format.toUpperCase()}, ${image.width} px`,
    hits: formatNumber(image.hits),
    last: image.lastHitAt ? timeAgo(new Date(image.lastHitAt)) : 'Not yet',
  }));

  const logRows = log.items.map((entry) => ({
    at: formatDateTime(new Date(entry.at)),
    what: (
      <div class="img-cell">
        <span>{nameOf(entry.templateId)}</span>
        {entry.outcome === 'error' ? <span class="field-error img-small">{entry.detail || entry.code || 'Could not be drawn'}</span> : null}
      </div>
    ),
    outcome: entry.outcome === 'error' ? <Pill tone="bad">Failed</Pill> : <Pill tone="good">Made</Pill>,
    source: `${SOURCES[entry.source] ?? entry.source}${entry.format ? `, ${entry.format.toUpperCase()}` : ''}`,
    ms: entry.ms === null ? '' : `${formatNumber(entry.ms)} ms`,
    bytes: entry.bytes === null ? '' : formatBytes(entry.bytes),
  }));

  return page(c, 'Usage', (
    <>
      <PageHeader title="Usage" description="Days and times are in UTC. Images served from storage are counted once an hour." />
      {settings.dailyCap === 0 ? (
        <Callout tone="warn" title="New images are switched off">The daily limit is 0, so only images already made are served.{isAdmin(c) ? ' Change it in Settings.' : ''}</Callout>
      ) : nearCap ? (
        <Callout tone="warn" title={capLeft === 0 ? 'Today’s limit is reached' : 'Close to today’s limit'}>
          {formatNumber(summary.today)} of {formatNumber(settings.dailyCap)} new images made today. Images already made keep working. The limit resets at midnight UTC.
        </Callout>
      ) : null}
      <Tabs label="Period" active={String(days)} items={PERIODS.map((n) => ({ id: String(n), label: `${n} days`, href: `${HOME}/usage${query({ days: n === 30 ? undefined : String(n) })}` }))} />
      <StatGrid>
        <Stat label="New images" value={formatNumber(totals.renders)} note={`${formatNumber(summary.today)} today, limit ${formatNumber(settings.dailyCap)} a day`} icon="image" />
        <Stat label="Served from storage" value={formatNumber(totals.hits)} note={served ? `${Math.round((totals.hits / served) * 100)}% of all image requests` : 'No requests yet'} icon="cloud" />
        <Stat label="Size of new images" value={formatBytes(totals.bytes)} icon="db" />
        <Stat label="Failed" value={formatNumber(totals.errors)} note={totals.errors ? 'See the list below' : 'Nothing went wrong'} icon="alert" />
      </StatGrid>
      <Card title="Image requests by day">
        {served === 0 ? (
          <EmptyState icon="chart" title="No image requests in this period" body="Copy an image URL from a template and open it. The request shows here." bare />
        ) : (
          <BarChart title={`Image requests in the last ${days} days`} data={summary.days.map((d) => ({ label: d.day.slice(5), value: d.renders + d.hits }))} />
        )}
      </Card>
      {q.cursor ? null : (
        <Card title="Most requested images" description="How many times each stored image was asked for again after it was made." flush>
          {topRows.length === 0 ? (
            <EmptyState icon="image" title="No stored images yet" body="An image is stored the first time its URL is opened." bare />
          ) : (
            <Table
              caption="Most requested images"
              columns={[
                { key: 'image', label: 'Image' },
                { key: 'kind', label: 'File', hideOnMobile: true },
                { key: 'hits', label: 'Served from storage', numeric: true },
                { key: 'last', label: 'Last served', hideOnMobile: true },
              ]}
              rows={topRows}
            />
          )}
        </Card>
      )}
      <Card title="New images and failures" description="Kept for 30 days. Requests served from storage are counted above, not listed. Time is mostly the wait for fonts and pictures: Cloudflare stops the clock while a Worker computes, so a quick draw reads 0 ms." flush>
        <Tabs
          label="Which lines"
          active={errorsOnly ? 'errors' : 'all'}
          items={[
            { id: 'all', label: 'Everything', href: `${HOME}/usage${query({ days: days === 30 ? undefined : String(days) })}` },
            { id: 'errors', label: 'Failures only', href: `${HOME}/usage${query({ days: days === 30 ? undefined : String(days), errors: '1' })}` },
          ]}
        />
        {logRows.length === 0 ? (
          <EmptyState icon="list" title={errorsOnly ? 'No failures' : 'Nothing made yet'} body={errorsOnly ? 'Every image in the last 30 days was drawn without a problem.' : 'Each new image shows here with how long it took.'} bare />
        ) : (
          <Table
            caption="New images and failures"
            columns={[
              { key: 'at', label: 'When' },
              { key: 'what', label: 'Template' },
              { key: 'outcome', label: 'Result' },
              { key: 'source', label: 'Asked through', hideOnMobile: true },
              { key: 'ms', label: 'Time', numeric: true, hideOnMobile: true },
              { key: 'bytes', label: 'Size', numeric: true, hideOnMobile: true },
            ]}
            rows={logRows}
          />
        )}
      </Card>
      <More href={log.nextCursor ? `${HOME}/usage${query({ days: days === 30 ? undefined : String(days), errors: errorsOnly ? '1' : undefined, cursor: log.nextCursor })}` : null} label="Show older lines" />
    </>
  ));
});

export { usage };
