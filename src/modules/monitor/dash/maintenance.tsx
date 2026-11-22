/** Maintenance windows: one-off or repeating quiet periods. Alerts pause and the status page says so. */
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import { Button, Card, ConfirmButton, EmptyState, Field, LinkButton, PageHeader, Pill, Select, Table, formatDateTime, renderPage } from '../../../ui';
import { fmtDuration } from '../fmt';
import { createMaintenance, currentOrNext, deleteMaintenance, getMaintenance, listMaintenance, updateMaintenance, workspaceZone } from '../maintenance';
import { listMonitors } from '../monitors';
import { RECURRENCES, ids, type MaintenanceRow } from '../schema';
import { localParts, localToUtc } from '../time';
import { Assets, AreaField, BASE, Back, Problems, TextField, Toggle, failed, done, list, mctx, on, readForm, record, text, type C, type Errors, type Values } from './common';

const app = new Hono<AppEnv>();

const REPEAT_LABEL: Record<string, string> = { none: 'Once', daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };
const pad = (n: number) => String(n).padStart(2, '0');

const toLocal = (tz: string, ms: number): string => {
  const p = localParts(tz, ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
};

/** Turn what the person typed (in the workspace time zone) into a time we store. Returns the text back when it is not a date. */
const fromLocal = (tz: string, value: string): number | string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return value;
  return localToUtc(tz, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
};

/* ------------------------------------------------------------ list */

app.get('/maintenance', async (c) => {
  const ctx = await mctx(c);
  const tz = await workspaceZone(c.env, ctx.db.orgId);
  const rows = await listMaintenance(ctx);
  const now = Date.now();
  const entries = rows.map((m) => ({ m, occ: currentOrNext(m, tz, now) }));
  const state = (e: (typeof entries)[number]) => (!e.occ ? 'past' : e.occ.start <= now && now < e.occ.end ? 'now' : 'next');
  return renderPage(
    c,
    { title: 'Maintenance', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Maintenance' }] },
    <>
      <Assets />
      <PageHeader
        title="Maintenance"
        description="Planned work. Alerts pause for the monitors you pick, and your status page shows the window."
        actions={
          <LinkButton variant="primary" icon="plus" href={`${BASE}/maintenance/new`}>
            Schedule maintenance
          </LinkButton>
        }
      />
      <Card flush>
        <Table
          caption="Maintenance windows"
          columns={[
            { key: 'title', label: 'Window' },
            { key: 'state', label: 'State' },
            { key: 'when', label: 'When', hideOnMobile: true },
            { key: 'repeat', label: 'Repeats', hideOnMobile: true },
          ]}
          rows={entries.map((e) => ({
            title: (
              <a class="mon-name" href={`${BASE}/maintenance/${e.m.id}`}>
                <b>{e.m.title}</b>
                <span>{ids(e.m.monitor_ids).length === 0 ? 'Every monitor' : `${ids(e.m.monitor_ids).length} monitors`}</span>
              </a>
            ),
            state: state(e) === 'now' ? <Pill tone="warn">In progress</Pill> : state(e) === 'next' ? <Pill>Scheduled</Pill> : <Pill>Finished</Pill>,
            when: e.occ ? `${formatDateTime(e.occ.start)}, ${fmtDuration(e.m.duration_min * 60_000)}` : formatDateTime(e.m.starts_at),
            repeat: REPEAT_LABEL[e.m.recurrence] ?? e.m.recurrence,
          }))}
          empty={<EmptyState bare icon="calendar" title="No maintenance planned" body="Schedule a window before you deploy or move servers, so nobody gets paged for it." actions={<LinkButton href={`${BASE}/maintenance/new`}>Schedule one</LinkButton>} />}
        />
      </Card>
    </>,
  );
});

/* ------------------------------------------------------------ form */

function valuesOf(tz: string, m?: MaintenanceRow): Values {
  if (!m) {
    const start = Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000;
    return { title: '', body: '', startsAt: toLocal(tz, start), durationMin: '60', recurrence: 'none', recurUntil: '', scope: 'all', monitorIds: [], notify: '1' };
  }
  const monitors = ids(m.monitor_ids);
  return {
    title: m.title,
    body: m.body ?? '',
    startsAt: toLocal(tz, m.starts_at),
    durationMin: String(m.duration_min),
    recurrence: m.recurrence,
    recurUntil: m.recur_until ? toLocal(tz, m.recur_until) : '',
    scope: monitors.length === 0 ? 'all' : 'pick',
    monitorIds: monitors,
    notify: m.notify ? '1' : '0',
  };
}

async function form(c: C, o: { v: Values; errors?: Errors; id?: string; status?: 422 }) {
  const ctx = await mctx(c);
  const tz = await workspaceZone(c.env, ctx.db.orgId);
  const monitors = await listMonitors(ctx);
  const errors = o.errors ?? {};
  const picked = list(o.v, 'monitorIds');
  const editing = !!o.id;
  const title = editing ? 'Edit maintenance' : 'Schedule maintenance';
  return renderPage(
    c,
    { title, crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Maintenance', href: `${BASE}/maintenance` }, { label: title }], status: o.status },
    <>
      <Assets />
      <Back href={`${BASE}/maintenance`}>All maintenance</Back>
      <PageHeader title={title} description={`Times are in ${tz}.`} />
      <form method="post" action={editing ? `${BASE}/maintenance/${o.id}/edit` : `${BASE}/maintenance/new`} class="stack" novalidate>
        <Problems errors={errors} shown={['title', 'body', 'startsAt', 'durationMin', 'recurrence', 'recurUntil', 'monitorIds']} />
        <Card title="What and when" ruled>
          <div class="stack">
            <TextField id="title" label="Title" v={o.v} errors={errors} maxlength={150} placeholder="Database upgrade" />
            <AreaField id="body" label="Note for your status page" v={o.v} errors={errors} optional rows={3} />
            <div class="form-row">
              <TextField id="startsAt" label="Starts" v={o.v} errors={errors} type="datetime-local" />
              <TextField id="durationMin" label="Lasts (minutes)" v={o.v} errors={errors} inputmode="numeric" />
            </div>
            <div class="form-row">
              <Field id="recurrence" label="Repeats" error={errors.recurrence}>
                <Select id="recurrence" name="recurrence" value={text(o.v, 'recurrence', 'none')} options={RECURRENCES.map((r) => ({ value: r, label: REPEAT_LABEL[r] ?? r }))} />
              </Field>
              <TextField id="recurUntil" label="Stop repeating after" v={o.v} errors={errors} optional type="datetime-local" hint="Leave empty to repeat until you delete it." />
            </div>
          </div>
        </Card>
        <Card title="What it covers" ruled>
          <div class="stack">
            <fieldset class="mon-channels">
              <legend class="lbl">Monitors</legend>
              <label class="check">
                <input type="radio" name="scope" value="all" checked={text(o.v, 'scope', 'all') === 'all'} />
                <span>
                  <b>Every monitor</b>
                </span>
              </label>
              <label class="check">
                <input type="radio" name="scope" value="pick" checked={text(o.v, 'scope') === 'pick'} />
                <span>
                  <b>Only the ones I choose</b>
                </span>
              </label>
              {monitors.length > 0 ? (
                <div class="mon-pick">
                  {monitors.map((m) => (
                    <label class="check">
                      <input type="checkbox" name="monitorIds" value={m.id} checked={picked.includes(m.id)} />
                      <span>
                        <b>{m.name}</b>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p class="muted">You have no monitors yet.</p>
              )}
            </fieldset>
            <Toggle name="notify" label="Tell subscribers" description="Send an email when it starts and when it ends." checked={on(o.v, 'notify', true)} />
          </div>
        </Card>
        <div class="row">
          <Button type="submit" variant="primary">
            {editing ? 'Save changes' : 'Schedule'}
          </Button>
          <LinkButton href={`${BASE}/maintenance`}>Cancel</LinkButton>
        </div>
      </form>
      {editing ? (
        <form method="post" action={`${BASE}/maintenance/${o.id}/delete`}>
          <ConfirmButton id={`delete-${o.id}`} title="Delete this window?" body="Alerts will no longer pause for it. This can’t be undone." confirmLabel="Delete window" icon="trash">
            Delete window
          </ConfirmButton>
        </form>
      ) : null}
    </>,
  );
}

async function payload(c: C, v: Values): Promise<Record<string, unknown>> {
  const tz = await workspaceZone(c.env, (await mctx(c)).db.orgId);
  const recurUntil = text(v, 'recurUntil').trim();
  return {
    title: text(v, 'title'),
    body: text(v, 'body'),
    startsAt: fromLocal(tz, text(v, 'startsAt')),
    durationMin: text(v, 'durationMin'),
    recurrence: text(v, 'recurrence', 'none'),
    recurUntil: recurUntil ? fromLocal(tz, recurUntil) : null,
    monitorIds: text(v, 'scope', 'all') === 'pick' ? list(v, 'monitorIds') : [],
    notify: on(v, 'notify'),
  };
}

app.get('/maintenance/new', async (c) => form(c, { v: valuesOf(await workspaceZone(c.env, (await mctx(c)).db.orgId)) }));

app.post('/maintenance/new', async (c) => {
  const v = await readForm(c, ['monitorIds']);
  const ctx = await mctx(c);
  try {
    const m = await createMaintenance(ctx, await payload(c, v));
    await record(c, 'monitor.maintenance_created', 'maintenance', m.id, `Scheduled maintenance ${m.title}`);
    return done(c, 'Maintenance scheduled.', `${BASE}/maintenance`);
  } catch (e) {
    return failed(c, e, `${BASE}/maintenance/new`, (errors) => form(c, { v, errors, status: 422 }));
  }
});

app.get('/maintenance/:id', async (c) => {
  const ctx = await mctx(c);
  const m = await getMaintenance(ctx, c.req.param('id'));
  return form(c, { v: valuesOf(await workspaceZone(c.env, ctx.db.orgId), m), id: m.id });
});

app.post('/maintenance/:id/edit', async (c) => {
  const ctx = await mctx(c);
  const m = await getMaintenance(ctx, c.req.param('id'));
  const v = await readForm(c, ['monitorIds']);
  try {
    const next = await updateMaintenance(ctx, m.id, await payload(c, v));
    await record(c, 'monitor.maintenance_updated', 'maintenance', m.id, `Updated maintenance ${next.title}`);
    return done(c, 'Changes saved.', `${BASE}/maintenance`);
  } catch (e) {
    return failed(c, e, `${BASE}/maintenance/${m.id}`, (errors) => form(c, { v, errors, id: m.id, status: 422 }));
  }
});

app.post('/maintenance/:id/delete', async (c) => {
  const ctx = await mctx(c);
  const m = await getMaintenance(ctx, c.req.param('id'));
  await deleteMaintenance(ctx, m.id);
  await record(c, 'monitor.maintenance_deleted', 'maintenance', m.id, `Deleted maintenance ${m.title}`);
  return done(c, 'Maintenance deleted.', `${BASE}/maintenance`);
});

export default app;
