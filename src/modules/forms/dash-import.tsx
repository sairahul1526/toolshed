/** Import and export of one form's responses, and the respondent privacy tools. */
import { Hono } from 'hono';
import { orgDb } from '../../core/db';
import { AppError } from '../../core/errors';
import type { AppEnv } from '../../env';
import { Button, Callout, Card, EmptyState, Field, Input, PageHeader, Select, Table, Textarea, formatNumber, renderPage, setFlash } from '../../ui';
import { BASE, CSS, STYLES, FormTabs, body, crumbs, str, type C } from './dash-common';
import { actorOf, ctxOf } from './http';
import { RECEIVED, importResponses, previewImport } from './importcsv';
import { allFields, DISPLAY_TYPES } from './schema';
import { getDraft, getForm, getPublished } from './service';
import { deleteByEmail, exportByEmail } from './submissions';

export const importRoutes = new Hono<AppEnv>();

async function textOf(v: unknown): Promise<string> {
  if (v instanceof File) return v.size > 2_000_000 ? '' : await v.text();
  return typeof v === 'string' ? v : '';
}

importRoutes.get('/privacy', async (c: C) => {
  const email = str(c.req.query('email')).toLowerCase();
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const found = email ? await exportByEmail(db, email) : [];
  return renderPage(
    c,
    { title: 'Respondent privacy', crumbs: [{ label: 'Forms', href: BASE }, { label: 'Privacy' }], styles: STYLES },
    <>
      {CSS}
      <PageHeader title="Respondent privacy" description="Find everything one person sent through any form in this workspace, download it, or delete it." />
      <Card>
        <form method="get" action={`${BASE}/privacy`} class="fm-actions">
          <label class="sr-only" for="pv-email">Respondent email</label>
          <Input id="pv-email" name="email" type="email" value={email} placeholder="name@example.com" required />
          <Button type="submit" variant="primary">Look up</Button>
        </form>
      </Card>
      {email ? (
        found.length === 0 ? (
          <EmptyState icon="search" title="Nothing found" body={`No responses were sent with ${email}.`} />
        ) : (
          <Card title={`${formatNumber(found.length)} ${found.length === 1 ? 'response' : 'responses'} from ${email}`}>
            <Table
              caption="Responses from this person"
              columns={[{ key: 'form', label: 'Form' }, { key: 'when', label: 'Received' }, { key: 'status', label: 'Status' }]}
              rows={found.map((r) => ({ form: String(r.form), when: String(r.receivedAt).slice(0, 16).replace('T', ' '), status: String(r.status) }))}
            />
            <form method="post" action={`${BASE}/privacy/delete`} class="fm-actions">
              <input type="hidden" name="email" value={email} />
              <a class="btn" href={`${BASE}/privacy/export?email=${encodeURIComponent(email)}`}>Download as JSON</a>
              <Button type="submit" variant="danger" name="confirm" value="1">Delete all of it</Button>
            </form>
            <p class="fm-muted">Deleting removes the responses, their notes and their uploaded files for good.</p>
          </Card>
        )
      ) : null}
    </>,
  );
});

importRoutes.get('/privacy/export', async (c: C) => {
  const email = str(c.req.query('email')).toLowerCase();
  const rows = await exportByEmail(orgDb(c.env.DB, c.get('org')!.id), email);
  return new Response(JSON.stringify({ email, responses: rows }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="respondent-export.json"', 'cache-control': 'private, no-store' } });
});

importRoutes.post('/privacy/delete', async (c: C) => {
  const email = str((await body(c)).email).toLowerCase();
  const n = email ? await deleteByEmail(ctxOf(c), email) : 0;
  setFlash(c, { kind: 'ok', message: `Deleted ${n} ${n === 1 ? 'response' : 'responses'}.` });
  return c.redirect(`${BASE}/privacy`, 303);
});

async function page(c: C, opts: { csv?: string; error?: string; status?: 200 | 422 } = {}) {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, c.req.param('id') ?? '');
  const def = (await getPublished(db, form)) ?? (await getDraft(db, form));
  const preview = opts.csv ? previewImport(def, opts.csv) : null;
  const qs = allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type) && f.type !== 'file_upload');
  return renderPage(
    c,
    { title: `Import and export for ${form.name}`, crumbs: crumbs(form, 'Import and export'), status: opts.status, styles: STYLES },
    <>
      {CSS}
      <PageHeader title={form.name} description="Move responses in and out as spreadsheets." />
      <FormTabs form={form} active="import" />
      <Card title="Export" description="Everything you can see, as a CSV file that opens in any spreadsheet.">
        <div class="fm-actions">
          <a class="btn" href={`/api/v1/forms/${form.id}/submissions/export.csv`}>Download responses as CSV</a>
          <a class="btn" href={`/api/v1/forms/${form.id}/export`}>Download the form as JSON</a>
        </div>
      </Card>
      {preview ? (
        <Card title="Match the columns" description={`${formatNumber(preview.rows)} rows found${preview.truncated ? ', and only the first 500 will be imported' : ''}. Pick which question each column fills.`}>
          <form method="post" action={`${BASE}/${form.id}/import/run`} class="fm-stack">
            <input type="hidden" name="csv" value={opts.csv} />
            {preview.headers.map((h, i) => (
              <Field id={`m-${i}`} label={h || `Column ${i + 1}`} hint={preview.sample[0]?.[i] ? `For example: ${preview.sample[0][i]}` : undefined}>
                <Select id={`m-${i}`} name={`map_${i}`} value={preview.mapping[h] ?? ''} options={[{ value: '', label: 'Skip this column' }, { value: RECEIVED, label: 'When it was received' }, ...qs.map((f) => ({ value: f.id, label: f.label || f.key }))]} />
              </Field>
            ))}
            <div class="fm-actions">
              <Button type="submit" variant="primary">Import {formatNumber(Math.min(preview.rows, 500))} responses</Button>
              <a class="btn" href={`${BASE}/${form.id}/import`}>Start over</a>
            </div>
          </form>
        </Card>
      ) : (
        <Card title="Import responses" description="Upload a CSV of past responses, for example from another tool. The first row must hold the column names. Imported responses do not send emails or webhooks.">
          {opts.error ? <Callout tone="bad" title="That file did not work">{opts.error}</Callout> : null}
          <form method="post" action={`${BASE}/${form.id}/import`} enctype="multipart/form-data" class="fm-stack">
            <Field id="imp-file" label="CSV file" optional hint="Up to 2 MB and 500 rows."><input id="imp-file" class="input" type="file" name="file" accept=".csv,text/csv" /></Field>
            <Field id="imp-text" label="Or paste the CSV" optional><Textarea id="imp-text" name="csv" rows={5} /></Field>
            <div><Button type="submit" variant="primary">Continue</Button></div>
          </form>
          <p class="fm-muted">Importing straight from Typeform or Tally is not available yet. Export from them as CSV and import it here.</p>
        </Card>
      )}
    </>,
  );
}

importRoutes.get('/:id/import', (c: C) => page(c));

importRoutes.post('/:id/import', async (c: C) => {
  const b = await body(c);
  const csv = (await textOf(b.file)) || (await textOf(b.csv));
  if (!csv.trim()) return page(c, { error: 'Choose a CSV file or paste its contents.', status: 422 });
  return page(c, { csv });
});

importRoutes.post('/:id/import/run', async (c: C) => {
  const id = c.req.param('id') ?? '';
  const b = await body(c);
  const csv = await textOf(b.csv);
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, id);
  const def = (await getPublished(db, form)) ?? (await getDraft(db, form));
  const headers = previewImport(def, csv).headers;
  const mapping: Record<string, string> = {};
  headers.forEach((h, i) => { mapping[h] = str(b[`map_${i}`]); });
  try {
    const res = await importResponses(ctxOf(c), id, csv, mapping);
    setFlash(c, { kind: res.imported ? 'ok' : 'error', message: `Imported ${res.imported} ${res.imported === 1 ? 'response' : 'responses'}${res.skipped ? `, skipped ${res.skipped}` : ''}.` });
    return c.redirect(`${BASE}/${id}/responses`, 303);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return page(c, { error: e.message, status: 422 });
  }
});
