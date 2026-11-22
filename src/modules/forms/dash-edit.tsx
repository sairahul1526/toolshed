/** The builder's page. The editing itself runs in public/m/forms/builder.js. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { orgDb } from '../../core/db';
import { Button, Dialog, EditorBar, Icon, renderPage } from '../../ui';
import { BASE, statusPill, type C } from './dash-common';
import { draftDiffers, getDraft, getForm } from './service';
import type { Definition, Field } from './schema';

export const editRoutes = new Hono<AppEnv>();

const TYPES: { type: Field['type']; label: string; group: string }[] = [
  { type: 'short_text', label: 'Short text', group: 'Text' },
  { type: 'long_text', label: 'Long text', group: 'Text' },
  { type: 'email', label: 'Email', group: 'Text' },
  { type: 'number', label: 'Number', group: 'Text' },
  { type: 'phone', label: 'Phone', group: 'Text' },
  { type: 'url', label: 'Website address', group: 'Text' },
  { type: 'date', label: 'Date', group: 'Text' },
  { type: 'single_choice', label: 'Single choice', group: 'Choice' },
  { type: 'multiple_choice', label: 'Multiple choice', group: 'Choice' },
  { type: 'dropdown', label: 'Dropdown', group: 'Choice' },
  { type: 'yes_no', label: 'Yes or no', group: 'Choice' },
  { type: 'consent', label: 'Consent checkbox', group: 'Choice' },
  { type: 'rating', label: 'Rating', group: 'Scores' },
  { type: 'nps', label: 'Net promoter score', group: 'Scores' },
  { type: 'csat', label: 'Satisfaction', group: 'Scores' },
  { type: 'ces', label: 'Effort score', group: 'Scores' },
  { type: 'scale', label: 'Number scale', group: 'Scores' },
  { type: 'file_upload', label: 'File upload', group: 'Other' },
  { type: 'hidden', label: 'Hidden field from the link', group: 'Other' },
  { type: 'statement', label: 'Statement', group: 'Layout' },
  { type: 'section', label: 'Section heading', group: 'Layout' },
];

/** Safe inside a script tag: no closing tags, no HTML comments. */
function embed(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function Outline({ def }: { def: Definition }) {
  return (
    <ol>
      {def.pages.map((p) => (
        <li>
          {p.title || 'Page'}
          <ul>
            {p.fields.map((f) => (
              <li>{f.label || f.type}</li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

editRoutes.get('/:id/edit', async (c: C) => {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, c.req.param('id') ?? '');
  if (form.trashedAt) return c.redirect(BASE, 303);
  const def = await getDraft(db, form);
  const unpublished = await draftDiffers(db, form);
  const data = { form: { id: form.id, name: form.name, slug: form.slug, rev: form.rev, status: form.status }, definition: def, types: TYPES };
  return renderPage(
    c,
    { title: `Edit ${form.name}`, crumbs: [{ label: 'Forms', href: BASE }, { label: form.name }, { label: 'Edit' }] },
    <>
      <link rel="stylesheet" href="/m/forms/builder.css" />
      <EditorBar
        back={{ href: `${BASE}/${form.id}/responses`, label: 'Responses' }}
        title={form.name}
        status={
          <>
            {statusPill(form)}
            <span id="fb-live" class="fm-muted" hidden={!unpublished}>
              {' '}
              Unpublished changes
            </span>
            <span id="fb-status" class="fb-status" role="status" aria-live="polite" />
          </>
        }
        actions={
          <>
            <Button size="sm" id="fb-undo" type="button" disabled>
              Undo
            </Button>
            <Button size="sm" id="fb-redo" type="button" disabled>
              Redo
            </Button>
            <Button size="sm" type="button" data-open="fb-history" icon="history">
              History
            </Button>
            <a id="fb-share" class="btn sm" href={`${BASE}/${form.id}/share`} hidden={form.status === 'draft'}>
              Share
            </a>
            <Button size="sm" variant="primary" id="fb-publish" type="button">
              {form.status === 'draft' ? 'Publish' : 'Publish changes'}
            </Button>
          </>
        }
      />
      <div id="fb-banner" class="fb-banner" role="alert" hidden />
      <noscript>
        <p class="fm-muted">The editor needs JavaScript. Here is the form as it stands, read only.</p>
        <Outline def={def} />
      </noscript>
      <p id="fb-keys" class="fb-keys">
        Keyboard: focus a block, then Alt with the up or down arrow moves it, Delete removes it, and Ctrl or Cmd with Z undoes.
      </p>
      <div class="fb">
        <div class="fb-main" id="fb-canvas" aria-label="Form blocks">
          <Outline def={def} />
        </div>
        <aside class="fb-side" id="fb-inspector" aria-label="Edit the selected item" />
      </div>
      <Dialog id="fb-history" title="Version history" description="Restoring puts an earlier version into the editor. It does not change what is live until you publish." footer={<Button type="button" data-close>Close</Button>}>
        <div id="fb-history-list" aria-live="polite" />
      </Dialog>
      <script type="application/json" id="fb-data" dangerouslySetInnerHTML={{ __html: embed(data) }} />
      <script src="/m/forms/builder.js" defer />
      <span hidden>
        <Icon name="check" />
      </span>
    </>,
  );
});
