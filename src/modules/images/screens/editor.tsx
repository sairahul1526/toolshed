/**
 * The design page. With JavaScript the editor script builds the full layer editor inside the mount
 * element; without it, the form underneath still changes text, sizes and colours.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, ConfirmButton, Field, Input, PageHeader, Textarea } from '../../../ui';
import { API, HOME, TemplateTabs, canWrite, flashAndGo, numberIn, page, plainError, readForm, text, writer, type Ctx, type Form } from '../dash-shared';
import { scopeOf } from '../http';
import { listAssets } from '../assets';
import { customFamilies } from '../render';
import type { TemplateDoc } from '../schema';
import { getSettings } from '../settings';
import { getTemplate, updateTemplate, type Template } from '../templates';
import { StatePill } from './templates';

/** A colour typed into a form: a hex value, or a field such as {{accent}}. */
const PAINT_HINT = 'A hex colour such as #1d4ed8, or a field such as {{accent}}.';

function PublishBar({ template }: { template: Template }) {
  const base = `${HOME}/t/${template.id}`;
  const dirty = template.unpublishedChanges;
  return (
    <div class="img-publish">
      <p class="img-status" role="status" data-editor-status>
        {dirty ? (template.published ? 'This design has changes that are not published.' : 'This design is a draft. Publish it to get image URLs.') : 'Published. Image URLs show this design.'}
      </p>
      <span class="img-row">
        {template.published && dirty ? (
          <form method="post" action={`${base}/revert`}>
            <ConfirmButton id="revert" title="Drop your changes?" body="The design goes back to the published look. Your unpublished changes are lost." confirmLabel="Drop changes" variant="ghost">Drop changes</ConfirmButton>
          </form>
        ) : null}
        <form method="post" action={`${base}/publish`} data-editor-publish>
          <Button type="submit" variant="primary" icon="check" disabled={!dirty} data-editor-publish-button>Publish</Button>
        </form>
      </span>
    </div>
  );
}

/** The plain form: every field's default, each text layer's words, size and colour, and the background. */
function Fallback({ template, doc, problems }: { template: Template; doc: TemplateDoc; problems: string[] }) {
  const texts = doc.layers.filter((layer) => layer.type === 'text');
  return (
    <Card title="Change text and colours" description="Saves to the draft. Publish when it looks right.">
      {problems.length ? (
        <Callout tone="bad" title="Not saved">
          <ul class="img-problems">
            {problems.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <form method="post" action={`${HOME}/t/${template.id}/edit`} class="form">
        <Field id="fb-bg" label="Background colour" hint={PAINT_HINT}>
          <Input id="fb-bg" name="background" value={doc.background} maxlength={40} class="mono" />
        </Field>
        {doc.fields.map((field) => (
          <Field id={`fb-field-${field.name}`} label={`Field “${field.label || field.name}”: what it says when the URL leaves it out`}>
            <Input id={`fb-field-${field.name}`} name={`field.${field.name}`} value={field.default} maxlength={2000} />
          </Field>
        ))}
        {texts.map((layer) => (
          <fieldset class="img-fieldset img-group">
            <legend>{layer.name || layer.id}</legend>
            <Field id={`fb-text-${layer.id}`} label="Text" hint="Put a field in double braces, such as {{title}}.">
              <Textarea id={`fb-text-${layer.id}`} name={`text.${layer.id}`} rows={2} value={layer.text} maxlength={2000} />
            </Field>
            <div class="grid-2">
              <Field id={`fb-size-${layer.id}`} label="Size in pixels">
                <Input id={`fb-size-${layer.id}`} name={`size.${layer.id}`} inputmode="numeric" value={String(layer.size)} />
              </Field>
              <Field id={`fb-color-${layer.id}`} label="Colour">
                <Input id={`fb-color-${layer.id}`} name={`color.${layer.id}`} value={layer.color} maxlength={40} class="mono" />
              </Field>
            </div>
          </fieldset>
        ))}
        <div class="img-row">
          <Button type="submit" variant="primary">Save draft</Button>
        </div>
      </form>
    </Card>
  );
}

async function editorPage(c: Ctx, template: Template, state: { doc?: TemplateDoc; problems?: string[] } = {}): Promise<Response> {
  const s = scopeOf(c);
  const write = canWrite(c);
  const base = `${HOME}/t/${template.id}`;
  const doc = state.doc ?? template.doc;
  const head = (
    <>
      <PageHeader title={template.name} soft={<StatePill template={template} />} description={`${template.width} × ${template.height} · /i/${template.slug}`} />
      <TemplateTabs template={template} active="edit" />
    </>
  );
  if (!write) {
    return page(c, template.name, (
      <>
        {head}
        <Callout tone="info">Workspace members can change this design. You can look.</Callout>
        <img class="img-preview" src={`${base}/preview.svg`} alt={`Draft of ${template.name}`} width={template.width} height={template.height} />
      </>
    ));
  }
  const [custom, assets, settings] = await Promise.all([customFamilies(s.db), listAssets(s.db, { kind: 'image', limit: 100 }), getSettings(s.env, s.db.orgId)]);
  const pictures = assets.items.map((asset) => ({ ref: asset.ref, name: asset.name, path: asset.path }));
  return page(c, template.name, (
    <>
      {head}
      <PublishBar template={template} />
      <div
        class="img-editor"
        data-images-editor
        data-template={template.id}
        data-api={API}
        data-doc={JSON.stringify(template.doc)}
        data-custom={JSON.stringify(custom)}
        data-pictures={JSON.stringify(pictures)}
        data-hosts={JSON.stringify(settings.allowedHosts)}
        data-assets-href={`${HOME}/assets`}
      ></div>
      <div data-editor-fallback>
        <img class="img-preview" src={`${base}/preview.svg`} alt={`Draft of ${template.name}`} width={template.width} height={template.height} />
        <Fallback template={template} doc={doc} problems={state.problems ?? []} />
      </div>
    </>
  ), { script: 'editor.js', status: state.problems?.length ? 422 : 200 });
}

/** Applies the plain form to a copy of the draft. Boxes that were not in the form keep their value. */
function applyForm(doc: TemplateDoc, form: Form): TemplateDoc {
  const next = structuredClone(doc);
  if ('background' in form) next.background = text(form, 'background');
  for (const field of next.fields) {
    if (`field.${field.name}` in form) field.default = text(form, `field.${field.name}`);
  }
  for (const layer of next.layers) {
    if (layer.type !== 'text') continue;
    if (`text.${layer.id}` in form) layer.text = text(form, `text.${layer.id}`);
    if (`color.${layer.id}` in form) layer.color = text(form, `color.${layer.id}`);
    // Anything that is not a number goes through as it is, so the check can say what is wrong with it.
    if (`size.${layer.id}` in form) layer.size = numberIn(form, `size.${layer.id}`) ?? Number.NaN;
  }
  return next;
}

const editor = new Hono<AppEnv>();

editor.get('/t/:id/edit', async (c) => editorPage(c, await getTemplate(scopeOf(c).db, c.req.param('id'))));

editor.post('/t/:id/edit', async (c) => {
  writer(c);
  const s = scopeOf(c);
  const id = c.req.param('id');
  const template = await getTemplate(s.db, id);
  const doc = applyForm(template.doc, await readForm(c));
  try {
    await updateTemplate(s.db, id, { doc });
    return flashAndGo(c, 'ok', 'Draft saved. Publish it to change your image URLs.', `${HOME}/t/${id}/edit`);
  } catch (err) {
    const { message, fields } = plainError(err);
    const lines = Object.values(fields);
    return editorPage(c, template, { doc, problems: lines.length ? [...new Set(lines)] : [message] });
  }
});

export { editor };
