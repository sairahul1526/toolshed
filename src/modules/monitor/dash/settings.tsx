/** Monitor settings: the "alive" ping, how long history is kept, CSV import and export. */
import { Hono } from 'hono';
import { parse, readJson } from '../../../core/errors';
import { needRole } from '../../../core/guards';
import { getModuleSettings, setModuleSettings } from '../../../core/registry';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, Field, KeyValueList, LinkButton, PageHeader, Select, formatNumber, renderPage } from '../../../ui';
import { MAX_MONITORS } from '../monitors';
import { IMPORT_MAX, importCsv, type ImportReport } from '../ops';
import { assertPublicUrl } from '../outbound';
import { DEFAULT_SETTINGS, type MonitorSettings, moduleSettingsSchema } from '../schema';
import { Assets, BASE, Back, Problems, TextField, failed, done, mctx, readForm, record, text, type C, type Errors, type Values } from './common';

const app = new Hono<AppEnv>();

const MAX_CSV = 500_000;

async function screen(c: C, o: { v?: Values; errors?: Errors; report?: ImportReport; importError?: string; status?: 422 } = {}) {
  const ctx = await mctx(c);
  const s = await getModuleSettings<MonitorSettings>(c.env, ctx.db.orgId, 'monitor', DEFAULT_SETTINGS);
  const v: Values = o.v ?? { aliveUrl: s.aliveUrl, aliveEveryMin: String(s.aliveEveryMin), keepHourlyDays: String(s.keepHourlyDays), keepDailyDays: String(s.keepDailyDays) };
  const errors = o.errors ?? {};
  const r = o.report;
  return renderPage(
    c,
    { title: 'Monitor settings', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Settings' }], status: o.status },
    <>
      <Assets />
      <Back href={BASE}>All monitors</Back>
      <PageHeader title="Settings" description="How this install watches itself, how long history stays, and moving data in and out." />
      <form method="post" action={`${BASE}/settings`} class="stack" novalidate>
        <Problems errors={errors} shown={['aliveUrl', 'aliveEveryMin', 'keepHourlyDays', 'keepDailyDays']} />
        <Card title="Alive ping" description="Every few minutes we open an address you choose. Point it at a heartbeat from another service, and you hear about it if this install ever stops running." ruled>
          <div class="form-row">
            <TextField id="aliveUrl" label="Address to ping" v={v} errors={errors} optional inputmode="url" placeholder="https://hc-ping.com/your-uuid" />
            <Field id="aliveEveryMin" label="Ping every" error={errors.aliveEveryMin}>
              <Select id="aliveEveryMin" name="aliveEveryMin" value={text(v, 'aliveEveryMin', '1')} options={[{ value: '1', label: 'Minute' }, { value: '5', label: '5 minutes' }, { value: '10', label: '10 minutes' }]} />
            </Field>
          </div>
        </Card>
        <Card title="History" description="Older rows are removed automatically. Daily numbers feed the 90-day bars, so keep at least 90 days." ruled>
          <div class="form-row">
            <TextField id="keepHourlyDays" label="Keep hourly numbers (days)" v={v} errors={errors} inputmode="numeric" hint="Between 2 and 30." />
            <TextField id="keepDailyDays" label="Keep daily numbers (days)" v={v} errors={errors} inputmode="numeric" hint="Between 30 and 730." />
          </div>
        </Card>
        <div>
          <Button type="submit" variant="primary">
            Save settings
          </Button>
        </div>
      </form>
      <Card id="import" title="Import from UptimeRobot" description={`Upload the CSV you exported. We read names and addresses, and the keyword and interval when they are there. Up to ${IMPORT_MAX} monitors at a time, and ${MAX_MONITORS} in all.`}>
        <form method="post" action={`${BASE}/settings/import`} enctype="multipart/form-data" class="stack" novalidate>
          {o.importError ? <Callout tone="bad" title="That didn’t import">{o.importError}</Callout> : null}
          <Field id="file" label="CSV file" hint="Under 500 KB.">
            <input class="input" id="file" name="file" type="file" accept=".csv,text/csv" required />
          </Field>
          <div>
            <Button type="submit">Import monitors</Button>
          </div>
        </form>
        {r ? (
          <div class="stack mon-report" role="status">
            <Callout tone={r.created > 0 ? 'good' : 'warn'} title={`${formatNumber(r.created)} imported`}>
              {r.skipped.length > 0 ? `${formatNumber(r.skipped.length)} skipped.` : 'None skipped.'} {r.remaining > 0 ? `${formatNumber(r.remaining)} more are waiting. Upload the file again to bring in the next ${IMPORT_MAX}.` : ''}
            </Callout>
            {r.skipped.length > 0 ? (
              <ul class="rows">
                {r.skipped.slice(0, 20).map((x) => (
                  <li>
                    <span class="row-text">
                      <b class="trunc">{x.name || `Row ${x.row}`}</b>
                      <span>{x.reason}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>
      <Card title="Export" description="Your monitors as a CSV. Alert secrets are never included.">
        <KeyValueList items={[{ label: 'Monitors', value: <a href={`/api/v1/monitor/export/monitors.csv`}>Download monitors.csv</a> }]} />
        <p class="muted">The workspace Export under Settings has everything else: incidents, status pages, channels and history.</p>
      </Card>
    </>,
  );
}

app.get('/settings', (c) => screen(c));

app.post('/settings', async (c) => {
  needRole(c, 'admin');
  const v = await readForm(c);
  const orgId = c.get('org')!.id;
  try {
    const input = parse(moduleSettingsSchema, {
      aliveUrl: text(v, 'aliveUrl'),
      aliveEveryMin: text(v, 'aliveEveryMin'),
      keepHourlyDays: text(v, 'keepHourlyDays'),
      keepDailyDays: text(v, 'keepDailyDays'),
    });
    const cur = await getModuleSettings<MonitorSettings>(c.env, orgId, 'monitor', DEFAULT_SETTINGS);
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) } as MonitorSettings;
    if (next.aliveUrl) {
      try {
        assertPublicUrl(String(next.aliveUrl), 'aliveUrl');
      } catch {
        return screen(c, { v, errors: { aliveUrl: 'That isn’t a public web address.' }, status: 422 });
      }
    }
    await setModuleSettings(c.env, orgId, 'monitor', next);
    await record(c, 'monitor.settings_updated', 'settings', 'monitor', 'Changed Monitor settings');
    return done(c, 'Settings saved.', `${BASE}/settings`);
  } catch (e) {
    return failed(c, e, `${BASE}/settings`, (errors) => screen(c, { v, errors, status: 422 }));
  }
});

app.post('/settings/import', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) return screen(c, { importError: 'Choose a CSV file first.', status: 422 });
  if (file.size > MAX_CSV) return screen(c, { importError: 'Keep the file under 500 KB.', status: 422 });
  const ctx = await mctx(c);
  try {
    const report = await importCsv(ctx, await file.text());
    await record(c, 'monitor.imported', 'monitor', 'import', `Imported ${report.created} monitors`);
    return screen(c, { report });
  } catch (e) {
    return failed(c, e, `${BASE}/settings`, async (errors) => screen(c, { importError: Object.values(errors).join(' '), status: 422 }));
  }
});

export default app;
