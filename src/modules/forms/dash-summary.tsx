/** Per-form stats: traffic, completion, drop-off by question and score summaries. */
import { Hono } from 'hono';
import { orgDb } from '../../core/db';
import type { AppEnv } from '../../env';
import { BarChart, Callout, Card, EmptyState, FilterBar, PageHeader, Select, Stat, formatNumber, renderPage } from '../../ui';
import { BASE, CSS, STYLES, FormTabs, crumbs, str, type C } from './dash-common';
import { intParam } from './http';
import { getDraft, getForm, getPublished } from './service';
import { rangeDays, summary, type QuestionStat } from './stats';

export const summaryRoutes = new Hono<AppEnv>();

/** Bar widths are classes in 5% steps, because inline styles are not allowed. */
const w = (n: number, of: number) => `fm-w${Math.max(n > 0 ? 5 : 0, Math.round((of > 0 ? (n / of) * 100 : 0) / 5) * 5)}`;
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

function Bars({ items }: { items: { label: string; n: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <div class="fm-stack">
      {items.map((i) => (
        <div class="fm-bar">
          <span>{i.label}</span>
          <span class="track"><i class={w(i.n, max)} /></span>
          <span class="num">{formatNumber(i.n)}</span>
        </div>
      ))}
    </div>
  );
}

function Question({ q }: { q: QuestionStat }) {
  return (
    <Card title={q.label || 'Untitled question'} description={`${formatNumber(q.answered)} answered`}>
      {q.tallies && q.tallies.length ? <Bars items={q.tallies.map((t) => ({ label: t.label, n: t.n }))} /> : null}
      {q.average !== undefined ? <p>Average <b>{q.average.toFixed(1)}</b></p> : null}
      {q.nps !== undefined ? <p>Net promoter score <b>{q.nps}</b></p> : null}
      {q.csat !== undefined ? <p>Satisfied <b>{q.csat}%</b></p> : null}
      {!q.tallies?.length && q.average === undefined ? <p class="fm-muted">Open answers are on the Responses tab.</p> : null}
    </Card>
  );
}

summaryRoutes.get('/:id/summary', async (c: C) => {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, c.req.param('id') ?? '');
  const def = (await getPublished(db, form)) ?? (await getDraft(db, form));
  const days = [7, 30, 90].includes(intParam(c.req.query('days'), 30, 1, 365)) ? intParam(c.req.query('days'), 30, 1, 365) : 30;
  const s = await summary(db, form.id, def, rangeDays(days));
  const empty = s.views === 0 && s.starts === 0 && s.completes === 0;
  const scored = s.questions.filter((q) => q.tallies || q.average !== undefined || q.nps !== undefined || q.csat !== undefined);
  return renderPage(
    c,
    { title: `Summary of ${form.name}`, crumbs: crumbs(form, 'Summary'), styles: STYLES },
    <>
      {CSS}
      <PageHeader title={form.name} description="How people move through the form." />
      <FormTabs form={form} active="summary" />
      <FilterBar action={`${BASE}/${form.id}/summary`}>
        <Select id="fm-days" name="days" aria-label="Time range" value={String(days)} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />
      </FilterBar>
      {empty ? (
        <EmptyState icon="chart" title="Nothing to show yet" body="Views, starts and completions appear here once people open the form. Counts come from daily totals, not from each visit." actions={<a class="btn primary" href={`${BASE}/${form.id}/share`}>Share the form</a>} />
      ) : (
        <>
          <div class="fm-grid2">
            <Stat label="Views" value={formatNumber(s.views)} />
            <Stat label="Started" value={formatNumber(s.starts)} />
            <Stat label="Completed" value={formatNumber(s.completes)} />
            <Stat label="Completion rate" value={s.rate === null ? '-' : `${s.rate}%`} note="Completed out of started" />
            <Stat label="Median time" value={s.medianSeconds === null ? '-' : `${s.medianSeconds}`} unit={s.medianSeconds === null ? undefined : 'seconds'} />
          </div>
          {s.daily.length ? <BarChart title="Completed per day" data={s.daily.map((d) => ({ label: d.day.slice(5), value: d.completes }))} /> : null}
          <Card title="Where people drop off" description="Each bar is the share of people who reached that question and left without going further.">
            <ol class="fm-funnel">
              {s.questions.map((q) => (
                <li>
                  <span>{q.label || 'Untitled question'}</span>
                  <span class="fm-muted">
                    {formatNumber(q.reached)} reached, {formatNumber(q.answered)} answered, {formatNumber(q.leftHere)} left here ({pct(q.leftHere, q.reached)}%)
                  </span>
                  <span class="fm-bar"><span class="track"><i class={w(q.leftHere, q.reached)} /></span></span>
                </li>
              ))}
            </ol>
          </Card>
          {scored.length ? <div class="fm-grid2">{scored.map((q) => <Question q={q} />)}</div> : null}
          {s.spam > 0 ? <Callout tone="info" title={`${formatNumber(s.spam)} spam blocked or marked`}>Spam is kept for 30 days in the Spam folder, then deleted.</Callout> : null}
          {s.partials > 0 ? <p class="fm-muted">{formatNumber(s.partials)} partial responses were saved in this range.</p> : null}
        </>
      )}
    </>,
  );
});
