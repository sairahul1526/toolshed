/** Many images at once: paste or upload rows, watch the batch run, download the results. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import { errors, type FieldErrors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, ConfirmButton, EmptyState, Field, Input, KeyValueList, LinkButton, PageHeader, Pill, Select, Table, Textarea, formatBytes, formatDateTime, plural, timeAgo } from '../../../ui';
import { MAX_BATCH_ROWS, createBatch, deleteBatch, getBatch, listBatches, type Batch, type BatchSummary } from '../batch';
import { API, HOME, More, canWrite, fileIn, flashAndGo, numberIn, page, plainError, query, readForm, refusal, text, writer, type Ctx } from '../dash-shared';
import { scopeOf } from '../http';
import { getSettings } from '../settings';
import { getTemplate, listTemplates } from '../templates';

const MAX_CSV_BYTES = 256 * 1024;

function BatchPill({ batch }: { batch: BatchSummary }) {
  if (batch.status === 'queued') return <Pill tone="neutral">Waiting</Pill>;
  if (batch.status === 'running') return <Pill tone="warn">Running</Pill>;
  if (batch.status === 'failed') return <Pill tone="bad">Stopped</Pill>;
  return batch.failed ? <Pill tone="warn">Done, {batch.failed} failed</Pill> : <Pill tone="good">Done</Pill>;
}

interface NewState {
  values?: Record<string, string>;
  fields?: FieldErrors;
  message?: string;
}

async function batchPage(c: Ctx, state: NewState = {}): Promise<Response> {
  const s = scopeOf(c);
  const write = canWrite(c);
  const cursor = c.req.query('cursor');
  const [list, templates, settings] = await Promise.all([listBatches(s.db, { limit: 20, cursor: cursor ?? null }), listTemplates(s.db, { limit: 100 }), getSettings(s.env, s.db.orgId)]);
  const live = templates.items.filter((t) => t.published);
  const v = state.values ?? {};
  const f = state.fields ?? {};
  const chosen = v.templateId ?? c.req.query('template') ?? live[0]?.id ?? '';
  const sample = live.length ? await getTemplate(s.db, live.find((t) => t.id === chosen)?.id ?? live[0]!.id) : null;
  const names = sample?.publishedDoc?.fields.map((field) => field.name) ?? [];

  const rows = list.items.map((batch) => ({
    name: (
      <div class="img-cell">
        <a class="img-name" href={`${HOME}/batch/${batch.id}`}>{batch.name}</a>
        <span class="muted img-small">{batch.format.toUpperCase()}{batch.width ? `, ${batch.width} px wide` : ''}</span>
      </div>
    ),
    state: <BatchPill batch={batch} />,
    done: `${batch.done} of ${batch.total}`,
    started: timeAgo(new Date(batch.createdAt)),
  }));

  return page(c, 'Batch', (
    <>
      <PageHeader title="Batch" description={`Make up to ${MAX_BATCH_ROWS} images in one go from rows of a spreadsheet.`} />
      {state.message ? <Callout tone="bad" title="The batch did not start">{state.message}</Callout> : null}
      {!write ? null : live.length === 0 ? (
        <EmptyState icon="layers" title="Publish a template first" body="A batch fills in a published template once per row." actions={<LinkButton href={HOME} variant="primary">Go to templates</LinkButton>} />
      ) : (
        <Card title="New batch" description="The first row names the template’s fields. Each row after it becomes one image.">
          <form method="post" action={`${HOME}/batch`} enctype="multipart/form-data" class="form">
            <div class="grid-2">
              <Field id="batch-template" label="Template" error={f.templateId}>
                <Select id="batch-template" name="templateId" value={chosen} options={live.map((t) => ({ value: t.id, label: t.name }))} />
              </Field>
              <Field id="batch-format" label="File type" error={f.format} hint={settings.serverPng ? undefined : 'PNG needs server drawing, which is off in Settings.'}>
                <Select id="batch-format" name="format" value={v.format ?? 'svg'} options={[{ value: 'svg', label: 'SVG' }, { value: 'png', label: 'PNG', disabled: !settings.serverPng }]} />
              </Field>
            </div>
            <Field id="batch-csv" label="Rows as CSV" error={f.csv} hint={names.length ? `Fields of the chosen template: ${names.join(', ')}. A column that matches no field is ignored.` : undefined}>
              <Textarea id="batch-csv" name="csv" rows={6} value={v.csv ?? ''} class="mono" placeholder={`${names.slice(0, 3).join(',') || 'title'}\n${names.slice(0, 3).map((n) => `First ${n}`).join(',') || 'First title'}`} invalid={Boolean(f.csv)} />
            </Field>
            <Field id="batch-file" label="Or upload a .csv file" optional>
              <input class="input" id="batch-file" type="file" name="file" accept=".csv,text/csv" />
            </Field>
            <div class="grid-2">
              <Field id="batch-name" label="Name" error={f.name} optional>
                <Input id="batch-name" name="name" value={v.name ?? ''} maxlength={80} />
              </Field>
              <Field id="batch-width" label="Width in pixels" error={f.width} hint="Leave empty for the template’s own size." optional>
                <Input id="batch-width" name="width" inputmode="numeric" value={v.width ?? ''} invalid={Boolean(f.width)} />
              </Field>
            </div>
            <div class="img-row">
              <Button type="submit" variant="primary" icon="layers">Start batch</Button>
            </div>
          </form>
        </Card>
      )}
      {rows.length === 0 && !cursor ? (
        write && live.length === 0 ? null : <EmptyState icon="list" title="No batches yet" body={write ? 'Batches you start show here with their progress and a download.' : 'Batches started by workspace members show here.'} />
      ) : (
        <Table
          caption="Batches"
          columns={[
            { key: 'name', label: 'Batch' },
            { key: 'state', label: 'State' },
            { key: 'done', label: 'Images', numeric: true },
            { key: 'started', label: 'Started', hideOnMobile: true },
          ]}
          rows={rows}
        />
      )}
      <More href={list.nextCursor ? `${HOME}/batch${query({ cursor: list.nextCursor })}` : null} label="Show older batches" />
    </>
  ), { status: state.message ? 422 : 200 });
}

function batchDetail(c: Ctx, batch: Batch): Promise<Response> {
  const write = canWrite(c);
  const running = batch.status === 'queued' || batch.status === 'running';
  const rows = batch.results.map((result) => ({
    row: String(result.row),
    result: result.url ? (
      <div class="input-group">
        <input class="input mono" readonly value={result.url} aria-label={`Image URL for row ${result.row}`} />
        <Button size="sm" icon="copy" data-copy={result.url} data-copied="Image URL copied.">Copy</Button>
      </div>
    ) : (
      <span class="field-error">{result.message ?? 'This row could not be drawn.'}</span>
    ),
    bytes: result.bytes ? formatBytes(result.bytes) : '',
  }));
  return page(c, batch.name, (
    <>
      <PageHeader
        title={batch.name}
        soft={<BatchPill batch={batch} />}
        actions={
          running ? (
            <LinkButton href={`${HOME}/batch/${batch.id}`} icon="refresh">Check again</LinkButton>
          ) : (
            <>
              <LinkButton href={`${API}/batches/${batch.id}/results.csv`} icon="download">Results as CSV</LinkButton>
              {batch.done > 0 ? <LinkButton href={`${API}/batches/${batch.id}/download.zip`} icon="download" variant="primary">Download ZIP</LinkButton> : null}
            </>
          )
        }
      />
      {running ? <meta http-equiv="refresh" content="5" /> : null}
      {running ? (
        <Callout tone="info" title="This batch is running">
          {batch.done + batch.failed} of {batch.total} rows are finished. It runs in the background and this page checks again every few seconds.
        </Callout>
      ) : null}
      <KeyValueList
        items={[
          { label: 'Images made', value: `${batch.done} of ${batch.total}` },
          { label: 'Rows that failed', value: String(batch.failed) },
          { label: 'File type', value: batch.format.toUpperCase() },
          { label: 'Started', value: formatDateTime(new Date(batch.createdAt)) },
          { label: 'Finished', value: batch.finishedAt ? formatDateTime(new Date(batch.finishedAt)) : 'Not yet' },
        ]}
      />
      {rows.length ? (
        <Table
          caption={`${plural(rows.length, 'row')} finished`}
          columns={[
            { key: 'row', label: 'Row', numeric: true },
            { key: 'result', label: 'Image URL' },
            { key: 'bytes', label: 'Size', numeric: true, hideOnMobile: true },
          ]}
          rows={rows}
        />
      ) : (
        <EmptyState icon="clock" title="No rows finished yet" body="Rows show here one by one as they are drawn." bare />
      )}
      {write && !running ? (
        <form method="post" action={`${HOME}/batch/${batch.id}/delete`} class="img-row">
          <ConfirmButton id="delete-batch" icon="trash" title="Remove this batch?" body="The batch leaves this list. Its images stay and their URLs keep working." confirmLabel="Remove batch">Remove from list</ConfirmButton>
        </form>
      ) : null}
    </>
  ), { crumbs: [{ label: 'Images', href: HOME }, { label: 'Batch', href: `${HOME}/batch` }, { label: batch.name }] });
}

const batch = new Hono<AppEnv>();

batch.get('/batch', (c) => batchPage(c));

batch.post('/batch', async (c) => {
  writer(c);
  const s = scopeOf(c);
  const form = await readForm(c);
  const file = fileIn(form, 'file');
  const values = { templateId: text(form, 'templateId'), format: text(form, 'format') || 'svg', name: text(form, 'name'), width: text(form, 'width'), csv: file ? '' : text(form, 'csv') };
  try {
    if (file && file.size > MAX_CSV_BYTES) throw errors.too_large(`That file is too large. A batch can hold ${MAX_BATCH_ROWS} rows at most.`);
    const csv = file ? await file.text() : values.csv;
    const made = await createBatch(
      s.env,
      s.db,
      // A width that is not a number goes through as it is, so the form can say what is wrong with it.
      { templateId: values.templateId, format: values.format, name: values.name || undefined, width: values.width === '' ? undefined : (numberIn(form, 'width') ?? Number.NaN), csv },
      s.base,
      s.actor,
    );
    await auditFromRequest(c, { action: 'images.batch.started', targetType: 'image_batch', targetId: made.id, summary: `Started a batch of ${made.total} ${made.total === 1 ? 'image' : 'images'}` });
    return flashAndGo(c, 'ok', `Started. ${plural(made.total, 'image')} will be made in the background.`, `${HOME}/batch/${made.id}`);
  } catch (err) {
    const { message, fields } = plainError(err);
    return batchPage(c, { values, fields, message });
  }
});

batch.get('/batch/:id', async (c) => batchDetail(c, await getBatch(scopeOf(c).db, c.req.param('id'))));

batch.post('/batch/:id/delete', async (c) => {
  writer(c);
  const id = c.req.param('id');
  try {
    await deleteBatch(scopeOf(c).db, id);
    return flashAndGo(c, 'ok', 'Removed from the list. Its images keep working.', `${HOME}/batch`);
  } catch (err) {
    return flashAndGo(c, 'error', refusal(err), `${HOME}/batch/${id}`);
  }
});

export { batch };
