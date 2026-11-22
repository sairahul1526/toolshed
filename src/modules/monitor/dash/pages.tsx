/** Status pages: list, create, and one screen per page with tabs for components, settings, look, subscribers and sharing. */
import { Hono } from 'hono';
import { z } from 'zod';
import { parse } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, CodeBlock, ConfirmButton, CopyField, EmptyState, Field, LinkButton, PageHeader, Pill, Select, Table, Tabs, formatDateTime, formatNumber, renderPage } from '../../../ui';
import { listMonitors, viewBase } from '../monitors';
import { MAX_COMPONENTS, createComponent, createGroup, createPage, deleteComponent, deleteGroup, deletePage, getPage, listPages, pageParts, reorder, updateComponent, updateGroup, updatePage } from '../pages';
import { MANUAL_STATUSES, type ComponentRow, type GroupRow, type PageRow } from '../schema';
import { listSubscribers, removeSubscriber, subscriberCounts } from '../subscribers';
import { Assets, AreaField, BASE, Back, Problems, TextField, Toggle, failed, done, mctx, on, readForm, record, text, type C, type Errors, type Values } from './common';

const app = new Hono<AppEnv>();

const TABS = ['components', 'settings', 'look', 'subscribers', 'share'] as const;
type Tab = (typeof TABS)[number];
const tabQuery = z.object({ tab: z.enum(TABS).default('components') });

const MANUAL_LABEL: Record<string, string> = { operational: 'Operational', degraded: 'Degraded performance', partial: 'Partial outage', major: 'Major outage' };

/* ------------------------------------------------------------ list */

app.get('/pages', async (c) => {
  const ctx = await mctx(c);
  const rows = await listPages(ctx);
  const base = viewBase(c.env, c.req.url);
  return renderPage(
    c,
    { title: 'Status pages', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Status pages' }] },
    <>
      <Assets />
      <PageHeader
        title="Status pages"
        description="A public page that shows your customers what is up, what is down and what you are doing about it."
        actions={
          <LinkButton variant="primary" icon="plus" href={`${BASE}/pages/new`}>
            New status page
          </LinkButton>
        }
      />
      <Card flush>
        <Table
          caption="Status pages"
          columns={[
            { key: 'title', label: 'Page' },
            { key: 'state', label: 'State' },
            { key: 'url', label: 'Address', hideOnMobile: true },
          ]}
          rows={rows.map((p) => ({
            title: (
              <a class="mon-name" href={`${BASE}/pages/${p.id}`}>
                <b>{p.title}</b>
                <span>{p.description ?? 'No description'}</span>
              </a>
            ),
            state: p.published ? <Pill tone="good">Public</Pill> : <Pill>Draft</Pill>,
            url: p.published ? <a href={`/status/${p.slug}`}>{`${base}/status/${p.slug}`}</a> : <span class="muted">Not public</span>,
          }))}
          empty={<EmptyState bare icon="globe" title="No status page yet" body="Make one and share the link. It updates by itself from your monitors." actions={<LinkButton variant="primary" href={`${BASE}/pages/new`}>Create a status page</LinkButton>} />}
        />
      </Card>
    </>,
  );
});

/* ------------------------------------------------------------ create */

async function newForm(c: C, v: Values = {}, errors: Errors = {}, status?: 422) {
  return renderPage(
    c,
    { title: 'New status page', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Status pages', href: `${BASE}/pages` }, { label: 'New' }], status },
    <>
      <Assets />
      <Back href={`${BASE}/pages`}>All status pages</Back>
      <PageHeader title="New status page" description="You add the parts that go on it next." />
      <form method="post" action={`${BASE}/pages/new`} class="stack" novalidate>
        <Problems errors={errors} shown={['title', 'slug']} />
        <Card>
          <div class="stack">
            <TextField id="title" label="Title" v={v} errors={errors} maxlength={100} placeholder="Acme status" />
            <TextField id="slug" label="Address" v={v} errors={errors} optional placeholder="acme" hint="Letters, numbers and dashes. We pick one from the title if you leave it empty." />
          </div>
        </Card>
        <div class="row">
          <Button type="submit" variant="primary">
            Create page
          </Button>
          <LinkButton href={`${BASE}/pages`}>Cancel</LinkButton>
        </div>
      </form>
    </>,
  );
}

app.get('/pages/new', (c) => newForm(c));

app.post('/pages/new', async (c) => {
  const v = await readForm(c);
  const ctx = await mctx(c);
  try {
    const p = await createPage(ctx, { title: text(v, 'title'), slug: text(v, 'slug'), published: true });
    await record(c, 'monitor.page_created', 'page', p.id, `Created status page ${p.title}`);
    return done(c, 'Status page created. Add the monitors you want on it.', `${BASE}/pages/${p.id}`);
  } catch (e) {
    return failed(c, e, `${BASE}/pages/new`, (errors) => newForm(c, v, errors, 422));
  }
});

/* ------------------------------------------------------------ one page */

interface Loaded {
  page: PageRow;
  groups: GroupRow[];
  components: ComponentRow[];
}

async function screen(c: C, id: string, tab: Tab, o: { v?: Values; errors?: Errors; status?: 422 } = {}) {
  const ctx = await mctx(c);
  const page = await getPage(ctx, id);
  const parts = await pageParts(ctx, page.id);
  const loaded: Loaded = { page, ...parts };
  const base = viewBase(c.env, c.req.url);
  const counts = await subscriberCounts(ctx, page.id);
  const errors = o.errors ?? {};
  const v = o.v ?? {};
  return renderPage(
    c,
    { title: page.title, crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Status pages', href: `${BASE}/pages` }, { label: page.title }], status: o.status },
    <>
      <Assets />
      <Back href={`${BASE}/pages`}>All status pages</Back>
      <PageHeader
        title={page.title}
        soft={page.published ? <Pill tone="good">Public</Pill> : <Pill>Draft</Pill>}
        description={page.published ? <a href={`/status/${page.slug}`}>{`${base}/status/${page.slug}`}</a> : 'Only you can see this page until you publish it.'}
        actions={
          page.published ? (
            <LinkButton href={`/status/${page.slug}`} icon="external">
              View page
            </LinkButton>
          ) : null
        }
      />
      <Tabs
        label="Status page sections"
        active={tab}
        items={[
          { id: 'components', label: 'Components', count: loaded.components.length, href: `${BASE}/pages/${page.id}` },
          { id: 'settings', label: 'Settings', href: `${BASE}/pages/${page.id}?tab=settings` },
          { id: 'look', label: 'Look', href: `${BASE}/pages/${page.id}?tab=look` },
          { id: 'subscribers', label: 'Subscribers', count: counts.confirmed, href: `${BASE}/pages/${page.id}?tab=subscribers` },
          { id: 'share', label: 'Share', href: `${BASE}/pages/${page.id}?tab=share` },
        ]}
      />
      {tab === 'components' ? <ComponentsTab loaded={loaded} monitors={await listMonitors(ctx)} v={v} errors={errors} /> : null}
      {tab === 'settings' ? <SettingsTab page={page} v={v} errors={errors} /> : null}
      {tab === 'look' ? <LookTab page={page} v={v} errors={errors} /> : null}
      {tab === 'subscribers' ? <SubscribersTab page={page} subs={await listSubscribers(ctx, page.id, 200)} counts={counts} /> : null}
      {tab === 'share' ? <ShareTab page={page} base={base} /> : null}
    </>,
  );
}

app.get('/pages/:id', (c) => screen(c, c.req.param('id'), parse(tabQuery, Object.fromEntries(new URL(c.req.url).searchParams)).tab));

/* ---- components */

function ComponentsTab({ loaded, monitors, v, errors }: { loaded: Loaded; monitors: { id: string; name: string }[]; v: Values; errors: Errors }) {
  const { page, groups, components } = loaded;
  const monitorOptions = [{ value: '', label: 'No monitor (set the status by hand)' }, ...monitors.map((m) => ({ value: m.id, label: m.name }))];
  const groupOptions = [{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))];
  const monitorName = new Map(monitors.map((m) => [m.id, m.name]));
  return (
    <div class="stack">
      <Problems errors={errors} shown={['name', 'monitorId', 'groupId', 'manualStatus']} />
      <Card title="Components" description="Each one is a line on the page. Link it to a monitor and it updates by itself." flush>
        {components.length === 0 ? (
          <EmptyState bare icon="layers" title="Nothing on this page yet" body={monitors.length === 0 ? 'Add a monitor first, then put it on the page.' : 'Add your first component below.'} actions={monitors.length === 0 ? <LinkButton href={`${BASE}/new`}>Add a monitor</LinkButton> : null} />
        ) : (
          <ul class="rows mon-comps">
            {components.map((x, i) => (
              <li>
                <details class="mon-more">
                  <summary>
                    <span class="row-text">
                      <b>{x.name}</b>
                      <span>
                        {x.monitor_id ? `Follows ${monitorName.get(x.monitor_id) ?? 'a monitor'}` : x.manual_status ? `Set by hand: ${MANUAL_LABEL[x.manual_status]}` : 'No monitor linked'}
                        {x.group_id ? `, in ${groups.find((g) => g.id === x.group_id)?.name ?? 'a group'}` : ''}
                      </span>
                    </span>
                  </summary>
                  <form method="post" action={`${BASE}/components/${x.id}/edit`} class="stack" novalidate>
                    <input type="hidden" name="page" value={page.id} />
                    <TextField id={`name-${x.id}`} label="Name" v={{ [`name-${x.id}`]: x.name }} maxlength={100} />
                    <TextField id={`description-${x.id}`} label="Short description" v={{ [`description-${x.id}`]: x.description ?? '' }} optional maxlength={300} />
                    <div class="form-row">
                      <Field id={`monitorId-${x.id}`} label="Monitor">
                        <Select id={`monitorId-${x.id}`} name="monitorId" value={x.monitor_id ?? ''} options={monitorOptions} />
                      </Field>
                      <Field id={`groupId-${x.id}`} label="Group">
                        <Select id={`groupId-${x.id}`} name="groupId" value={x.group_id ?? ''} options={groupOptions} />
                      </Field>
                    </div>
                    <Field id={`manualStatus-${x.id}`} label="Status by hand" hint="Overrides a good monitor when something is wrong that checks can’t see.">
                      <Select id={`manualStatus-${x.id}`} name="manualStatus" value={x.manual_status ?? ''} options={[{ value: '', label: 'Follow the monitor' }, ...MANUAL_STATUSES.map((s) => ({ value: s, label: MANUAL_LABEL[s] ?? s }))]} />
                    </Field>
                    <Toggle name="showUptime" label="Show the 90-day bars" checked={x.show_uptime === 1} />
                    <div>
                      <Button type="submit" variant="primary" size="sm">
                        Save
                      </Button>
                    </div>
                  </form>
                  <div class="row mon-comp-actions">
                  <form method="post" action={`${BASE}/pages/${page.id}/move`} class="row">
                    <input type="hidden" name="kind" value="component" />
                    <input type="hidden" name="id" value={x.id} />
                    <Button type="submit" size="sm" name="dir" value="up" disabled={i === 0}>
                      Move up
                    </Button>
                    <Button type="submit" size="sm" name="dir" value="down" disabled={i === components.length - 1}>
                      Move down
                    </Button>
                  </form>
                  <form method="post" action={`${BASE}/components/${x.id}/delete`}>
                    <input type="hidden" name="page" value={page.id} />
                    <ConfirmButton id={`dc-${x.id}`} title={`Remove ${x.name}?`} body="It leaves the page. The monitor keeps running." confirmLabel="Remove" size="sm" icon="trash">
                      Remove
                    </ConfirmButton>
                  </form>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {components.length < MAX_COMPONENTS ? (
        <Card title="Add a component" ruled>
          <form method="post" action={`${BASE}/pages/${page.id}/components`} class="stack" novalidate>
            <TextField id="name" label="Name" v={v} errors={errors} maxlength={100} placeholder="Website" />
            <div class="form-row">
              <Field id="monitorId" label="Monitor">
                <Select id="monitorId" name="monitorId" value={text(v, 'monitorId')} options={monitorOptions} />
              </Field>
              <Field id="groupId" label="Group">
                <Select id="groupId" name="groupId" value={text(v, 'groupId')} options={groupOptions} />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary">
                Add component
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      <Card title="Groups" description="Fold related components under a heading, like “Payments” or “API”." flush>
        {groups.length > 0 ? (
          <ul class="rows">
            {groups.map((g, i) => (
              <li>
                <form method="post" action={`${BASE}/groups/${g.id}/edit`} class="row grow">
                  <input type="hidden" name="page" value={page.id} />
                  <input class="input" name="name" value={g.name} aria-label={`Name of group ${g.name}`} maxlength={100} />
                  <Button type="submit" size="sm">
                    Rename
                  </Button>
                </form>
                <form method="post" action={`${BASE}/pages/${page.id}/move`} class="row">
                  <input type="hidden" name="kind" value="group" />
                  <input type="hidden" name="id" value={g.id} />
                  <Button type="submit" size="sm" name="dir" value="up" disabled={i === 0}>
                    Up
                  </Button>
                  <Button type="submit" size="sm" name="dir" value="down" disabled={i === groups.length - 1}>
                    Down
                  </Button>
                </form>
                <form method="post" action={`${BASE}/groups/${g.id}/delete`}>
                  <input type="hidden" name="page" value={page.id} />
                  <Button type="submit" size="sm" variant="danger">
                    Delete
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form method="post" action={`${BASE}/pages/${page.id}/groups`} class="row mon-addrow">
          <input class="input" name="name" placeholder="New group name" aria-label="New group name" maxlength={100} required />
          <Button type="submit">Add group</Button>
        </form>
      </Card>
    </div>
  );
}

const back = (c: C, id: string, tab = '') => `${BASE}/pages/${id}${tab ? `?tab=${tab}` : ''}`;

app.post('/pages/:id/components', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  const ctx = await mctx(c);
  try {
    const x = await createComponent(ctx, id, { name: text(v, 'name'), monitorId: text(v, 'monitorId'), groupId: text(v, 'groupId') });
    await record(c, 'monitor.component_created', 'component', x.id, `Added ${x.name} to a status page`);
    return done(c, `${x.name} added.`, back(c, id));
  } catch (e) {
    return failed(c, e, back(c, id), (errors) => screen(c, id, 'components', { v, errors, status: 422 }));
  }
});

app.post('/components/:cid/edit', async (c) => {
  const cid = c.req.param('cid');
  const v = await readForm(c);
  const pageId = text(v, 'page');
  const ctx = await mctx(c);
  try {
    const x = await updateComponent(ctx, cid, {
      name: text(v, `name-${cid}`),
      description: text(v, `description-${cid}`),
      monitorId: text(v, 'monitorId') || null,
      groupId: text(v, 'groupId') || null,
      manualStatus: text(v, 'manualStatus') || null,
      showUptime: on(v, 'showUptime'),
    });
    await record(c, 'monitor.component_updated', 'component', x.id, `Updated component ${x.name}`);
    return done(c, 'Component saved.', back(c, pageId));
  } catch (e) {
    return failed(c, e, back(c, pageId), async () => c.redirect(back(c, pageId)));
  }
});

app.post('/components/:cid/delete', async (c) => {
  const v = await readForm(c);
  const ctx = await mctx(c);
  await deleteComponent(ctx, c.req.param('cid'));
  await record(c, 'monitor.component_deleted', 'component', c.req.param('cid'), 'Removed a component from a status page');
  return done(c, 'Component removed.', back(c, text(v, 'page')));
});

app.post('/pages/:id/groups', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  const ctx = await mctx(c);
  try {
    const g = await createGroup(ctx, id, { name: text(v, 'name') });
    await record(c, 'monitor.group_created', 'group', g.id, `Added group ${g.name}`);
    return done(c, `${g.name} added.`, back(c, id));
  } catch (e) {
    return failed(c, e, back(c, id), async () => c.redirect(back(c, id)));
  }
});

app.post('/groups/:gid/edit', async (c) => {
  const v = await readForm(c);
  const pageId = text(v, 'page');
  try {
    await updateGroup(await mctx(c), c.req.param('gid'), { name: text(v, 'name') });
    return done(c, 'Group renamed.', back(c, pageId));
  } catch (e) {
    return failed(c, e, back(c, pageId), async () => c.redirect(back(c, pageId)));
  }
});

app.post('/groups/:gid/delete', async (c) => {
  const v = await readForm(c);
  await deleteGroup(await mctx(c), c.req.param('gid'));
  return done(c, 'Group deleted. Its components stay on the page.', back(c, text(v, 'page')));
});

app.post('/pages/:id/move', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  const ctx = await mctx(c);
  const parts = await pageParts(ctx, id);
  const kind = text(v, 'kind') === 'group' ? 'groups' : 'components';
  const order = (kind === 'groups' ? parts.groups : parts.components).map((x) => x.id);
  const at = order.indexOf(text(v, 'id'));
  const to = text(v, 'dir') === 'up' ? at - 1 : at + 1;
  if (at >= 0 && to >= 0 && to < order.length) {
    const moved = order.splice(at, 1)[0] as string;
    order.splice(to, 0, moved);
    await reorder(ctx, id, { [kind]: order });
  }
  return c.redirect(back(c, id));
});

/* ---- settings and look */

function SettingsTab({ page, v, errors }: { page: PageRow; v: Values; errors: Errors }) {
  const val = (k: string, f: string) => ({ [k]: text(v, k, f) });
  return (
    <>
    <form method="post" action={`${BASE}/pages/${page.id}/settings`} class="stack" novalidate>
      <Problems errors={errors} shown={['title', 'slug', 'description', 'websiteUrl', 'uptimeDays']} />
      <Card title="Basics" ruled>
        <div class="stack">
          <TextField id="title" label="Title" v={val('title', page.title)} errors={errors} maxlength={100} />
          <TextField id="slug" label="Address" v={val('slug', page.slug)} errors={errors} hint="Your page lives at /status/ followed by this." />
          <AreaField id="description" label="Description" v={val('description', page.description ?? '')} errors={errors} optional rows={2} hint="Shown under the title." />
          <TextField id="websiteUrl" label="Link back to your site" v={val('websiteUrl', page.website_url ?? '')} errors={errors} optional inputmode="url" placeholder="https://example.com" />
          <Field id="uptimeDays" label="Days of history shown" error={errors.uptimeDays}>
            <Select id="uptimeDays" name="uptimeDays" value={text(v, 'uptimeDays', String(page.uptime_days))} options={[{ value: '30', label: '30 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }]} />
          </Field>
        </div>
      </Card>
      <Card title="Who can see it" ruled>
        <div class="stack">
          <Toggle name="published" label="Public" description="Off makes the page return “not found” for everyone." checked={on(v, 'published', page.published === 1)} />
          <Toggle name="allowSubscribe" label="Let visitors subscribe by email" description="We confirm each address before sending anything." checked={on(v, 'allowSubscribe', page.allow_subscribe === 1)} />
          <Toggle name="hideFromSearch" label="Ask search engines to skip it" checked={on(v, 'hideFromSearch', page.hide_from_search === 1)} />
        </div>
      </Card>
      <div class="row">
        <Button type="submit" variant="primary">
          Save settings
        </Button>
      </div>
    </form>
      <form method="post" action={`${BASE}/pages/${page.id}/delete`}>
        <ConfirmButton id={`delete-${page.id}`} title={`Delete ${page.title}?`} body="The page, its components and its subscribers are deleted. Monitors are kept. This can’t be undone." confirmLabel="Delete page" icon="trash">
          Delete status page
        </ConfirmButton>
      </form>
    </>
  );
}

app.post('/pages/:id/settings', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  const ctx = await mctx(c);
  try {
    const p = await updatePage(ctx, id, {
      title: text(v, 'title'),
      slug: text(v, 'slug'),
      description: text(v, 'description'),
      websiteUrl: text(v, 'websiteUrl'),
      uptimeDays: text(v, 'uptimeDays'),
      published: on(v, 'published'),
      allowSubscribe: on(v, 'allowSubscribe'),
      hideFromSearch: on(v, 'hideFromSearch'),
    });
    await record(c, 'monitor.page_updated', 'page', p.id, `Updated status page ${p.title}`);
    return done(c, 'Settings saved.', back(c, id, 'settings'));
  } catch (e) {
    return failed(c, e, back(c, id, 'settings'), (errors) => screen(c, id, 'settings', { v, errors, status: 422 }));
  }
});

function LookTab({ page, v, errors }: { page: PageRow; v: Values; errors: Errors }) {
  return (
    <form method="post" action={`${BASE}/pages/${page.id}/look`} class="stack" novalidate>
      <Problems errors={errors} shown={['customCss']} />
      <Card title="Custom CSS" description="Style the public page your way. We keep only safe rules: no scripts, no outside files." ruled>
        <AreaField id="customCss" label="CSS" v={{ customCss: text(v, 'customCss', page.custom_css ?? '') }} errors={errors} optional rows={12} mono placeholder={':root { --st-ok: #0a7d5a; }\n.st-head h1 { letter-spacing: 0; }'} hint="Up to 20,000 characters. The status colours --st-ok, --st-warn and --st-down can be changed, and so can the page colours --bg, --fg and --ac." />
      </Card>
      <div class="row">
        <Button type="submit" variant="primary">
          Save style
        </Button>
        {page.published ? (
          <LinkButton href={`/status/${page.slug}`} icon="external">
            View page
          </LinkButton>
        ) : null}
      </div>
    </form>
  );
}

app.post('/pages/:id/look', async (c) => {
  const id = c.req.param('id');
  const v = await readForm(c);
  try {
    const p = await updatePage(await mctx(c), id, { customCss: text(v, 'customCss') });
    await record(c, 'monitor.page_updated', 'page', p.id, `Changed the style of ${p.title}`);
    return done(c, 'Style saved. It can take a couple of minutes to show on the public page.', back(c, id, 'look'));
  } catch (e) {
    return failed(c, e, back(c, id, 'look'), (errors) => screen(c, id, 'look', { v, errors, status: 422 }));
  }
});

app.post('/pages/:id/delete', async (c) => {
  const ctx = await mctx(c);
  const p = await getPage(ctx, c.req.param('id'));
  await deletePage(ctx, p.id);
  await record(c, 'monitor.page_deleted', 'page', p.id, `Deleted status page ${p.title}`);
  return done(c, `${p.title} was deleted.`, `${BASE}/pages`);
});

/* ---- subscribers */

function SubscribersTab({ page, subs, counts }: { page: PageRow; subs: Awaited<ReturnType<typeof listSubscribers>>; counts: { confirmed: number; pending: number } }) {
  return (
    <Card title="Subscribers" description={`${formatNumber(counts.confirmed)} confirmed, ${formatNumber(counts.pending)} waiting to confirm.`} flush>
      <Table
        caption="Subscribers"
        columns={[
          { key: 'email', label: 'Email' },
          { key: 'status', label: 'Status' },
          { key: 'since', label: 'Joined', hideOnMobile: true },
          { key: 'actions', label: 'Actions', numeric: true },
        ]}
        rows={subs.map((s) => ({
          email: <span class="trunc">{s.email}</span>,
          status: s.status === 'confirmed' ? <Pill tone="good">Confirmed</Pill> : s.status === 'pending' ? <Pill tone="warn">Waiting</Pill> : <Pill>Unsubscribed</Pill>,
          since: formatDateTime(s.created_at),
          actions: (
            <form method="post" action={`${BASE}/subscribers/${s.id}/delete`}>
              <input type="hidden" name="page" value={page.id} />
              <Button type="submit" size="sm" variant="danger">
                Remove
              </Button>
            </form>
          ),
        }))}
        empty={<EmptyState bare icon="mail" title="No subscribers yet" body={page.allow_subscribe ? 'Visitors can subscribe from your public page. We email them when something changes.' : 'Subscriptions are off. Turn them on under Settings.'} />}
      />
    </Card>
  );
}

app.post('/subscribers/:sid/delete', async (c) => {
  const v = await readForm(c);
  await removeSubscriber(await mctx(c), c.req.param('sid'));
  await record(c, 'monitor.subscriber_removed', 'subscriber', c.req.param('sid'), 'Removed a status page subscriber');
  return done(c, 'Subscriber removed.', back(c, text(v, 'page'), 'subscribers'));
});

/* ---- share */

function ShareTab({ page, base }: { page: PageRow; base: string }) {
  const root = `${base}/status/${page.slug}`;
  return (
    <div class="stack">
      {!page.published ? (
        <Callout tone="warn" title="This page is a draft">
          The links below return “not found” until you make the page public under Settings.
        </Callout>
      ) : null}
      <Card title="Links" ruled>
        <div class="stack">
          <div>
            <p class="lbl">Page</p>
            <CopyField label="page address" value={root} />
          </div>
          <div>
            <p class="lbl">RSS feed</p>
            <CopyField label="RSS address" value={`${root}/feed.rss`} />
          </div>
          <div>
            <p class="lbl">Atom feed</p>
            <CopyField label="Atom address" value={`${root}/feed.atom`} />
          </div>
          <div>
            <p class="lbl">JSON</p>
            <CopyField label="JSON address" value={`${root}/status.json`} />
          </div>
        </div>
      </Card>
      <Card title="Status badge" description="A small image that shows the current state. Put it in a README or a footer." ruled>
        <div class="stack">
          <img class="mon-badge" src={`/status/${page.slug}/badge.svg`} alt={`${page.title} status`} width="140" height="20" />
          <CodeBlock label="badge Markdown" code={`[![Status](${root}/badge.svg)](${root})`} />
          <CodeBlock label="badge HTML" code={`<a href="${root}"><img src="${root}/badge.svg" alt="Status"></a>`} />
        </div>
      </Card>
      <Card title="Website widget" description="A small pill that says whether you are up, and links to this page. It loads one script, no tracking." ruled>
        <CodeBlock label="widget snippet" code={`<script src="${base}/m/monitor/widget.js" data-status-page="${root}" defer></script>`} />
      </Card>
    </div>
  );
}

export default app;
