/** The forms list, and what a workspace sees before it has a form. */
import { Hono } from 'hono';
import { orgDb } from '../../core/db';
import { AppError } from '../../core/errors';
import type { AppEnv } from '../../env';
import { Button, Callout, Card, ConfirmButton, Dialog, EmptyState, FilterBar, PageHeader, Pagination, Pill, SearchInput, Select, Table, Tabs, formatNumber, renderPage, setFlash, timeAgo } from '../../ui';
import { BASE, CSS, act, body, statusPill, str, type C } from './dash-common';
import { actorOf, ctxOf, intParam } from './http';
import { addSampleForms, clearSampleForms } from './sample';
import { countForms, createForm, deleteForm, duplicateForm, listForms, restoreForm, trashForm } from './service';
import { TEMPLATES } from './templates';

export const listRoutes = new Hono<AppEnv>();
const PAGE = 20;

function TemplateGrid({ idPrefix }: { idPrefix: string }) {
  return (
    <form method="post" action={`${BASE}/new`}>
      <ul class="fm-templates" role="list">
        {TEMPLATES.map((t) => (
          <li>
            <button type="submit" name="templateId" value={t.id} class="fm-tpl" id={`${idPrefix}-${t.id}`}>
              <b>{t.name}</b>
              <span>{t.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </form>
  );
}

listRoutes.get('/', async (c: C) => {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const trashed = c.req.query('view') === 'trash';
  const q = str(c.req.query('q'));
  const status = str(c.req.query('status'));
  const page = intParam(c.req.query('page'), 1, 1, 10_000);
  const [forms, total, active, inTrash] = await Promise.all([
    listForms(db, { trashed, q: q || undefined, status: status || undefined, limit: PAGE, offset: (page - 1) * PAGE }),
    countForms(db, { trashed }),
    countForms(db),
    countForms(db, { trashed: true }),
  ]);
  const filtered = Boolean(q || status);

  if (active === 0 && inTrash === 0) {
    return renderPage(
      c,
      { title: 'Forms', description: 'Start from a template or build your own.' },
      <>
        {CSS}
        <PageHeader title="Forms" description="Collect responses, files and scores. Pick a starting point. You can change everything afterwards." />
        <Card title="Start from a template" description="Each one is a working form with sensible questions, a thank you message and, where it makes sense, a score.">
          <TemplateGrid idPrefix="first" />
        </Card>
        <Card title="Just looking around" description="Add three sample forms with made up responses to see how the screens fill up. Remove them in one click later." class="fm-sample">
          <form method="post" action={`${BASE}/sample`}>
            <input type="hidden" name="on" value="1" />
            <Button type="submit">Add sample forms</Button>
          </form>
        </Card>
      </>,
    );
  }

  const hasSample = forms.some((f) => f.sample);
  const rows = forms.map((f) => ({
    name: (
      <span class="fm-row-name">
        <a href={`${BASE}/${f.id}/${f.status === 'draft' ? 'edit' : 'responses'}`}>{f.name}</a>
        <span class="fm-muted">/f/{f.slug}</span>
      </span>
    ),
    status: (
      <>
        {statusPill(f)} {f.sample ? <Pill>Sample</Pill> : null}
      </>
    ),
    responses: formatNumber(f.responseCount),
    last: f.lastResponseAt ? timeAgo(f.lastResponseAt) : 'None yet',
    actions: (
      <form method="post" class="fm-actions">
        {trashed ? (
          <>
            <Button size="sm" type="submit" formAction={`${BASE}/${f.id}/restore`}>
              Restore
            </Button>
            <ConfirmButton size="sm" id={`del-${f.id}`} title={`Delete ${f.name} for good?`} body="The form, its responses and its files are removed. This cannot be undone." confirmLabel="Delete for good" formAction={`${BASE}/${f.id}/delete`}>
              Delete
            </ConfirmButton>
          </>
        ) : (
          <>
            <Button size="sm" type="submit" formAction={`${BASE}/${f.id}/duplicate`}>
              Duplicate
            </Button>
            <ConfirmButton size="sm" id={`trash-${f.id}`} title={`Move ${f.name} to the trash?`} body="It stops taking responses. You can restore it from the trash." confirmLabel="Move to trash" formAction={`${BASE}/${f.id}/trash`}>
              Trash
            </ConfirmButton>
          </>
        )}
      </form>
    ),
  }));
  const href = (p: number) => `${BASE}?${new URLSearchParams({ ...(trashed ? { view: 'trash' } : {}), ...(q ? { q } : {}), ...(status ? { status } : {}), page: String(p) })}`;

  return renderPage(
    c,
    { title: 'Forms' },
    <>
      {CSS}
      <PageHeader
        title="Forms"
        description="Every form in this workspace."
        actions={
          <Button variant="primary" icon="plus" data-open="fm-new">
            New form
          </Button>
        }
      />
      {hasSample ? (
        <Callout tone="info" title="Sample forms are on" actions={<form method="post" action={`${BASE}/sample`}><input type="hidden" name="on" value="0" /><Button size="sm" type="submit">Remove sample forms</Button></form>}>
          The forms marked Sample hold made up responses so you can look around. Your own forms are not touched.
        </Callout>
      ) : null}
      <Tabs
        label="Forms view"
        active={trashed ? 'trash' : 'active'}
        items={[
          { id: 'active', label: 'Forms', count: active, href: BASE },
          { id: 'trash', label: 'Trash', count: inTrash, href: `${BASE}?view=trash` },
        ]}
      />
      <FilterBar action={BASE}>
        {trashed ? <input type="hidden" name="view" value="trash" /> : null}
        <SearchInput name="q" label="Search forms" placeholder="Search by name" value={q} />
        <Select
          id="fm-status"
          name="status"
          aria-label="Status"
          value={status}
          options={[
            { value: '', label: 'Any status' },
            { value: 'draft', label: 'Draft' },
            { value: 'live', label: 'Live' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </FilterBar>
      <Card flush>
        <Table
          caption={trashed ? 'Forms in the trash' : 'Forms'}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status' },
            { key: 'responses', label: 'Responses', numeric: true },
            { key: 'last', label: 'Last response', hideOnMobile: true },
            { key: 'actions', label: 'Actions', srOnly: true },
          ]}
          rows={rows}
          empty={
            <EmptyState
              bare
              icon="form"
              title={filtered ? 'No forms match' : trashed ? 'The trash is empty' : 'No forms'}
              body={filtered ? 'Try a different search or status.' : trashed ? 'Forms you trash show up here for restoring.' : 'Create one from a template.'}
            />
          }
        />
      </Card>
      <Pagination page={page} pageSize={PAGE} total={total} href={href} noun={['form', 'forms']} />
      <Dialog id="fm-new" title="New form" description="Pick a starting point. You can change everything afterwards." size="wide">
        <TemplateGrid idPrefix="new" />
      </Dialog>
    </>,
  );
});

listRoutes.post('/new', async (c: C) => {
  const b = await body(c);
  try {
    const form = await createForm(ctxOf(c), { templateId: str(b.templateId) || undefined, name: str(b.name) || undefined }, actorOf(c));
    return c.redirect(`${BASE}/${form.id}/edit`, 303);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    setFlash(c, { kind: 'error', message: e.message });
    return c.redirect(BASE, 303);
  }
});

listRoutes.post('/sample', async (c: C) => {
  const on = str((await body(c)).on) === '1';
  return act(c, BASE, async () => {
    if (on) {
      await addSampleForms(ctxOf(c));
      return 'Sample forms added.';
    }
    await clearSampleForms(ctxOf(c));
    return 'Sample forms removed.';
  });
});

listRoutes.post('/:id/duplicate', (c: C) =>
  act(c, BASE, async () => {
    await duplicateForm(ctxOf(c), c.req.param('id') ?? '', actorOf(c));
    return 'Form duplicated. The copy is a draft.';
  }),
);
listRoutes.post('/:id/trash', (c: C) =>
  act(c, BASE, async () => {
    await trashForm(ctxOf(c), c.req.param('id') ?? '');
    return 'Moved to the trash.';
  }),
);
listRoutes.post('/:id/restore', (c: C) =>
  act(c, BASE, async () => {
    await restoreForm(ctxOf(c), c.req.param('id') ?? '');
    return 'Form restored.';
  }),
);
listRoutes.post('/:id/delete', (c: C) =>
  act(c, `${BASE}?view=trash`, async () => {
    await deleteForm(ctxOf(c), c.req.param('id') ?? '');
    return 'Form deleted for good.';
  }),
);
