/** Incidents: open ones, history, a timeline per incident, updates and a postmortem. */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import { z } from 'zod';
import { parse } from '../../../core/errors';
import { renderMarkdown } from '../../../core/markdown';
import type { AppEnv } from '../../../env';
import { Button, Card, ConfirmButton, EmptyState, Field, LinkButton, PageHeader, Pill, Select, Tabs, Table, formatDateTime, renderPage, timeAgo } from '../../../ui';
import { fmtDuration } from '../fmt';
import { deleteIncident, editIncident, getIncident, incidentUpdates, listIncidents, openIncident, postUpdate } from '../incidents';
import { IMPACTS, INCIDENT_STATUSES, ids, type IncidentRow } from '../schema';
import { Assets, AreaField, BASE, Back, Problems, TextField, failed, done, list, mctx, readForm, record, text, type C, type Errors, type Values } from './common';

const app = new Hono<AppEnv>();

const STATUS_LABEL: Record<string, string> = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
const IMPACT_LABEL: Record<string, string> = { minor: 'Minor', major: 'Major', critical: 'Critical' };
const statusOptions = INCIDENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] ?? s }));
const impactOptions = IMPACTS.map((s) => ({ value: s, label: IMPACT_LABEL[s] ?? s }));

export const ImpactPill = ({ impact }: { impact: string }) => <Pill tone={impact === 'minor' ? 'warn' : 'bad'}>{IMPACT_LABEL[impact] ?? impact}</Pill>;
export const IncidentStatusPill = ({ status }: { status: string }) => <Pill tone={status === 'resolved' ? 'good' : 'warn'}>{STATUS_LABEL[status] ?? status}</Pill>;

async function componentChoices(c: C) {
  const ctx = await mctx(c);
  return ctx.db.all<{ id: string; name: string; page_title: string }>(
    'SELECT c.id AS id, c.name AS name, p.title AS page_title FROM mon_components c JOIN mon_pages p ON p.id = c.page_id AND p.org_id = c.org_id WHERE c.org_id = :org ORDER BY p.title, c.position LIMIT 200',
  );
}

/* ------------------------------------------------------------ list */

const listQuery = z.object({ show: z.enum(['open', 'all']).default('open') });

app.get('/incidents', async (c) => {
  const ctx = await mctx(c);
  const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
  const rows = await listIncidents(ctx, { open: q.show === 'open' ? true : undefined, limit: 100 });
  return renderPage(
    c,
    { title: 'Incidents', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Incidents' }] },
    <>
      <Assets />
      <PageHeader
        title="Incidents"
        description="What went wrong and what we did about it. Open ones show on your status page."
        actions={
          <LinkButton variant="primary" icon="plus" href={`${BASE}/incidents/new`}>
            New incident
          </LinkButton>
        }
      />
      <Tabs
        label="Show"
        active={q.show}
        items={[
          { id: 'open', label: 'Open', href: `${BASE}/incidents` },
          { id: 'all', label: 'All', href: `${BASE}/incidents?show=all` },
        ]}
      />
      <Card flush>
        <Table
          caption="Incidents"
          columns={[
            { key: 'title', label: 'Incident' },
            { key: 'status', label: 'Status' },
            { key: 'impact', label: 'Impact', hideOnMobile: true },
            { key: 'when', label: 'Started', hideOnMobile: true },
            { key: 'length', label: 'Lasted', numeric: true, hideOnMobile: true },
          ]}
          rows={rows.map((i) => ({
            title: (
              <a class="mon-name" href={`${BASE}/incidents/${i.id}`}>
                <b>{i.title}</b>
                {i.auto ? <span>Opened automatically</span> : null}
              </a>
            ),
            status: <IncidentStatusPill status={i.status} />,
            impact: <ImpactPill impact={i.impact} />,
            when: formatDateTime(i.started_at),
            length: i.resolved_at ? fmtDuration(i.resolved_at - i.started_at) : 'Ongoing',
          }))}
          empty={
            <EmptyState
              bare
              icon="check"
              title={q.show === 'open' ? 'No open incidents' : 'No incidents yet'}
              body={q.show === 'open' ? 'Everything is running. Incidents open by themselves when a monitor goes down.' : 'When something goes wrong it shows here, with a timeline.'}
              actions={<LinkButton href={`${BASE}/incidents/new`}>Open one by hand</LinkButton>}
            />
          }
        />
      </Card>
    </>,
  );
});

/* ------------------------------------------------------------ new */

async function newForm(c: C, v: Values = {}, errors: Errors = {}, status?: 422) {
  const comps = await componentChoices(c);
  const picked = list(v, 'componentIds');
  return renderPage(
    c,
    { title: 'New incident', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Incidents', href: `${BASE}/incidents` }, { label: 'New' }], status },
    <>
      <Assets />
      <Back href={`${BASE}/incidents`}>All incidents</Back>
      <PageHeader title="New incident" description="Tell your customers what is happening. You can add updates as it goes." />
      <form method="post" action={`${BASE}/incidents/new`} class="stack" novalidate>
        <Problems errors={errors} shown={['title', 'status', 'impact', 'body', 'componentIds']} />
        <Card>
          <div class="stack">
            <TextField id="title" label="Title" v={v} errors={errors} maxlength={150} placeholder="Checkout is slow" />
            <div class="form-row">
              <Field id="status" label="Status" error={errors.status}>
                <Select id="status" name="status" value={text(v, 'status', 'investigating')} options={statusOptions.filter((o) => o.value !== 'resolved')} />
              </Field>
              <Field id="impact" label="Impact" error={errors.impact}>
                <Select id="impact" name="impact" value={text(v, 'impact', 'minor')} options={impactOptions} />
              </Field>
            </div>
            <AreaField id="body" label="First message" v={v} errors={errors} optional rows={4} hint="Plain words. Markdown works." />
            {comps.length > 0 ? (
              <fieldset class="mon-channels">
                <legend class="lbl">Affected components</legend>
                <div class="mon-pick">
                  {comps.map((x) => (
                    <label class="check">
                      <input type="checkbox" name="componentIds" value={x.id} checked={picked.includes(x.id)} />
                      <span>
                        <b>{x.name}</b>
                        <span>{x.page_title}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        </Card>
        <div class="row">
          <Button type="submit" variant="primary">
            Open incident
          </Button>
          <LinkButton href={`${BASE}/incidents`}>Cancel</LinkButton>
        </div>
      </form>
    </>,
  );
}

app.get('/incidents/new', (c) => newForm(c));

app.post('/incidents/new', async (c) => {
  const v = await readForm(c, ['componentIds']);
  const ctx = await mctx(c);
  try {
    const i = await openIncident(ctx, { title: text(v, 'title'), status: text(v, 'status', 'investigating'), impact: text(v, 'impact', 'minor'), body: text(v, 'body'), componentIds: list(v, 'componentIds') }, { author: c.get('user')?.email ?? null });
    await record(c, 'monitor.incident_opened', 'incident', i.id, `Opened incident ${i.title}`);
    return done(c, 'Incident opened. It shows on your status page now.', `${BASE}/incidents/${i.id}`);
  } catch (e) {
    return failed(c, e, `${BASE}/incidents/new`, (errors) => newForm(c, v, errors, 422));
  }
});

/* ------------------------------------------------------------ detail */

async function detail(c: C, id: string, v: Values = {}, errors: Errors = {}, status?: 422) {
  const ctx = await mctx(c);
  const i = await getIncident(ctx, id);
  const updates = await incidentUpdates(ctx, i.id);
  const comps = await componentChoices(c);
  const affected = new Set(ids(i.component_ids));
  const resolved = i.status === 'resolved';
  return renderPage(
    c,
    { title: i.title, crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Incidents', href: `${BASE}/incidents` }, { label: i.title }], status },
    <>
      <Assets />
      <Back href={`${BASE}/incidents`}>All incidents</Back>
      <PageHeader
        title={i.title}
        soft={<IncidentStatusPill status={i.status} />}
        description={`Started ${formatDateTime(i.started_at)}${i.resolved_at ? `, lasted ${fmtDuration(i.resolved_at - i.started_at)}` : `, ${timeAgo(i.started_at)}`}.`}
        actions={
          <>
            <ImpactPill impact={i.impact} />
            {i.monitor_id ? <LinkButton href={`${BASE}/m/${i.monitor_id}`}>See the monitor</LinkButton> : null}
          </>
        }
      />
      <div class="grid-2">
        <div class="stack">
          <Card title="Post an update" description="Everyone who follows your status page hears about it.">
            <form method="post" action={`${BASE}/incidents/${i.id}/update`} class="stack" novalidate>
              <Problems errors={errors} shown={['status', 'body']} />
              <Field id="status" label="Status" error={errors.status}>
                <Select id="status" name="status" value={text(v, 'status', i.status === 'resolved' ? 'monitoring' : i.status)} options={statusOptions} />
              </Field>
              <AreaField id="body" label="What changed" v={v} errors={errors} rows={3} hint="Plain words. Markdown works." />
              <div>
                <Button type="submit" variant="primary">
                  {resolved ? 'Reopen with an update' : 'Post update'}
                </Button>
              </div>
            </form>
          </Card>
          <Card title="Timeline" flush>
            {updates.length === 0 ? (
              <EmptyState bare icon="history" title="No updates yet" body="Post the first one above." />
            ) : (
              <ol class="mon-timeline">
                {[...updates].reverse().map((u) => (
                  <li>
                    <div class="mon-tl-head">
                      <IncidentStatusPill status={u.status} />
                      <span class="muted">
                        {formatDateTime(u.at)}
                        {u.author ? ` by ${u.author}` : ''}
                      </span>
                    </div>
                    <div class="prose">{raw(renderMarkdown(u.body))}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
        <div class="stack">
          <Card title="Details" description="Title, impact and the components it touches.">
            <form method="post" action={`${BASE}/incidents/${i.id}/edit`} class="stack" novalidate>
              <TextField id="title" label="Title" v={{ title: text(v, 'title', i.title) }} errors={errors} maxlength={150} />
              <Field id="impact" label="Impact">
                <Select id="impact" name="impact" value={i.impact} options={impactOptions} />
              </Field>
              {comps.length > 0 ? (
                <fieldset class="mon-channels">
                  <legend class="lbl">Affected components</legend>
                  <div class="mon-pick">
                    {comps.map((x) => (
                      <label class="check">
                        <input type="checkbox" name="componentIds" value={x.id} checked={affected.has(x.id)} />
                        <span>
                          <b>{x.name}</b>
                          <span>{x.page_title}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <div>
                <Button type="submit">Save details</Button>
              </div>
            </form>
          </Card>
          <Card title="Postmortem" description="What happened and what you changed. It shows on the status page once the incident is resolved.">
            <form method="post" action={`${BASE}/incidents/${i.id}/postmortem`} class="stack" novalidate>
              <AreaField id="postmortem" label="Write-up" v={{ postmortem: text(v, 'postmortem', i.postmortem ?? '') }} errors={errors} optional rows={8} hint="Markdown works." />
              <div>
                <Button type="submit">Save postmortem</Button>
              </div>
            </form>
          </Card>
          <form method="post" action={`${BASE}/incidents/${i.id}/delete`}>
            <ConfirmButton id={`delete-${i.id}`} title="Delete this incident?" body="The timeline and postmortem go with it, and it leaves your status page history. This can’t be undone." confirmLabel="Delete incident" icon="trash">
              Delete incident
            </ConfirmButton>
          </form>
        </div>
      </div>
    </>,
  );
}

app.get('/incidents/:id', (c) => detail(c, c.req.param('id')));

app.post('/incidents/:id/update', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  const ctx = await mctx(c);
  try {
    const i = await postUpdate(ctx, id, { status: text(v, 'status'), body: text(v, 'body') }, { author: c.get('user')?.email ?? null });
    await record(c, 'monitor.incident_update', 'incident', i.id, `Posted an update on ${i.title}`);
    return done(c, 'Update posted.', `${BASE}/incidents/${id}`);
  } catch (e) {
    return failed(c, e, `${BASE}/incidents/${id}`, (errors) => detail(c, id, v, errors, 422));
  }
});

app.post('/incidents/:id/edit', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c, ['componentIds']);
  const ctx = await mctx(c);
  try {
    const i = await editIncident(ctx, id, { title: text(v, 'title'), impact: text(v, 'impact') as IncidentRow['impact'], componentIds: list(v, 'componentIds') });
    await record(c, 'monitor.incident_updated', 'incident', i.id, `Edited incident ${i.title}`);
    return done(c, 'Details saved.', `${BASE}/incidents/${id}`);
  } catch (e) {
    return failed(c, e, `${BASE}/incidents/${id}`, (errors) => detail(c, id, v, errors, 422));
  }
});

app.post('/incidents/:id/postmortem', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  const ctx = await mctx(c);
  const i = await editIncident(ctx, id, { postmortem: text(v, 'postmortem').trim() || null });
  await record(c, 'monitor.incident_updated', 'incident', i.id, `Saved the postmortem for ${i.title}`);
  return done(c, 'Postmortem saved.', `${BASE}/incidents/${id}`);
});

app.post('/incidents/:id/delete', async (c) => {
  const ctx = await mctx(c);
  const i = await getIncident(ctx, c.req.param('id'));
  await deleteIncident(ctx, i.id);
  await record(c, 'monitor.incident_deleted', 'incident', i.id, `Deleted incident ${i.title}`);
  return done(c, 'Incident deleted.', `${BASE}/incidents`);
});

export default app;
