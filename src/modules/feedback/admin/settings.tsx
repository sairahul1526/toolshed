/** Admin: settings (general, boards, statuses, tags, people, widget, import and export) and stats. */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { needRole } from '../../../core/guards';
import type { AppEnv } from '../../../env';
import {
  BarChart, Button, Callout, Card, Checkbox, CodeBlock, ConfirmButton, CopyField, EmptyState, Field, FilterBar, Input, KeyValueList, LineChart, LinkButton, PageHeader, Pill, SearchInput, Section, Select, Stat, StatGrid,
  Table, Tabs, Textarea, renderPage, formatNumber, plural, timeAgo,
} from '../../../ui';
import { fbErrors } from '../errors';
import { IMPORT_FIELDS, IMPORT_ROW_LIMIT, exportAll, importPosts, postsCsv, previewCsv, type ImportField, type Mapping } from '../exportimport';
import { codesAvailable, listPeople, setBlocked, setTrusted } from '../people';
import {
  PRESETS, createBoard, createCategory, createStatus, createTag, deleteBoard, deleteCategory, deleteStatus, deleteTag, listBoards, listCategories, listStatuses, listTags, moveStatus, updateBoard, updatePortal, updateStatus, updateTag,
} from '../portal';
import { errorText } from '../pub/kit';
import { computeStats, formatDuration } from '../stats';
import { A, done, fail, flag, loadAdmin, str, tone } from './common';

export const settings = new Hono<AppEnv>();

const S = `${A}/settings`;
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'boards', label: 'Boards' },
  { id: 'statuses', label: 'Statuses' },
  { id: 'tags', label: 'Tags' },
  { id: 'people', label: 'People' },
  { id: 'widget', label: 'Widget' },
  { id: 'import-export', label: 'Import and export' },
] as const;
type Tab = (typeof TABS)[number]['id'];

interface Opts {
  error?: string;
  fields?: Record<string, string>;
  values?: Record<string, string>;
  status?: 422;
}

async function page(c: Context<AppEnv>, tab: Tab, o: Opts = {}) {
  const a = await loadAdmin(c);
  if (!a.portal) return c.redirect(A);
  const { ctx, portal } = a;
  const origin = new URL(c.req.url).origin;
  const f = o.fields ?? {};
  const v = o.values ?? {};
  const val = (k: keyof typeof portal, fallback = '') => (v[k as string] !== undefined ? v[k as string]! : String(portal[k] ?? fallback));
  const on = (k: keyof typeof portal) => (v[k as string] !== undefined ? v[k as string] === 'on' : Number(portal[k]) === 1);
  let body;

  if (tab === 'general') {
    const mail = await codesAvailable(c.env);
    body = (
      <form method="post" action={`${S}/general`} class="stack" data-busy-form>
        {!mail ? (
          <Callout tone="warn" title="Email is not set up">
            Sign-in codes, status emails and changelog emails cannot be sent. Until email works, guest posts and votes are accepted as unverified and held for your approval. People can still follow the RSS feed.
          </Callout>
        ) : (
          <Callout tone="good" title="Email is ready">People can verify with a six-digit code, and status emails go out.</Callout>
        )}
        <Card title="Portal">
          <Field id="g-name" label="Name" error={f.name}>
            <Input id="g-name" name="name" required maxlength={60} value={val('name')} invalid={Boolean(f.name)} />
          </Field>
          <Field id="g-slug" label="Address" error={f.slug} hint={`${origin}/feedback/${val('slug')}. Changing it breaks old links.`}>
            <Input id="g-slug" name="slug" maxlength={40} value={val('slug')} prefix="/feedback/" invalid={Boolean(f.slug)} />
          </Field>
          <Field id="g-tag" label="Tagline" optional error={f.tagline}>
            <Input id="g-tag" name="tagline" maxlength={160} value={val('tagline')} invalid={Boolean(f.tagline)} />
          </Field>
        </Card>
        <Card title="Look" description="Themes are plain. Nothing forces our name on your page.">
          <Field id="g-theme" label="Theme" error={f.theme}>
            <Select id="g-theme" name="theme" value={val('theme')} options={PRESETS.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} />
          </Field>
          <Field id="g-accent" label="Accent color" optional error={f.accent} hint="A hex color like #3f6212. Leave empty for the theme default.">
            <Input id="g-accent" name="accent" maxlength={7} value={val('accent')} placeholder="#3f6212" invalid={Boolean(f.accent)} />
          </Field>
          <Checkbox name="show_powered" label="Show a small link to Toolshed in the footer" description="Off by default. You are never required to show it." checked={on('show_powered')} />
        </Card>
        <Card title="Visibility and voting">
          <Field id="g-limit" label="Votes per person" error={f.vote_limit} hint="0 means no limit.">
            <Input id="g-limit" name="vote_limit" type="number" min={0} max={1000} value={val('vote_limit')} invalid={Boolean(f.vote_limit)} />
          </Field>
          <Field id="g-sort" label="Default sort">
            <Select id="g-sort" name="default_sort" value={val('default_sort')} options={[{ value: 'top', label: 'Top' }, { value: 'trending', label: 'Trending' }, { value: 'new', label: 'New' }]} />
          </Field>
          <Checkbox name="allow_anonymous" label="Allow guest posts and votes" description="Guests are held for approval unless they confirm an email." checked={on('allow_anonymous')} />
          <Checkbox name="hide_last_names" label="Show first names only" checked={on('hide_last_names')} />
          <Checkbox name="roadmap_on" label="Public roadmap" checked={on('roadmap_on')} />
          <Checkbox name="changelog_on" label="Public changelog" checked={on('changelog_on')} />
        </Card>
        <Card title="Email">
          <Field id="g-reply" label="Reply-to address" optional error={f.reply_to} hint="Where replies to status emails go.">
            <Input id="g-reply" name="reply_to" type="email" maxlength={254} value={val('reply_to')} invalid={Boolean(f.reply_to)} />
          </Field>
          <Field id="g-digest" label="Weekly digest recipients" optional error={f.digest_emails} hint="Admins who get a weekly list of posts with no reply. Separate addresses with commas.">
            <Textarea id="g-digest" name="digest_emails" rows={2} maxlength={1000} value={val('digest_emails')} invalid={Boolean(f.digest_emails)} />
          </Field>
        </Card>
        <div>
          <Button type="submit" variant="primary">
            Save settings
          </Button>
        </div>
      </form>
    );
  } else if (tab === 'boards') {
    const [boards, cats] = await Promise.all([listBoards(ctx), listCategories(ctx)]);
    body = (
      <div class="stack">
        {boards.map((b) => (
          <Card title={b.name} description={`/feedback/${portal.slug}?board=${b.slug}`}>
            <form method="post" action={`${S}/boards/${b.id}`} class="stack">
              <Field id={`b-n-${b.id}`} label="Name">
                <Input id={`b-n-${b.id}`} name="name" required maxlength={60} value={b.name} />
              </Field>
              <Field id={`b-d-${b.id}`} label="Description" optional>
                <Input id={`b-d-${b.id}`} name="description" maxlength={240} value={b.description} />
              </Field>
              <Field id={`b-v-${b.id}`} label="Who can see it">
                <Select id={`b-v-${b.id}`} name="visibility" value={b.visibility} options={[{ value: 'public', label: 'Everyone' }, { value: 'private', label: 'Only people signed in with your SSO' }]} />
              </Field>
              <Checkbox name="posting_on" label="Visitors can post" checked={b.posting_on === 1} />
              <Checkbox name="voting_on" label="Visitors can vote" checked={b.voting_on === 1} />
              <Checkbox name="hide_votes" label="Hide vote counts" checked={b.hide_votes === 1} />
              <Checkbox name="moderate" label="Review posts before they appear" checked={b.moderate === 1} />
              <div class="row">
                <Button type="submit">Save board</Button>
              </div>
            </form>
            <Section title="Categories" description="Visitors pick one when they post.">
              <ul class="fb-admin-list">
                {cats.filter((k) => k.board_id === b.id).map((k) => (
                  <li class="row">
                    <span>{k.name}</span>
                    <form method="post" action={`${S}/categories/${k.id}/delete`}>
                      <Button size="sm" variant="ghost" type="submit">
                        Remove
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
              <form method="post" action={`${S}/boards/${b.id}/categories`} class="row">
                <Input id={`c-${b.id}`} name="name" aria-label="New category" maxlength={40} placeholder="New category" required />
                <Button type="submit" size="sm">
                  Add
                </Button>
              </form>
            </Section>
            {boards.length > 1 ? (
              <form method="post" action={`${S}/boards/${b.id}/delete`}>
                <ConfirmButton id={`db-${b.id}`} variant="danger" title="Delete this board" body="The board and every post on it will be removed. This cannot be undone." confirmLabel="Delete board">
                  Delete board
                </ConfirmButton>
              </form>
            ) : null}
          </Card>
        ))}
        <Card title="Add a board">
          <form method="post" action={`${S}/boards`} class="stack">
            <Field id="nb-name" label="Name" error={f.name}>
              <Input id="nb-name" name="name" required maxlength={60} value={v.name ?? ''} invalid={Boolean(f.name)} />
            </Field>
            <div>
              <Button type="submit" variant="primary">
                Add board
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  } else if (tab === 'statuses') {
    const sts = await listStatuses(ctx);
    body = (
      <div class="stack">
        <Card flush title="Statuses" description="Order here is the order on the roadmap. A status with Show in roadmap on becomes a lane.">
          <Table
            caption="Statuses"
            columns={[
              { key: 'name', label: 'Status' },
              { key: 'kind', label: 'Meaning', hideOnMobile: true },
              { key: 'road', label: 'Roadmap' },
              { key: 'act', label: 'Actions', srOnly: true },
            ]}
            rows={sts.map((s, i) => ({
              name: (
                <form method="post" action={`${S}/statuses/${s.id}`} class="row">
                  <Input id={`sn-${s.id}`} name="name" aria-label="Name" value={s.name} maxlength={30} required />
                  <Select id={`st-${s.id}`} name="tone" aria-label="Color" value={s.tone} options={['neutral', 'good', 'warn', 'bad', 'solid'].map((t) => ({ value: t, label: t }))} />
                  <Select id={`sk-${s.id}`} name="kind" aria-label="Meaning" value={s.kind} options={[{ value: 'open', label: 'Open' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }, { value: 'closed', label: 'Closed' }]} />
                  <Checkbox name="in_roadmap" label="Roadmap" checked={s.in_roadmap === 1} />
                  <Button size="sm" type="submit">
                    Save
                  </Button>
                </form>
              ),
              kind: <Pill tone={tone(s.tone)}>{s.name}</Pill>,
              road: s.in_roadmap ? 'Yes' : 'No',
              act: (
                <form method="post" class="row">
                  <Button size="sm" variant="ghost" type="submit" formAction={`${S}/statuses/${s.id}/up`} disabled={i === 0} aria-label={`Move ${s.name} up`}>
                    Up
                  </Button>
                  <Button size="sm" variant="ghost" type="submit" formAction={`${S}/statuses/${s.id}/down`} disabled={i === sts.length - 1} aria-label={`Move ${s.name} down`}>
                    Down
                  </Button>
                  <ConfirmButton id={`ds-${s.id}`} size="sm" variant="ghost" title="Delete this status" body="You can only delete a status no post uses." confirmLabel="Delete" formAction={`${S}/statuses/${s.id}/delete`}>
                    Delete
                  </ConfirmButton>
                </form>
              ),
            }))}
          />
        </Card>
        <Card title="Add a status">
          <form method="post" action={`${S}/statuses`} class="stack">
            <Field id="ns-name" label="Name" error={f.name}>
              <Input id="ns-name" name="name" required maxlength={30} value={v.name ?? ''} invalid={Boolean(f.name)} />
            </Field>
            <Field id="ns-kind" label="Meaning" hint="Done statuses count as shipped. Closed ones ask for a reason.">
              <Select id="ns-kind" name="kind" value="open" options={[{ value: 'open', label: 'Open' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }, { value: 'closed', label: 'Closed' }]} />
            </Field>
            <Checkbox name="in_roadmap" label="Show in roadmap" />
            <div>
              <Button type="submit" variant="primary">
                Add status
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  } else if (tab === 'tags') {
    const tags = await listTags(ctx);
    body = (
      <div class="stack">
        <Card flush title="Tags" description="Public tags show on posts. Internal tags are for your team.">
          <Table
            caption="Tags"
            columns={[{ key: 'name', label: 'Tag' }, { key: 'act', label: 'Actions', srOnly: true }]}
            rows={tags.map((t) => ({
              name: (
                <form method="post" action={`${S}/tags/${t.id}`} class="row">
                  <Input id={`tn-${t.id}`} name="name" aria-label="Name" value={t.name} maxlength={30} required />
                  <Checkbox name="is_public" label="Public" checked={t.is_public === 1} />
                  <Button size="sm" type="submit">
                    Save
                  </Button>
                </form>
              ),
              act: (
                <form method="post" action={`${S}/tags/${t.id}/delete`}>
                  <ConfirmButton id={`dt-${t.id}`} size="sm" variant="ghost" title="Delete this tag" body="It is removed from every post." confirmLabel="Delete tag">
                    Delete
                  </ConfirmButton>
                </form>
              ),
            }))}
            empty={<EmptyState bare icon="list" title="No tags yet" body="Add tags to group posts, like Billing or Mobile." />}
          />
        </Card>
        <Card title="Add a tag">
          <form method="post" action={`${S}/tags`} class="stack">
            <Field id="nt-name" label="Name" error={f.name}>
              <Input id="nt-name" name="name" required maxlength={30} value={v.name ?? ''} invalid={Boolean(f.name)} />
            </Field>
            <Checkbox name="is_public" label="Show on public pages" checked />
            <div>
              <Button type="submit" variant="primary">
                Add tag
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  } else if (tab === 'people') {
    const q = (c.req.query('q') ?? '').slice(0, 80);
    const filter = ['blocked', 'trusted', 'guest'].includes(c.req.query('filter') ?? '') ? (c.req.query('filter') as 'blocked' | 'trusted' | 'guest') : undefined;
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const rows = await listPeople(ctx, { q, filter, limit: 51, offset });
    const shown = rows.slice(0, 50);
    body = (
      <>
        <FilterBar action={`${S}/people`}>
          <SearchInput name="q" label="Search people" value={q} placeholder="Name or email" />
          <Select id="p-f" name="filter" aria-label="Filter" value={filter ?? ''} options={[{ value: '', label: 'Everyone' }, { value: 'blocked', label: 'Blocked' }, { value: 'trusted', label: 'Trusted' }, { value: 'guest', label: 'Guests' }]} />
        </FilterBar>
        <Card flush>
          <Table
            caption="People"
            columns={[{ key: 'who', label: 'Person' }, { key: 'state', label: 'State' }, { key: 'seen', label: 'Last seen', hideOnMobile: true }, { key: 'act', label: 'Actions', srOnly: true }]}
            rows={shown.map((p) => ({
              who: (
                <div>
                  <strong>{p.name || p.email || 'A guest'}</strong>
                  <div class="hint">{p.email ?? 'No email'}</div>
                </div>
              ),
              state: (
                <span class="row">
                  {p.verified ? <Pill tone="good">Verified</Pill> : <Pill>Unverified</Pill>}
                  {p.trusted ? <Pill tone="solid">Trusted</Pill> : null}
                  {p.blocked ? <Pill tone="bad">Blocked</Pill> : null}
                </span>
              ),
              seen: timeAgo(p.last_seen_at),
              act: (
                <form method="post" class="row">
                  <Button size="sm" type="submit" formAction={`${S}/people/${p.id}/${p.trusted ? 'untrust' : 'trust'}`}>
                    {p.trusted ? 'Remove trust' : 'Trust'}
                  </Button>
                  <Button size="sm" variant={p.blocked ? 'default' : 'danger'} type="submit" formAction={`${S}/people/${p.id}/${p.blocked ? 'unblock' : 'block'}`}>
                    {p.blocked ? 'Unblock' : 'Block'}
                  </Button>
                </form>
              ),
            }))}
            empty={<EmptyState bare icon="users" title="No people yet" body="People show up here after they post, vote or comment." />}
          />
        </Card>
        <p class="row">
          {offset > 0 ? <LinkButton href={`${S}/people?q=${encodeURIComponent(q)}&filter=${filter ?? ''}&offset=${Math.max(0, offset - 50)}`}>Previous</LinkButton> : null}
          {rows.length > 50 ? <LinkButton href={`${S}/people?q=${encodeURIComponent(q)}&filter=${filter ?? ''}&offset=${offset + 50}`}>Next</LinkButton> : null}
        </p>
        <p class="hint">Trusted people skip the link limit and moderation. Blocked people cannot post, vote or comment.</p>
      </>
    );
  } else if (tab === 'widget') {
    const snippet = `<script src="${origin}/m/feedback/widget.js" data-portal="${portal.slug}" defer></script>`;
    const log = `<script src="${origin}/m/feedback/widget.js" data-portal="${portal.slug}" data-mode="changelog" defer></script>`;
    body = (
      <div class="stack">
        {portal.widget_seen_at ? (
          <Callout tone="good" title="Widget connected">Last seen {timeAgo(portal.widget_seen_at)} on {portal.widget_host}.</Callout>
        ) : (
          <Callout tone="info" title="Not seen yet">Add the code to your site and load a page. This message turns green after the first view.</Callout>
        )}
        <Card title="Feedback button" description="A floating button that opens your portal in a panel. It loads one small file and never touches your page styles.">
          <CodeBlock label="Paste before the closing body tag" code={snippet} copy />
          <KeyValueList
            items={[
              { label: 'data-label', value: 'Button text. Default Feedback.' },
              { label: 'data-position', value: 'right or left.' },
              { label: 'data-target', value: 'A CSS selector. The widget opens from your own element instead.' },
              { label: 'data-sso', value: 'A signed token that identifies the signed-in customer.' },
            ]}
          />
        </Card>
        <Card title="Changelog popover" description="A button with a dot that shows when there is something new.">
          <CodeBlock label="Paste instead, or as well" code={log} copy />
        </Card>
        <Card title="Direct links">
          <CopyField label="Portal" value={`${origin}/feedback/${portal.slug}`} secret={false} />
          <CopyField label="Roadmap" value={`${origin}/roadmap/${portal.slug}`} secret={false} />
          <CopyField label="Changelog" value={`${origin}/changelog/${portal.slug}`} secret={false} />
          <CopyField label="RSS feed" value={`${origin}/changelog/${portal.slug}/feed.rss`} secret={false} />
        </Card>
      </div>
    );
  } else {
    body = (
      <div class="stack">
        <Card title="Export" description="Everything in this workspace, as files you keep.">
          <div class="row">
            <LinkButton href={`${A}/export.csv`} icon="download">
              Posts as CSV
            </LinkButton>
            <LinkButton href={`${A}/export.json`} icon="download">
              Everything as JSON
            </LinkButton>
          </div>
        </Card>
        <Card title="Import from a CSV" description="Works with a Canny export or any file with a title column. You map the columns on the next step. Imported people are never emailed.">
          {o.error ? <Callout tone="bad" title="That file did not work">{o.error}</Callout> : null}
          <form method="post" action={`${A}/import`} enctype="multipart/form-data" class="stack" data-busy-form>
            <Field id="imp-file" label="CSV file" hint="Up to 2 MB. The first row must be column names.">
              <input id="imp-file" type="file" name="file" accept=".csv,text/csv" required />
            </Field>
            <div>
              <Button type="submit" variant="primary">
                Read the file
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  return renderPage(c, { title: 'Settings', status: o.status, crumbs: [{ label: 'Feedback', href: A }, { label: 'Settings' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader title="Settings" description="Portal, boards, statuses, people and the widget." />
      {o.error && tab !== 'import-export' ? <Callout tone="bad" title="That did not save">{o.error}</Callout> : null}
      <Tabs label="Settings" items={TABS.map((t) => ({ id: t.id, label: t.label, href: `${S}/${t.id}` }))} active={tab} />
      {body}
    </>
  ));
}

settings.get('/settings', (c) => c.redirect(`${S}/general`));
settings.get('/settings/:tab', (c) => {
  const tab = TABS.find((t) => t.id === c.req.param('tab'));
  if (!tab) throw fbErrors.portal_missing();
  return page(c, tab.id);
});

async function guard(c: Context<AppEnv>) {
  needRole(c, 'admin');
  return (await loadAdmin(c)).ctx;
}

settings.post('/settings/general', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  const keys = ['name', 'slug', 'tagline', 'theme', 'accent', 'vote_limit', 'default_sort', 'reply_to', 'digest_emails'];
  const bools = ['show_powered', 'allow_anonymous', 'hide_last_names', 'roadmap_on', 'changelog_on'];
  const values: Record<string, string> = {};
  for (const k of keys) values[k] = str(b, k);
  for (const k of bools) values[k] = flag(b, k) ? 'on' : '';
  try {
    await updatePortal(ctx, { ...values, ...Object.fromEntries(bools.map((k) => [k, flag(b, k)])) } as never);
    return done(c, `${S}/general`, 'Settings saved.');
  } catch (e) {
    const t = errorText(e);
    return page(c, 'general', { error: t.message, fields: t.fields, values, status: 422 });
  }
});

settings.post('/settings/boards', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  try {
    await createBoard(ctx, { name: str(b, 'name') });
    return done(c, `${S}/boards`, 'Board added.');
  } catch (e) {
    const t = errorText(e);
    return page(c, 'boards', { error: t.message, fields: t.fields, values: { name: str(b, 'name') }, status: 422 });
  }
});

settings.post('/settings/boards/:id', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  try {
    await updateBoard(ctx, c.req.param('id'), {
      name: str(b, 'name'),
      description: str(b, 'description'),
      visibility: str(b, 'visibility') === 'private' ? 'private' : 'public',
      posting_on: flag(b, 'posting_on') ? 1 : 0,
      voting_on: flag(b, 'voting_on') ? 1 : 0,
      hide_votes: flag(b, 'hide_votes') ? 1 : 0,
      moderate: flag(b, 'moderate') ? 1 : 0,
    });
    return done(c, `${S}/boards`, 'Board saved.');
  } catch (e) {
    return fail(c, `${S}/boards`, e);
  }
});

settings.post('/settings/boards/:id/delete', async (c) => {
  const ctx = await guard(c);
  try {
    await deleteBoard(ctx, c.req.param('id'));
    return done(c, `${S}/boards`, 'Board deleted.');
  } catch (e) {
    return fail(c, `${S}/boards`, e);
  }
});

settings.post('/settings/boards/:id/categories', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  try {
    await createCategory(ctx, c.req.param('id'), str(b, 'name'));
    return done(c, `${S}/boards`, 'Category added.');
  } catch (e) {
    return fail(c, `${S}/boards`, e);
  }
});

settings.post('/settings/categories/:id/delete', async (c) => {
  const ctx = await guard(c);
  try {
    await deleteCategory(ctx, c.req.param('id'));
    return done(c, `${S}/boards`, 'Category removed.');
  } catch (e) {
    return fail(c, `${S}/boards`, e);
  }
});

settings.post('/settings/statuses', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  const kind = (['open', 'active', 'done', 'closed'].includes(str(b, 'kind')) ? str(b, 'kind') : 'open') as 'open';
  try {
    await createStatus(ctx, { name: str(b, 'name'), kind, in_roadmap: flag(b, 'in_roadmap') ? 1 : 0 });
    return done(c, `${S}/statuses`, 'Status added.');
  } catch (e) {
    const t = errorText(e);
    return page(c, 'statuses', { error: t.message, fields: t.fields, values: { name: str(b, 'name') }, status: 422 });
  }
});

settings.post('/settings/statuses/:id', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  const kind = (['open', 'active', 'done', 'closed'].includes(str(b, 'kind')) ? str(b, 'kind') : 'open') as 'open';
  const t = (['neutral', 'good', 'warn', 'bad', 'solid'].includes(str(b, 'tone')) ? str(b, 'tone') : 'neutral') as 'neutral';
  try {
    await updateStatus(ctx, c.req.param('id'), { name: str(b, 'name'), kind, tone: t, in_roadmap: flag(b, 'in_roadmap') ? 1 : 0 });
    return done(c, `${S}/statuses`, 'Status saved.');
  } catch (e) {
    return fail(c, `${S}/statuses`, e);
  }
});

for (const dir of ['up', 'down'] as const) {
  settings.post(`/settings/statuses/:id/${dir}`, async (c) => {
    const ctx = await guard(c);
    await moveStatus(ctx, c.req.param('id'), dir);
    return c.redirect(`${S}/statuses`);
  });
}

settings.post('/settings/statuses/:id/delete', async (c) => {
  const ctx = await guard(c);
  try {
    await deleteStatus(ctx, c.req.param('id'));
    return done(c, `${S}/statuses`, 'Status deleted.');
  } catch (e) {
    return fail(c, `${S}/statuses`, e);
  }
});

settings.post('/settings/tags', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  try {
    await createTag(ctx, { name: str(b, 'name'), is_public: flag(b, 'is_public') });
    return done(c, `${S}/tags`, 'Tag added.');
  } catch (e) {
    const t = errorText(e);
    return page(c, 'tags', { error: t.message, fields: t.fields, values: { name: str(b, 'name') }, status: 422 });
  }
});

settings.post('/settings/tags/:id', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  try {
    await updateTag(ctx, c.req.param('id'), { name: str(b, 'name'), is_public: flag(b, 'is_public') });
    return done(c, `${S}/tags`, 'Tag saved.');
  } catch (e) {
    return fail(c, `${S}/tags`, e);
  }
});

settings.post('/settings/tags/:id/delete', async (c) => {
  const ctx = await guard(c);
  await deleteTag(ctx, c.req.param('id'));
  return done(c, `${S}/tags`, 'Tag deleted.');
});

for (const act of ['block', 'unblock', 'trust', 'untrust'] as const) {
  settings.post(`/settings/people/:id/${act}`, async (c) => {
    const ctx = await guard(c);
    const id = c.req.param('id');
    try {
      if (act === 'block') await setBlocked(ctx, id, true);
      else if (act === 'unblock') await setBlocked(ctx, id, false);
      else await setTrusted(ctx, id, act === 'trust');
      return done(c, `${S}/people`, act === 'block' ? 'Person blocked.' : act === 'unblock' ? 'Person unblocked.' : act === 'trust' ? 'Person trusted.' : 'Trust removed.');
    } catch (e) {
      return fail(c, `${S}/people`, e);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------------------------

settings.get('/export.csv', async (c) => {
  const { ctx } = await loadAdmin(c);
  return new Response(await postsCsv(ctx), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="feedback-posts.csv"', 'cache-control': 'no-store' } });
});

settings.get('/export.json', async (c) => {
  const { ctx } = await loadAdmin(c);
  return new Response(JSON.stringify(await exportAll(ctx), null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="feedback-export.json"', 'cache-control': 'no-store' } });
});

const FIELD_LABEL: Record<ImportField, string> = {
  title: 'Title',
  body: 'Details',
  author_name: 'Author name',
  author_email: 'Author email',
  votes: 'Vote count',
  status: 'Status',
  board: 'Board',
  category: 'Category',
  tags: 'Tags',
  created_at: 'Created date',
};

const MAX_CSV = 2 * 1024 * 1024;

settings.post('/import', async (c) => {
  needRole(c, 'admin');
  const b = await c.req.parseBody();
  const file = b.file;
  try {
    if (!(file instanceof File) || file.size === 0) throw fbErrors.import_invalid('Choose a CSV file first.');
    if (file.size > MAX_CSV) throw fbErrors.import_invalid('Keep the file under 2 MB.');
    const text = await file.text();
    const pv = previewCsv(text);
    if (pv.headers.length === 0 || pv.total === 0) throw fbErrors.import_invalid('That file has no rows.');
    return mappingPage(c, text, pv.headers, pv.rows, pv.total, pv.mapping, pv.truncated);
  } catch (e) {
    const t = errorText(e);
    return page(c, 'import-export', { error: t.message, status: 422 });
  }
});

function mappingPage(c: Context<AppEnv>, text: string, headers: string[], rows: string[][], total: number, mapping: Mapping, truncated: boolean, offset = 0) {
  const opts = [{ value: '', label: 'Not in the file' }, ...headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))];
  return renderPage(c, { title: 'Import', crumbs: [{ label: 'Feedback', href: A }, { label: 'Settings', href: `${S}/import-export` }, { label: 'Import' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader title="Match the columns" description={`${plural(total, 'row')} found. Rows import ${IMPORT_ROW_LIMIT} at a time, so you can stop and carry on later.`} />
      {truncated ? <Callout tone="warn" title="Large file">Only the first 5,000 rows are read.</Callout> : null}
      <Card title="Columns">
        <form method="post" action={`${A}/import/run`} class="stack" data-busy-form>
          <input type="hidden" name="offset" value={String(offset)} />
          <textarea name="csv" hidden>{text}</textarea>
          {IMPORT_FIELDS.map((f) => (
            <Field id={`m-${f}`} label={FIELD_LABEL[f]} hint={f === 'title' ? 'Required.' : undefined}>
              <Select id={`m-${f}`} name={`map_${f}`} value={mapping[f] === undefined ? '' : String(mapping[f])} options={opts} />
            </Field>
          ))}
          <div class="row">
            <Button type="submit" variant="primary">
              Import {Math.min(IMPORT_ROW_LIMIT, total - offset)} rows
            </Button>
            <LinkButton href={`${S}/import-export`} variant="ghost">
              Cancel
            </LinkButton>
          </div>
        </form>
      </Card>
      <Card flush title="First rows">
        <Table
          caption="First rows of the file"
          columns={headers.slice(0, 6).map((h, i) => ({ key: `c${i}`, label: h || `Column ${i + 1}` }))}
          rows={rows.map((r) => Object.fromEntries(headers.slice(0, 6).map((_, i) => [`c${i}`, (r[i] ?? '').slice(0, 80)])))}
        />
      </Card>
    </>
  ));
}

settings.post('/import/run', async (c) => {
  const ctx = await guard(c);
  const b = await c.req.parseBody();
  const text = str(b, 'csv');
  const offset = Math.max(0, Number(str(b, 'offset')) || 0);
  const mapping: Mapping = {};
  for (const f of IMPORT_FIELDS) {
    const raw = str(b, `map_${f}`);
    if (raw !== '' && /^\d+$/.test(raw)) mapping[f] = Number(raw);
  }
  try {
    const res = await importPosts(ctx, text, mapping, offset);
    const pv = previewCsv(text);
    return renderPage(c, { title: 'Import' , crumbs: [{ label: 'Feedback', href: A }, { label: 'Settings', href: `${S}/import-export` }, { label: 'Import' }] }, (
      <>
        <PageHeader title="Import progress" />
        <Callout tone="good" title={`${plural(res.imported, 'post')} imported`}>
          {res.skipped ? `${plural(res.skipped, 'row')} skipped. ` : ''}
          {res.notes.slice(0, 5).join(' ')}
        </Callout>
        {res.next !== null ? (
          <Card>
            <form method="post" action={`${A}/import/run`} class="stack" data-busy-form>
              <input type="hidden" name="offset" value={String(res.next)} />
              <textarea name="csv" hidden>{text}</textarea>
              {IMPORT_FIELDS.map((f) => (mapping[f] === undefined ? null : <input type="hidden" name={`map_${f}`} value={String(mapping[f])} />))}
              <p>{formatNumber(Math.max(0, pv.total - res.next))} rows left.</p>
              <div class="row">
                <Button type="submit" variant="primary">
                  Import the next batch
                </Button>
                <LinkButton href={A} variant="ghost">
                  Stop here
                </LinkButton>
              </div>
            </form>
          </Card>
        ) : (
          <LinkButton href={A} variant="primary">
            Go to the inbox
          </LinkButton>
        )}
      </>
    ));
  } catch (e) {
    const t = errorText(e);
    return page(c, 'import-export', { error: t.message, status: 422 });
  }
});

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

settings.get('/stats', async (c) => {
  const { ctx, portal } = await loadAdmin(c);
  if (!portal) return c.redirect(A);
  const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 30;
  const s = await computeStats(ctx, days);
  const empty = s.totals.posts + s.totals.votes + s.totals.comments === 0;
  return renderPage(c, { title: 'Stats', crumbs: [{ label: 'Feedback', href: A }, { label: 'Stats' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader
        title="Stats"
        description={`The last ${days} days.`}
        actions={
          <>
            {[7, 30, 90].map((d) => (
              <LinkButton href={`${A}/stats?days=${d}`} variant={d === days ? 'primary' : 'default'}>
                {d} days
              </LinkButton>
            ))}
          </>
        }
      />
      <StatGrid>
        <Stat label="New posts" value={formatNumber(s.totals.posts)} />
        <Stat label="Votes" value={formatNumber(s.totals.votes)} />
        <Stat label="Comments" value={formatNumber(s.totals.comments)} />
        <Stat label="Median first reply" value={formatDuration(s.firstReply.medianMs)} note={`${formatNumber(s.firstReply.unanswered)} waiting for a reply`} />
      </StatGrid>
      {empty ? (
        <EmptyState icon="chart" title="Nothing to chart yet" body="Numbers appear once people post, vote and comment." />
      ) : (
        <Card title="Activity by day">
          <LineChart
            title="Posts, votes and comments by day"
            labels={s.series.map((d) => d.day.slice(5))}
            series={[
              { label: 'Posts', values: s.series.map((d) => d.posts) },
              { label: 'Votes', values: s.series.map((d) => d.votes) },
              { label: 'Comments', values: s.series.map((d) => d.comments) },
            ]}
          />
        </Card>
      )}
      <Card flush title="Top posts">
        <Table
          caption="Top posts by votes"
          columns={[{ key: 't', label: 'Post' }, { key: 's', label: 'Status', hideOnMobile: true }, { key: 'v', label: 'Votes', numeric: true }, { key: 'c', label: 'Comments', numeric: true, hideOnMobile: true }]}
          rows={s.top.map((p) => ({ t: <a href={`${A}/posts/${p.id}`}>{p.title}</a>, s: p.status ?? '', v: formatNumber(p.votes), c: formatNumber(p.comments) }))}
          empty={<EmptyState bare icon="list" title="No posts yet" />}
        />
      </Card>
      <Card title="Posts by status">
        {s.flow.some((f) => f.count) ? <BarChart title="Posts by status" data={s.flow.map((f) => ({ label: f.name, value: f.count }))} unit="posts" /> : <p class="hint">No posts yet.</p>}
      </Card>
      <Card title="Status moves" description="How posts moved between statuses in this period.">
        {s.moves.length === 0 ? <p class="hint">No status changes in this period.</p> : null}
        <ul class="fb-admin-list">
          {s.moves.map((m) => (
            <li>
              {m.from} to {m.to}: {plural(m.count, 'post')}
            </li>
          ))}
        </ul>
      </Card>
    </>
  ));
});
