/** Sharing: link, embed snippets, publish and close, and the first response check. */
import { Hono } from 'hono';
import { orgDb } from '../../core/db';
import { emailReady } from '../../core/email';
import { baseUrl } from '../../core/net';
import type { AppEnv } from '../../env';
import { Button, Callout, Card, CodeBlock, CopyField, PageHeader, renderPage } from '../../ui';
import { BASE, CSS, FormTabs, act, crumbs, statusPill, type C } from './dash-common';
import { actorOf, ctxOf } from './http';
import { availability, closeForm, getForm, publish, reopenForm } from './service';

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get('/:id/share', async (c: C) => {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, c.req.param('id') ?? '');
  const base = baseUrl(c);
  const url = `${base}/f/${form.slug}`;
  const live = form.status === 'live';
  const avail = availability(form);
  const mailOk = await emailReady(c.env);
  const needsMail = form.settings.notify.enabled || form.settings.autoresponder.enabled;
  return renderPage(
    c,
    { title: `Share ${form.name}`, crumbs: crumbs(form, 'Share') },
    <>
      {CSS}
      <PageHeader title={form.name} soft={undefined} description="Publish the form, then share the link or put it on your site." />
      <FormTabs form={form} active="share" />
      {needsMail && !mailOk ? (
        <Callout tone="warn" title="Email is not set up" actions={<a class="btn sm" href="/app/email">Set up email</a>}>
          Notifications and autoresponders are on for this form, but nothing is sent until the workspace can send email.
        </Callout>
      ) : null}
      <Card title="Status" description={live ? (avail.open ? 'The form is live and taking responses.' : 'The form is live but not taking responses right now. Check the dates and the response limit in settings.') : form.status === 'closed' ? 'The form is closed. People who open the link see a closed message.' : 'The form is a draft. Nobody can see it yet.'}>
        <form method="post" class="fm-actions">
          {statusPill(form)}
          {form.status === 'draft' ? (
            <Button variant="primary" type="submit" formAction={`${BASE}/${form.id}/publish`}>Publish</Button>
          ) : null}
          {live ? <Button type="submit" formAction={`${BASE}/${form.id}/close`}>Close the form</Button> : null}
          {form.status === 'closed' ? <Button variant="primary" type="submit" formAction={`${BASE}/${form.id}/reopen`}>Reopen the form</Button> : null}
          <a class="btn" href={`${BASE}/${form.id}/edit`}>Edit the form</a>
        </form>
      </Card>
      {form.status !== 'draft' ? (
        <>
          <Card title="Link" description="Anyone with the link can open the form. Add ?name=value to fill hidden fields.">
            <CopyField label="Form link" value={url} secret={false} />
            <p class="fm-wait" data-wait data-url={`/api/v1/forms/${form.id}/submissions?limit=1`} data-state={form.responseCount > 0 ? 'got' : 'waiting'} role="status">
              <span data-wait-text>{form.responseCount > 0 ? 'Received. Your first response is in.' : 'Waiting for the first response...'}</span>
              <a class="btn sm" href={url} target="_blank" rel="noopener">Open the form</a>
            </p>
          </Card>
          <Card title="Put it on your site" description="The inline embed grows to fit the form. The popup opens it over the page. The script is under 8 KB and loads nothing else.">
            <CodeBlock label="Inline embed" code={`<div data-toolshed-form="${url}"></div>\n<script src="${base}/m/forms/embed.js" async></script>`} />
            <CodeBlock label="Popup button" code={`<button data-toolshed-form-popup="${url}">Open the form</button>\n<script src="${base}/m/forms/embed.js" async></script>`} />
            <CodeBlock label="Plain iframe" code={`<iframe src="${url}/embed" title="${form.name.replace(/"/g, '')}" width="100%" height="640" style="border:0"></iframe>`} />
          </Card>
        </>
      ) : null}
    </>,
  );
});

const to = (c: C) => `${BASE}/${c.req.param('id')}/share`;
shareRoutes.post('/:id/publish', (c: C) =>
  act(c, to(c), async () => {
    await publish(ctxOf(c), c.req.param('id') ?? '', actorOf(c));
    return 'Published. The link is live.';
  }),
);
shareRoutes.post('/:id/close', (c: C) =>
  act(c, to(c), async () => {
    await closeForm(ctxOf(c), c.req.param('id') ?? '');
    return 'The form is closed.';
  }),
);
shareRoutes.post('/:id/reopen', (c: C) =>
  act(c, to(c), async () => {
    await reopenForm(ctxOf(c), c.req.param('id') ?? '');
    return 'The form is open again.';
  }),
);
