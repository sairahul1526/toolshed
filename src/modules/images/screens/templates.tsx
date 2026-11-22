/** The template list, the first-run starter picker, and the page for making or importing a template. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import type { FieldErrors } from '../../../core/errors';
import { errors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, Field, Input, LinkButton, PageHeader, Pill, Select, Table, Textarea, formatNumber, timeAgo } from '../../../ui';
import { HOME, More, canWrite, fileIn, flashAndGo, numberIn, page, plainError, query, readForm, text, writer, type Ctx } from '../dash-shared';
import { scopeOf, svgResponse } from '../http';
import { MAX_CANVAS, MIN_CANVAS, PRESETS } from '../schema';
import { previewSvg } from '../serve';
import { STARTERS, starterByKey, type Starter } from '../starters';
import { createTemplate, importTemplate, listTemplates, type TemplateSummary } from '../templates';

const MAX_IMPORT_BYTES = 256 * 1024;

export function StatePill({ template }: { template: TemplateSummary }) {
  if (!template.published) return <Pill tone="warn">Draft</Pill>;
  if (template.unpublishedChanges) return <Pill tone="warn">Unpublished changes</Pill>;
  return <Pill tone="good">Live</Pill>;
}

function StarterCard({ starter, write }: { starter: Starter; write: boolean }) {
  return (
    <li class="img-starter">
      <img class="img-thumb" src={`${HOME}/starters/${starter.key}.svg`} alt={`${starter.name} example`} width={starter.doc.width} height={starter.doc.height} loading="lazy" />
      <div class="img-starter-text">
        <b>{starter.name}</b>
        <span class="muted">{starter.description}</span>
        <span class="muted mono">{starter.doc.width} × {starter.doc.height}</span>
      </div>
      {write ? (
        <form method="post" action={`${HOME}/new`}>
          <input type="hidden" name="starter" value={starter.key} />
          <Button type="submit" variant="primary" size="sm" aria-label={`Use the ${starter.name} card`}>Use this card</Button>
        </form>
      ) : null}
    </li>
  );
}

function Starters({ list, write }: { list: Starter[]; write: boolean }) {
  return (
    <ul class="img-starters">
      {list.map((starter) => (
        <StarterCard starter={starter} write={write} />
      ))}
    </ul>
  );
}

const templates = new Hono<AppEnv>();

templates.get('/', async (c) => {
  const s = scopeOf(c);
  const write = canWrite(c);
  const cursor = c.req.query('cursor');
  const list = await listTemplates(s.db, { limit: 24, cursor: cursor ?? null });

  if (list.items.length === 0 && !cursor) {
    return page(c, 'Images', (
      <>
        <PageHeader title="Images" description="Share images and social cards, made from a template and a URL." />
        <Card title="Make your first image" description="Pick a card. You get a finished image straight away, with a URL you can paste into your site.">
          <Starters list={STARTERS.slice(0, 3)} write={write} />
          {write ? (
            <p class="img-row">
              <LinkButton href={`${HOME}/new`} icon="grid">See all {STARTERS.length} cards and sizes</LinkButton>
            </p>
          ) : (
            <p class="muted">Ask a workspace member to make the first template. Viewers can look but not change things.</p>
          )}
        </Card>
      </>
    ));
  }

  const rows = list.items.map((t) => ({
    preview: (
      <a href={`${HOME}/t/${t.id}`} class="img-thumb-link" aria-label={`Open ${t.name}`}>
        <img class="img-thumb small" src={`${HOME}/t/${t.id}/preview.svg`} alt="" width={t.width} height={t.height} loading="lazy" />
      </a>
    ),
    name: (
      <div class="img-cell">
        <a href={`${HOME}/t/${t.id}`} class="img-name">{t.name}</a>
        <span class="mono muted img-small">/i/{t.slug}</span>
      </div>
    ),
    size: `${t.width} × ${t.height}`,
    state: <StatePill template={t} />,
    renders: formatNumber(t.renders),
    changed: timeAgo(new Date(t.updatedAt)),
    // The name and the picture open the use page, so the row needs one button only.
    actions: write ? <LinkButton href={`${HOME}/t/${t.id}/edit`} size="sm" icon="edit">Design</LinkButton> : <LinkButton href={`${HOME}/t/${t.id}`} size="sm">Use</LinkButton>,
  }));

  return page(c, 'Images', (
    <>
      <PageHeader
        title="Images"
        description="Each template is a design with fields. Change the fields in the URL to get a new image."
        actions={write ? <LinkButton href={`${HOME}/new`} icon="plus" variant="primary">New template</LinkButton> : undefined}
      />
      <Table
        caption="Templates"
        columns={[
          { key: 'preview', label: 'Preview', srOnly: true },
          { key: 'name', label: 'Template' },
          { key: 'size', label: 'Size', hideOnMobile: true },
          { key: 'state', label: 'State' },
          { key: 'renders', label: 'Images made', numeric: true },
          { key: 'changed', label: 'Changed', hideOnMobile: true },
          { key: 'actions', label: 'Actions', srOnly: true },
        ]}
        rows={rows}
      />
      <More href={list.nextCursor ? `${HOME}${query({ cursor: list.nextCursor })}` : null} label="Show more templates" />
    </>
  ));
});

interface NewState {
  values?: Record<string, string>;
  fields?: FieldErrors;
  message?: string;
}

function newPage(c: Ctx, state: NewState = {}): Promise<Response> {
  const v = state.values ?? {};
  const f = state.fields ?? {};
  return page(c, 'New template', (
    <>
      <PageHeader title="New template" description="Start from a finished card, or from an empty canvas in the size you need." />
      {state.message ? <Callout tone="bad" title="That didn’t work">{state.message}</Callout> : null}
      <Card title="Start from a card" description="Every card can be changed in the editor: text, colours, pictures and size.">
        <Starters list={STARTERS} write />
      </Card>
      <div class="img-two">
        <Card title="Empty canvas">
          <form method="post" action={`${HOME}/new`} class="form">
            <Field id="new-name" label="Name" error={f.name}>
              <Input id="new-name" name="name" value={v.name ?? ''} maxlength={80} placeholder="Blog card" invalid={Boolean(f.name)} />
            </Field>
            <Field id="new-preset" label="Size" error={f.preset}>
              <Select
                id="new-preset"
                name="preset"
                value={v.preset ?? 'og'}
                options={[...PRESETS.map((p) => ({ value: p.id, label: `${p.name} (${p.hint.replace(/^Open Graph, /, '')})` })), { value: 'custom', label: 'Custom size' }]}
              />
            </Field>
            <div class="grid-2">
              <Field id="new-width" label="Width" error={f.width} optional>
                <Input id="new-width" name="width" inputmode="numeric" value={v.width ?? ''} placeholder="1200" invalid={Boolean(f.width)} />
              </Field>
              <Field id="new-height" label="Height" error={f.height} optional>
                <Input id="new-height" name="height" inputmode="numeric" value={v.height ?? ''} placeholder="630" invalid={Boolean(f.height)} />
              </Field>
            </div>
            <p class="hint">{`Width and height are only for a custom size. ${MIN_CANVAS} to ${MAX_CANVAS} px.`}</p>
            <div class="img-row">
              <Button type="submit" variant="primary">Make template</Button>
            </div>
          </form>
        </Card>
        <Card title="Import a template file" description="A .template.json file exported from this or another workspace. Uploaded pictures and fonts are not inside the file.">
          <form method="post" action={`${HOME}/import`} enctype="multipart/form-data" class="form">
            <Field id="import-file" label="Template file" error={f.file} optional>
              <input class="input" id="import-file" type="file" name="file" accept="application/json,.json" />
            </Field>
            <Field id="import-json" label="Or paste the file’s text" error={f.json} optional>
              <Textarea id="import-json" name="json" rows={4} value={v.json ?? ''} class="mono" />
            </Field>
            <div class="img-row">
              <Button type="submit" icon="upload">Import</Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  ), { status: state.message ? 422 : 200 });
}

templates.get('/new', (c) => {
  writer(c);
  return newPage(c);
});

templates.post('/new', async (c) => {
  writer(c);
  const s = scopeOf(c);
  const form = await readForm(c);
  const starter = text(form, 'starter');
  const preset = text(form, 'preset');
  const values = { name: text(form, 'name'), preset, width: text(form, 'width'), height: text(form, 'height') };
  try {
    const custom = preset === 'custom';
    if (custom && (numberIn(form, 'width') === undefined || numberIn(form, 'height') === undefined)) {
      throw errors.validation_failed('A custom size needs a width and a height.', { width: 'Type a width in pixels.', height: 'Type a height in pixels.' });
    }
    const template = await createTemplate(
      s.env,
      s.db,
      starter
        ? { starter, publish: true }
        : { name: values.name || undefined, preset: custom ? undefined : preset || undefined, width: custom ? numberIn(form, 'width') : undefined, height: custom ? numberIn(form, 'height') : undefined },
      s.actor,
    );
    await auditFromRequest(c, { action: 'images.template.created', targetType: 'image_template', targetId: template.id, summary: `Created the image template "${template.name}"` });
    // A starter is live at once, so the next screen can show a finished image and its URL.
    return starter ? flashAndGo(c, 'ok', 'Your image is ready. Change the text, then copy its URL.', `${HOME}/t/${template.id}`) : c.redirect(`${HOME}/t/${template.id}/edit`, 303);
  } catch (err) {
    const { message, fields } = plainError(err);
    return newPage(c, { values, fields, message });
  }
});

templates.post('/import', async (c) => {
  writer(c);
  const s = scopeOf(c);
  const form = await readForm(c);
  const file = fileIn(form, 'file');
  const pasted = text(form, 'json');
  try {
    if (!file && !pasted) throw errors.validation_failed('Choose a template file or paste its text.', { file: 'Choose a file, or paste the text below.' });
    if (file && file.size > MAX_IMPORT_BYTES) throw errors.too_large('That file is too large to be a template.');
    const template = await importTemplate(s.env, s.db, file ? await file.text() : pasted, s.actor);
    await auditFromRequest(c, { action: 'images.template.created', targetType: 'image_template', targetId: template.id, summary: `Imported the image template "${template.name}"` });
    return flashAndGo(c, 'ok', `Imported "${template.name}". Publish it when it looks right.`, `${HOME}/t/${template.id}/edit`);
  } catch (err) {
    const { message, fields } = plainError(err);
    return newPage(c, { values: { json: file ? '' : pasted.slice(0, 20_000) }, fields, message });
  }
});

templates.get('/starters/:file', async (c) => {
  const starter = starterByKey(c.req.param('file').replace(/\.svg$/, ''));
  if (!starter) throw errors.not_found('There is no starter card with that name.');
  const s = scopeOf(c);
  return svgResponse((await previewSvg(s.env, s.db, starter.doc, {}, 600)).svg);
});

export { templates };
