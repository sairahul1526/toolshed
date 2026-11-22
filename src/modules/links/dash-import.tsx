/** Import links from a CSV file in two steps (upload, then match the columns), and export links and clicks. */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { Button, Callout, Card, EmptyState, Field, LinkButton, PageHeader, Select, Table, formatNumber } from '../../ui';
import { csvResponse, flashAndGo, HOME, page, plainError, readForm, text, writer } from './dash-shared';
import { ctxOf } from './ctx';
import { exportClicksCsv, exportDailyCsv, exportLinksCsv, IMPORT_ALIASES, IMPORT_MAX_ROWS, previewImport, runImport, skippedCsv, type ImportField, type ImportMapping, type SkippedRow } from './importexport';

export const importScreen = new Hono<AppEnv>();
const IMPORT = `${HOME}/import`;
const MAX_BYTES = 2_000_000;

const FIELD_LABELS: Record<ImportField, string> = {
  url: 'Destination address',
  code: 'Short code',
  short: 'Short link (the code is taken from it)',
  title: 'Title',
  tags: 'Tags',
  notes: 'Notes',
  expires: 'Expiry date',
};

function UploadForm() {
  return (
    <Card title="Import links" description={`Upload a CSV file from Bitly, Dub, Short.io or a spreadsheet. Up to ${formatNumber(IMPORT_MAX_ROWS)} links at a time. You check the columns before anything is created.`}>
      <form method="post" action={IMPORT} enctype="multipart/form-data" class="stack">
        <Field id="imp-file" label="CSV file" hint="The first row has the column names."><input id="imp-file" class="input" type="file" name="file" accept=".csv,text/csv" required /></Field>
        <div><Button type="submit" variant="primary" icon="upload">Read the file</Button></div>
      </form>
    </Card>
  );
}

importScreen.get('/import', (c) =>
  page(c, 'Import and export', (
    <>
      <PageHeader title="Import and export" description="Move links in from other tools, or take a copy out." />
      <UploadForm />
      <Card title="Export" description="Plain CSV files that open in any spreadsheet.">
        <div class="lk-actions">
          <LinkButton href={`${HOME}/export/links.csv`} icon="download">Links</LinkButton>
          <LinkButton href={`${HOME}/export/daily.csv`} icon="download">Clicks by day</LinkButton>
          <LinkButton href={`${HOME}/export/clicks.csv`} icon="download">Recent clicks (last 7 days)</LinkButton>
        </div>
      </Card>
    </>
  )),
);

importScreen.get('/export/links.csv', async (c) => csvResponse('links.csv', await exportLinksCsv(ctxOf(c))));
importScreen.get('/export/daily.csv', async (c) => csvResponse('clicks-by-day.csv', await exportDailyCsv(ctxOf(c), { days: 90 })));
importScreen.get('/export/clicks.csv', async (c) => csvResponse('recent-clicks.csv', await exportClicksCsv(ctxOf(c))));

async function fileText(c: Context<AppEnv>): Promise<string | null> {
  const f = await readForm(c);
  const file = f.file;
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_BYTES) return '';
  return file.text();
}

importScreen.post('/import', async (c) => {
  writer(c);
  const csv = await fileText(c);
  if (csv === null) return flashAndGo(c, 'error', 'Choose a CSV file first.', IMPORT);
  if (csv === '') return flashAndGo(c, 'error', 'That file is too big. Keep it under 2 MB.', IMPORT);
  try {
    const preview = previewImport(csv);
    const options = [{ value: '', label: 'Not in my file' }, ...preview.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))];
    return page(c, 'Check the columns', (
      <>
        <PageHeader title="Check the columns" description={`${formatNumber(preview.rowCount)} rows found. We matched the columns we could; fix any that look wrong.`} />
        {preview.truncated ? <Callout tone="warn" title="Only the first rows will be imported">This file has more than {formatNumber(IMPORT_MAX_ROWS)} rows. Import the rest in another file.</Callout> : null}
        <form method="post" action={`${IMPORT}/run`}>
          <textarea name="csv" hidden>{csv}</textarea>
          <Card title="Which column is which?">
            <div class="grid-2">
              {(Object.keys(IMPORT_ALIASES) as ImportField[]).map((field) => (
                <Field id={`map-${field}`} label={FIELD_LABELS[field]} optional={field !== 'url'}>
                  <Select id={`map-${field}`} name={`map_${field}`} options={options} value={preview.mapping[field] === null ? '' : String(preview.mapping[field])} />
                </Field>
              ))}
            </div>
          </Card>
          <Card title="First rows" flush>
            <Table
              caption="The first rows of your file"
              columns={preview.headers.map((h, i) => ({ key: String(i), label: h || `Column ${i + 1}` }))}
              rows={preview.sample.map((r) => Object.fromEntries(r.map((cell, i) => [String(i), cell.length > 60 ? `${cell.slice(0, 60)}…` : cell])))}
            />
          </Card>
          <div class="lk-actions"><Button type="submit" variant="primary">Import {formatNumber(Math.min(preview.rowCount, IMPORT_MAX_ROWS))} links</Button><LinkButton href={IMPORT}>Start over</LinkButton></div>
        </form>
      </>
    ));
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, IMPORT);
  }
});

importScreen.post('/import/run', async (c) => {
  writer(c);
  const f = await readForm(c);
  const csv = text(f, 'csv');
  if (!csv) return flashAndGo(c, 'error', 'The file was lost. Upload it again.', IMPORT);
  const mapping: Partial<ImportMapping> = {};
  for (const field of Object.keys(IMPORT_ALIASES) as ImportField[]) {
    const v = text(f, `map_${field}`);
    mapping[field] = v === '' ? null : Number(v);
  }
  try {
    const result = await runImport(ctxOf(c), csv, mapping);
    await auditFromRequest(c, { action: 'links.import.finished', targetType: 'link', summary: `Imported ${result.created} links, skipped ${result.skipped.length}`, meta: { created: result.created, skipped: result.skipped.length } });
    return page(c, 'Import finished', (
      <>
        <PageHeader title="Import finished" description={`${formatNumber(result.created)} links created, ${formatNumber(result.skipped.length)} skipped.`} actions={<LinkButton href={HOME} variant="primary">See your links</LinkButton>} />
        {result.truncated ? <Callout tone="warn" title="Some rows were left out">Only the first {formatNumber(IMPORT_MAX_ROWS)} rows are imported at a time.</Callout> : null}
        {result.skipped.length ? (
          <Card title="Skipped rows" description="These rows were not imported. Fix them in your file and import them again." flush actions={
            <form method="post" action={`${IMPORT}/skipped`}>
              <textarea name="rows" hidden>{JSON.stringify(result.skipped)}</textarea>
              <Button type="submit" size="sm" icon="download">Download as CSV</Button>
            </form>
          }>
            <Table caption="Rows that were not imported" columns={[{ key: 'row', label: 'Row', numeric: true }, { key: 'url', label: 'Address' }, { key: 'reason', label: 'Why' }]} rows={result.skipped.slice(0, 200).map((s) => ({ row: s.row, url: s.url, reason: s.reason }))} />
          </Card>
        ) : <EmptyState icon="check" title="Every row was imported" body="Nothing was skipped." />}
      </>
    ));
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, IMPORT);
  }
});

importScreen.post('/import/skipped', async (c) => {
  const f = await readForm(c);
  let rows: SkippedRow[] = [];
  try {
    const parsed: unknown = JSON.parse(text(f, 'rows'));
    if (Array.isArray(parsed)) rows = parsed.slice(0, 2000).map((r) => ({ row: Number(r?.row) || 0, reason: String(r?.reason ?? ''), url: String(r?.url ?? '') }));
  } catch {
    rows = [];
  }
  return csvResponse('skipped-rows.csv', skippedCsv(rows));
});
