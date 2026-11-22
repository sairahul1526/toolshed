/** One template: the page for using it (preview, image URL, meta tags, PNG), its settings, and its actions. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import type { FieldErrors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, Checkbox, CodeBlock, ConfirmButton, DangerZone, Field, Input, LinkButton, PageHeader, Select, formatDateTime, formatNumber } from '../../../ui';
import { API, HOME, TemplateTabs, canWrite, checked, fieldValues, flashAndGo, numberIn, page, plainError, query, readForm, refusal, text, writer, type Ctx } from '../dash-shared';
import { intParam, scopeOf, svgResponse } from '../http';
import { customFamilies } from '../render';
import type { TemplateDoc, TemplateField } from '../schema';
import { previewSvg } from '../serve';
import { getSettings } from '../settings';
import { linkFor, type ShareLink } from '../share';
import { clearRenders, deleteTemplate, duplicateTemplate, exportTemplate, getTemplate, publishTemplate, revertTemplate, updateTemplate, type Template } from '../templates';
import { StatePill } from './templates';

const EXPIRY = [
  { value: '', label: 'Never' },
  { value: '3600', label: 'In 1 hour' },
  { value: '86400', label: 'In 1 day' },
  { value: '2592000', label: 'In 30 days' },
];

function usesCustomFont(doc: TemplateDoc): boolean {
  return doc.layers.some((layer) => layer.type === 'text' && layer.font?.startsWith('c:'));
}

/** One input per field of the template, named `f.<field>` so it can never clash with a page option. */
export function FieldInputs({ fields, values, prefix = 'f.' }: { fields: TemplateField[]; values: Record<string, string>; prefix?: string }) {
  return (
    <>
      {fields.map((field) => {
        const id = `field-${field.name}`;
        const value = values[field.name] ?? field.default;
        const label = field.label || field.name;
        // A colour picker only speaks six-digit hex. A short or see-through colour gets a text box, so it is never changed by accident.
        if (field.type === 'color' && /^#[0-9a-fA-F]{6}$/.test(value)) {
          return (
            <Field id={id} label={label}>
              <input class="input img-color" id={id} type="color" name={`${prefix}${field.name}`} value={value} data-field={field.name} />
            </Field>
          );
        }
        return (
          <Field id={id} label={label} hint={field.type === 'image' ? 'A picture from Assets (asset:…) or an https:// address on an allowed site.' : field.type === 'color' ? 'A hex colour such as #1d4ed8.' : undefined}>
            <Input id={id} name={`${prefix}${field.name}`} value={value} maxlength={field.type === 'text' ? (field.maxLength ?? 2000) : 600} data-field={field.name} autocomplete="off" />
          </Field>
        );
      })}
    </>
  );
}

function htmlSnippet(link: ShareLink): string {
  return `<img src="${link.url.replace(/&/g, '&amp;')}" width="${link.width}" height="${link.height}" alt="">`;
}

const detail = new Hono<AppEnv>();

detail.get('/t/:id', async (c) => {
  const s = scopeOf(c);
  const write = canWrite(c);
  const [template, settings] = await Promise.all([getTemplate(s.db, c.req.param('id')), getSettings(s.env, s.db.orgId)]);
  const q = c.req.query();
  const values = fieldValues(q);
  const base = `${HOME}/t/${template.id}`;
  const head = <PageHeader title={template.name} soft={<StatePill template={template} />} description={`${template.width} × ${template.height} · /i/${template.slug}`} />;

  const doc = template.publishedDoc;
  if (!doc) {
    return page(c, template.name, (
      <>
        {head}
        <TemplateTabs template={template} active="share" />
        <Callout tone="info" title="This template is not live yet" actions={write ? <LinkButton href={`${base}/edit`} variant="primary" icon="edit">Open the design</LinkButton> : undefined}>
          Image URLs start working when the design is published. Open the design, check it, then press Publish.
        </Callout>
        <img class="img-preview" src={`${base}/preview.svg`} alt={`Draft of ${template.name}`} width={template.width} height={template.height} />
      </>
    ));
  }

  const format = q.format === 'png' ? 'png' : 'svg';
  const unsigned = template.open && q.unsigned === '1';
  let link: ShareLink | null = null;
  let problem = '';
  if (write) {
    try {
      link = await linkFor(s.env, template, s.base, {
        values,
        format,
        width: intParam(q.width) || undefined,
        expiresIn: EXPIRY.some((e) => e.value === q.expires && e.value) ? Number(q.expires) : undefined,
        pin: q.pin === '1',
        unsigned,
      });
    } catch (err) {
      problem = plainError(err).message;
    }
  }
  const custom = usesCustomFont(doc) ? await customFamilies(s.db) : [];
  const previewSrc = `${base}/preview.svg${query({ live: '1', ...Object.fromEntries(Object.entries(values).map(([k, v]) => [`f.${k}`, v])) })}`;
  const moreOpen = Boolean(q.width || q.expires || q.pin || q.unsigned || format === 'png');

  return page(c, template.name, (
    <>
      {head}
      <TemplateTabs template={template} active="share" />
      {template.unpublishedChanges ? (
        <Callout tone="warn" title="The design has changes that are not published" actions={write ? <LinkButton href={`${base}/edit`} size="sm">Open the design</LinkButton> : undefined}>
          Image URLs show the last published look until you publish again.
        </Callout>
      ) : null}
      {problem ? <Callout tone="bad" title="We couldn’t make that URL">{problem}</Callout> : null}
      <div
        class="img-share"
        data-images-share
        data-template={template.id}
        data-api={API}
        data-doc={JSON.stringify(doc)}
        data-custom={JSON.stringify(custom)}
        data-server-png={settings.serverPng ? '1' : undefined}
        data-first={template.firstRequestAt ? '1' : undefined}
        data-can-write={write ? '1' : undefined}
      >
        <Card title="What it says" description="Change a field and the image follows.">
          <form method="get" action={base} class="form" data-share-form>
            <FieldInputs fields={doc.fields} values={values} />
            {doc.fields.length === 0 ? <p class="muted">This template has no fields, so every image looks the same. Add fields in the design.</p> : null}
            <details class="img-details" open={moreOpen}>
              <summary>More options</summary>
              <div class="form">
                <Field id="opt-format" label="File type" hint="SVG is drawn on the free plan. Social networks need PNG for share images.">
                  <Select id="opt-format" name="format" value={format} options={[{ value: 'svg', label: 'SVG' }, { value: 'png', label: 'PNG' }]} />
                </Field>
                <Field id="opt-width" label="Width in pixels" hint={`Leave empty for ${template.width}. The height follows.`} optional>
                  <Input id="opt-width" name="width" inputmode="numeric" value={q.width ?? ''} placeholder={String(template.width)} />
                </Field>
                <Field id="opt-expires" label="The URL stops working">
                  <Select id="opt-expires" name="expires" value={q.expires ?? ''} options={EXPIRY} />
                </Field>
                <Checkbox name="pin" value="1" checked={q.pin === '1'} label="Keep this look" description="The URL keeps drawing today’s design, even after you publish a new one." />
                {template.open ? <Checkbox name="unsigned" value="1" checked={unsigned} label="Leave the signature off" description="Anyone can then change the text in the URL. Only this template’s fields are accepted." /> : null}
              </div>
            </details>
            <div class="img-row">
              <Button type="submit" icon="refresh">Update image</Button>
            </div>
          </form>
        </Card>
        <div class="img-share-out">
          <img class="img-preview" src={previewSrc} alt={`Preview of ${template.name}`} width={template.width} height={template.height} data-share-preview />
          <p class="img-status muted" role="status" data-share-status></p>
          {link ? (
            <Card title="Image URL" description={link.signed ? 'Signed, so nobody can change the text. Paste it anywhere an image goes.' : 'Not signed: anyone can change the text in it.'}>
              <div class="input-group">
                <input class="input mono" readonly value={link.url} aria-label="Image URL" data-share-url />
                <Button variant="primary" icon="copy" data-copy={link.url} data-copied="Image URL copied." data-share-copy-url>Copy image URL</Button>
              </div>
              {link.expiresAt ? <p class="muted img-small">Stops working on {formatDateTime(new Date(link.expiresAt * 1000))}.</p> : null}
              <p class="img-wait" role="status" data-share-wait>
                {template.firstRequestAt ? (
                  <><span class="dot ok"></span> Received. The first image request arrived on {formatDateTime(new Date(template.firstRequestAt))}.</>
                ) : (
                  <><span class="dot"></span> Waiting for your first request. Open the URL, or paste it into your site. <a class="link" href={c.req.url}>Check again</a></>
                )}
              </p>
            </Card>
          ) : (
            <Callout tone="info" title="You can look, but not copy URLs">A signed image URL can be made by workspace members. Ask one of them for the URL you need.</Callout>
          )}
          {link ? (
            <Card title="Share image for a page" description="Paste these tags inside the head of a page. When the page is shared, this image shows.">
              {format === 'svg' && !settings.serverPng ? (
                <Callout tone="warn" title="Social networks need a PNG">
                  Facebook, X, LinkedIn and Slack do not show SVG share images. Press Make a PNG: your browser draws this image, we store it, and the tags below switch to the PNG.
                </Callout>
              ) : null}
              {format === 'png' && !settings.serverPng ? (
                <Callout tone="info" title="PNG URLs work for images you have made">
                  This URL shows a picture once the PNG is stored. Press Make a PNG to store this one now. Drawing PNG on the server for any URL needs the Workers Paid plan; an admin can turn it on in Settings.
                </Callout>
              ) : null}
              <div data-share-tags>
                <CodeBlock code={link.metaTags} label="meta tags" />
              </div>
              <div class="img-row">
                <Button icon="image" hidden data-share-bake>Make a PNG</Button>
                <Button icon="copy" data-copy={link.metaTags} data-copied="Meta tags copied." data-share-copy-tags>Copy meta tags</Button>
              </div>
              <noscript><p class="muted img-small">Making a PNG in the browser needs JavaScript. The API can also store one: see the docs.</p></noscript>
            </Card>
          ) : null}
          {link ? (
            <Card title="In a page or an email">
              <div data-share-html>
                <CodeBlock code={htmlSnippet(link)} label="HTML snippet" />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  ), { script: 'share.js' });
});

detail.get('/t/:id/preview.svg', async (c) => {
  const s = scopeOf(c);
  const template = await getTemplate(s.db, c.req.param('id'));
  const q = c.req.query();
  const doc = q.live === '1' && template.publishedDoc ? template.publishedDoc : template.doc;
  return svgResponse((await previewSvg(s.env, s.db, doc, fieldValues(q), intParam(q.w))).svg);
});

detail.get('/t/:id/export.json', async (c) => {
  const template = await getTemplate(scopeOf(c).db, c.req.param('id'));
  return c.json(exportTemplate(template), 200, { 'content-disposition': `attachment; filename="${template.slug}.template.json"` });
});

// --- Settings --------------------------------------------------------------------------------

interface SettingsState {
  values?: Record<string, string>;
  fields?: FieldErrors;
  message?: string;
}

function settingsPage(c: Ctx, template: Template, state: SettingsState = {}): Promise<Response> {
  const write = canWrite(c);
  const base = `${HOME}/t/${template.id}`;
  const v = state.values;
  const f = state.fields ?? {};
  const site = scopeOf(c).base;
  return page(c, template.name, (
    <>
      <PageHeader title={template.name} soft={<StatePill template={template} />} description={`${template.width} × ${template.height} · /i/${template.slug}`} />
      <TemplateTabs template={template} active="settings" />
      {state.message ? <Callout tone="bad" title="Not saved">{state.message}</Callout> : null}
      {write ? null : <Callout tone="info">Workspace members can change these settings. You can look.</Callout>}
      <Card title="Name and address">
        <form method="post" action={`${base}/settings`} class="form">
          <fieldset class="img-fieldset" disabled={!write}>
            <Field id="set-name" label="Name" error={f.name}>
              <Input id="set-name" name="name" value={v?.name ?? template.name} maxlength={80} required invalid={Boolean(f.name)} />
            </Field>
            <Field id="set-slug" label="URL name" hint="Changing it breaks every image URL already in use." error={f.slug}>
              <Input id="set-slug" name="slug" value={v?.slug ?? template.slug} prefix="/i/" maxlength={50} required invalid={Boolean(f.slug)} class="mono" />
            </Field>
            <Checkbox
              name="open"
              value="1"
              checked={v ? v.open === '1' : template.open}
              label="Allow URLs without a signature"
              description="Anyone can then make images by changing the text in the URL. Only this template’s fields are accepted, text is cut to each field’s length, pictures must be your own uploads, and each visitor can make 30 new images a minute."
            />
            <Checkbox
              name="page"
              value="1"
              checked={v ? v.page === '1' : template.page}
              label="Public generator page"
              description="A page where anyone can fill in the fields and download the image. It is drawn in their browser, so it costs you nothing."
            />
            <Field id="set-max" label="Stop after this many images" hint="New images only. Images already made keep working. Leave empty for no limit." error={f.maxRenders} optional>
              <Input id="set-max" name="maxRenders" inputmode="numeric" value={v?.maxRenders ?? (template.maxRenders === null ? '' : String(template.maxRenders))} invalid={Boolean(f.maxRenders)} />
            </Field>
            {write ? (
              <div class="img-row">
                <Button type="submit" variant="primary">Save settings</Button>
              </div>
            ) : null}
          </fieldset>
        </form>
      </Card>
      {template.page && template.published ? (
        <Card title="Generator page" description="Share this address with people who should make their own images.">
          <div class="input-group">
            <input class="input mono" readonly value={`${site}/i/${template.slug}/make`} aria-label="Generator page address" />
            <Button icon="copy" data-copy={`${site}/i/${template.slug}/make`} data-copied="Page address copied.">Copy</Button>
            <LinkButton href={`/i/${template.slug}/make`} icon="out" target="_blank" rel="noopener">Open</LinkButton>
          </div>
        </Card>
      ) : null}
      <Card title="Copies" description={`${formatNumber(template.renders)} images made so far. Version ${template.version}.`}>
        <div class="img-row">
          <LinkButton href={`${base}/export.json`} icon="download">Export as a file</LinkButton>
          {write ? (
            <form method="post" action={`${base}/duplicate`}>
              <Button type="submit" icon="copy">Duplicate</Button>
            </form>
          ) : null}
        </div>
      </Card>
      {write ? (
        <DangerZone
          items={[
            {
              title: 'Clear stored images',
              description: 'Deletes the images drawn from URLs, so they are drawn again when next asked for. PNG files you made in the browser are kept.',
              action: (
                <form method="post" action={`${base}/clear`}>
                  <ConfirmButton id="clear" title="Clear stored images?" body="Images drawn from URLs are deleted and drawn again on the next request. That uses your daily allowance again." confirmLabel="Clear images">Clear</ConfirmButton>
                </form>
              ),
            },
            {
              title: 'Delete this template',
              description: 'Every image URL of this template stops working, and its stored images are deleted.',
              action: (
                <form method="post" action={`${base}/delete`}>
                  <ConfirmButton id="delete" title={`Delete ${template.name}?`} body="Every image URL made from this template stops working at once. Pages that use them will show a broken image. This cannot be undone." confirmLabel="Delete template" icon="trash">Delete</ConfirmButton>
                </form>
              ),
            },
          ]}
        />
      ) : null}
    </>
  ), { status: state.message ? 422 : 200 });
}

detail.get('/t/:id/settings', async (c) => settingsPage(c, await getTemplate(scopeOf(c).db, c.req.param('id'))));

detail.post('/t/:id/settings', async (c) => {
  writer(c);
  const s = scopeOf(c);
  const id = c.req.param('id');
  const form = await readForm(c);
  const values = { name: text(form, 'name'), slug: text(form, 'slug'), open: checked(form, 'open') ? '1' : '', page: checked(form, 'page') ? '1' : '', maxRenders: text(form, 'maxRenders') };
  try {
    const max = numberIn(form, 'maxRenders');
    const template = await updateTemplate(s.db, id, {
      name: values.name,
      slug: values.slug,
      open: values.open === '1',
      page: values.page === '1',
      // Anything typed that is not a number goes through as it is, so the form can say what is wrong with it.
      maxRenders: values.maxRenders === '' ? null : (max ?? Number.NaN),
    });
    await auditFromRequest(c, {
      action: 'images.template.settings_changed',
      targetType: 'image_template',
      targetId: template.id,
      summary: `Changed the settings of the image template "${template.name}"`,
      meta: { open: template.open, page: template.page, slug: template.slug, maxRenders: template.maxRenders },
    });
    return flashAndGo(c, 'ok', 'Settings saved.', `${HOME}/t/${id}/settings`);
  } catch (err) {
    const { message, fields } = plainError(err);
    return settingsPage(c, await getTemplate(s.db, id), { values, fields, message });
  }
});

/** Runs one template action and goes back with a message, turning a refusal into a red message instead of an error page. */
async function act(c: Ctx, back: string, run: () => Promise<{ message: string; to?: string }>): Promise<Response> {
  writer(c);
  try {
    const done = await run();
    return flashAndGo(c, 'ok', done.message, done.to ?? back);
  } catch (err) {
    return flashAndGo(c, 'error', refusal(err), back);
  }
}

detail.post('/t/:id/publish', (c) => {
  const s = scopeOf(c);
  const id = c.req.param('id');
  return act(c, `${HOME}/t/${id}/edit`, async () => {
    const template = await publishTemplate(s.env, s.db, id);
    await auditFromRequest(c, { action: 'images.template.published', targetType: 'image_template', targetId: id, summary: `Published version ${template.version} of the image template "${template.name}"` });
    return { message: `Published. Image URLs now show version ${template.version}.`, to: `${HOME}/t/${id}` };
  });
});

detail.post('/t/:id/revert', (c) => {
  const s = scopeOf(c);
  const id = c.req.param('id');
  return act(c, `${HOME}/t/${id}/edit`, async () => {
    await revertTemplate(s.db, id);
    return { message: 'Your changes were dropped. The design is back to the published look.' };
  });
});

detail.post('/t/:id/duplicate', (c) => {
  const s = scopeOf(c);
  const id = c.req.param('id');
  return act(c, `${HOME}/t/${id}/settings`, async () => {
    const copy = await duplicateTemplate(s.env, s.db, id, s.actor);
    await auditFromRequest(c, { action: 'images.template.created', targetType: 'image_template', targetId: copy.id, summary: `Created the image template "${copy.name}" as a copy` });
    return { message: `Made a copy called "${copy.name}".`, to: `${HOME}/t/${copy.id}/edit` };
  });
});

detail.post('/t/:id/clear', (c) => {
  const s = scopeOf(c);
  const id = c.req.param('id');
  return act(c, `${HOME}/t/${id}/settings`, async () => {
    await clearRenders(s.env, s.db, id);
    await auditFromRequest(c, { action: 'images.template.cache_cleared', targetType: 'image_template', targetId: id, summary: 'Cleared the stored images of an image template' });
    return { message: 'Stored images are being cleared. This takes a moment.' };
  });
});

detail.post('/t/:id/delete', (c) => {
  const s = scopeOf(c);
  const id = c.req.param('id');
  return act(c, `${HOME}/t/${id}/settings`, async () => {
    const template = await getTemplate(s.db, id);
    await deleteTemplate(s.env, s.db, id);
    await auditFromRequest(c, { action: 'images.template.deleted', targetType: 'image_template', targetId: id, summary: `Deleted the image template "${template.name}"` });
    return { message: `Deleted "${template.name}".`, to: HOME };
  });
});

export { detail };
