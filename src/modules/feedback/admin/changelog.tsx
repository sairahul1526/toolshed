/** Admin: changelog list and editor, image upload, subscribers. */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Context } from 'hono';
import { needRole } from '../../../core/guards';
import type { AppEnv } from '../../../env';
import {
  Button, Callout, Card, Checkbox, ConfirmButton, CopyField, EmptyState, Field, Input, LinkButton, PageHeader, Pill, Select, Table, Tabs, Textarea, renderPage, formatDate, formatNumber, plural, timeAgo,
} from '../../../ui';
import { IMAGE_MAX, LABELS, createEntry, deleteEntry, entryLabels, getEntry, linkedPostIds, listEntries, listSubscribers, publishEntry, removeSubscriber, saveImage, subscriberCounts, updateEntry } from '../changelog';
import { fbErrors } from '../errors';
import { renderVisitorMarkdown } from '../lib';
import { listPosts } from '../posts';
import { errorText } from '../pub/kit';
import { codesAvailable } from '../people';
import type { Entry } from '../types';
import { A, dateTimeLocal, done, fail, flag, loadAdmin, publicUrl, str } from './common';

export const changelogAdmin = new Hono<AppEnv>();

const C = `${A}/changelog`;
const STATES = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Drafts' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'published', label: 'Published' },
] as const;

function statePill(e: Entry) {
  return e.state === 'published' ? <Pill tone="good">Published</Pill> : e.state === 'scheduled' ? <Pill tone="warn">Scheduled {e.publish_at ? formatDate(e.publish_at) : ''}</Pill> : <Pill>Draft</Pill>;
}

changelogAdmin.get('/changelog', async (c) => {
  const { ctx, portal } = await loadAdmin(c);
  if (!portal) return c.redirect(A);
  const state = STATES.find((s) => s.id === c.req.query('state'))?.id ?? 'all';
  const page = await listEntries(ctx, { state, cursor: c.req.query('cursor'), limit: 25 });
  return renderPage(c, { title: 'Changelog', crumbs: [{ label: 'Feedback', href: A }, { label: 'Changelog' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader
        title="Changelog"
        description="Tell customers what shipped. Posts you link here are marked complete when you publish."
        actions={
          <>
            <LinkButton href={`${C}/new`} variant="primary" icon="plus">
              New entry
            </LinkButton>
            <LinkButton href={`${A}/subscribers`}>Subscribers</LinkButton>
            {portal.changelog_on ? (
              <LinkButton href={`/changelog/${portal.slug}`} icon="globe" target="_blank" rel="noopener">
                View public page
              </LinkButton>
            ) : null}
          </>
        }
      />
      {!portal.changelog_on ? <Callout tone="info" title="The public changelog is off">Turn it on in <a href={`${A}/settings`}>settings</a> when you are ready.</Callout> : null}
      <Tabs label="Entry state" items={STATES.map((s) => ({ id: s.id, label: s.label, href: `${C}?state=${s.id}` }))} active={state} />
      <Card flush>
        <Table
          caption="Changelog entries"
          columns={[
            { key: 'title', label: 'Entry' },
            { key: 'state', label: 'State' },
            { key: 'labels', label: 'Labels', hideOnMobile: true },
            { key: 'when', label: 'Updated', hideOnMobile: true },
          ]}
          rows={page.items.map((e) => ({
            title: <a href={`${C}/${e.id}`}><strong>{e.title}</strong></a>,
            state: statePill(e),
            labels: entryLabels(e).join(', '),
            when: timeAgo(e.updated_at),
          }))}
          empty={<EmptyState bare icon="news" title="No entries yet" body="Write your first update. Drafts stay private until you publish." actions={<LinkButton href={`${C}/new`} variant="primary">New entry</LinkButton>} />}
        />
      </Card>
      {page.nextCursor ? <p><LinkButton href={`${C}?state=${state}&cursor=${encodeURIComponent(page.nextCursor)}`}>Show more</LinkButton></p> : null}
    </>
  ));
});

interface EditorOpts {
  entry?: Entry | null;
  values?: Record<string, string>;
  fields?: Record<string, string>;
  error?: string;
  status?: 422;
}

async function editor(c: Context<AppEnv>, o: EditorOpts = {}) {
  const { ctx, portal } = await loadAdmin(c);
  if (!portal) return c.redirect(A);
  const e = o.entry ?? null;
  const v = o.values ?? {};
  const f = o.fields ?? {};
  const linked = e ? await linkedPostIds(ctx, e.id) : [];
  const picks = (await listPosts(ctx, { review: 'published', sort: 'top', limit: 40 })).items;
  const chosen = new Set(v.post_ids !== undefined ? v.post_ids.split(',').filter(Boolean) : linked);
  const labels = new Set(v.labels !== undefined ? v.labels.split(',') : e ? entryLabels(e) : []);
  const body = v.body ?? e?.body ?? '';
  const state = v.state ?? e?.state ?? 'draft';
  const img = c.req.query('img');
  const action = e ? `${C}/${e.id}` : `${C}/new`;
  const published = e?.state === 'published';
  return renderPage(c, { title: e ? e.title : 'New entry', status: o.status, crumbs: [{ label: 'Feedback', href: A }, { label: 'Changelog', href: C }, { label: e ? 'Edit entry' : 'New entry' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader title={e ? 'Edit entry' : 'New entry'} soft={e ? statePill(e) : undefined} description="Markdown works. Links and images are allowed. Raw HTML is not." />
      {o.error ? <Callout tone="bad" title="That did not save">{o.error}</Callout> : null}
      <div class="fb-admin-grid">
        <Card>
          <form method="post" action={action} class="stack" data-busy-form>
            <Field id="e-title" label="Title" error={f.title}>
              <Input id="e-title" name="title" required maxlength={120} value={v.title ?? e?.title ?? ''} invalid={Boolean(f.title)} />
            </Field>
            <Field id="e-body" label="Body" error={f.body} hint="Use headings, lists and links. Paste an image link from the uploader on this page.">
              <Textarea id="e-body" name="body" rows={14} maxlength={20000} value={body} invalid={Boolean(f.body)} />
            </Field>
            <fieldset class="fb-tags">
              <legend>Labels</legend>
              {LABELS.map((l) => (
                <Checkbox name="label" value={l} label={l} checked={labels.has(l)} />
              ))}
            </fieldset>
            <Field id="e-author" label="Author name" optional hint="Shown under the entry.">
              <Input id="e-author" name="author_name" maxlength={60} value={v.author_name ?? e?.author_name ?? ''} />
            </Field>
            {published ? null : (
              <>
                <Field id="e-state" label="When to publish" hint="Scheduled entries go live within a few minutes of the time you pick (UTC).">
                  <Select id="e-state" name="state" value={state} options={[{ value: 'draft', label: 'Keep as a draft' }, { value: 'scheduled', label: 'Schedule for later' }, { value: 'published', label: 'Publish now' }]} />
                </Field>
                <Field id="e-at" label="Publish time (UTC)" optional error={f.publish_at}>
                  <Input id="e-at" name="publish_at" type="datetime-local" value={v.publish_at ?? dateTimeLocal(e?.publish_at ?? null)} invalid={Boolean(f.publish_at)} />
                </Field>
              </>
            )}
            <fieldset class="fb-tags">
              <legend>Posts this ships</legend>
              {picks.length === 0 ? <p class="hint">No published posts yet.</p> : null}
              {picks.map((p) => (
                <Checkbox name="post" value={p.id} label={p.title} checked={chosen.has(p.id)} />
              ))}
            </fieldset>
            <Checkbox name="complete_posts" label="Mark linked posts complete when this is published" description="Voters are told, unless you turn that off per post." checked={v.complete_posts !== undefined ? v.complete_posts === 'on' : e ? e.complete_posts === 1 : true} />
            <div class="row">
              <Button type="submit" variant="primary">
                Save entry
              </Button>
              <LinkButton href={C} variant="ghost">
                Cancel
              </LinkButton>
            </div>
          </form>
        </Card>
        <div class="stack">
          <Card title="Preview">
            {body ? <div class="prose">{raw(renderVisitorMarkdown(body))}</div> : <p class="hint">Save to see the preview here.</p>}
          </Card>
          <Card title="Upload an image" description={`PNG, JPEG, GIF or WebP, up to ${Math.round(IMAGE_MAX / 1048576)} MB. Stored in your workspace, never on a third party.`}>
            {img ? <CopyField label="Paste this into the body" value={`![](${img})`} secret={false} /> : null}
            <form method="post" action={`${C}/images`} enctype="multipart/form-data" class="stack" data-busy-form>
              <input type="hidden" name="back" value={e ? e.id : 'new'} />
              <Field id="e-img" label="Image file">
                <input id="e-img" type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp" required />
              </Field>
              <div>
                <Button type="submit">Upload</Button>
              </div>
            </form>
          </Card>
          {e ? (
            <Card title="Actions">
              <div class="row">
                {e.state !== 'published' ? (
                  <form method="post" action={`${C}/${e.id}/publish`}>
                    <Button type="submit" variant="primary">
                      Publish now
                    </Button>
                  </form>
                ) : (
                  <LinkButton href={publicUrl(c, portal, '').replace('/feedback/', '/changelog/') + '/' + e.slug} target="_blank" rel="noopener">
                    View public entry
                  </LinkButton>
                )}
                <form method="post" action={`${C}/${e.id}/delete`}>
                  <ConfirmButton id="del-entry" variant="danger" title="Delete this entry" body="It is removed from the changelog and the feed. Posts it shipped stay complete." confirmLabel="Delete entry">
                    Delete
                  </ConfirmButton>
                </form>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  ));
}

changelogAdmin.get('/changelog/new', (c) => editor(c));

async function readEntryForm(c: Context<AppEnv>) {
  const b = await c.req.parseBody({ all: true });
  const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const many = (k: string) => (Array.isArray(b[k]) ? (b[k] as string[]) : typeof b[k] === 'string' ? [b[k] as string] : []);
  const at = one('publish_at');
  const when = at ? Date.parse(`${at}:00Z`.replace(/:00:00Z$/, ':00Z')) : NaN;
  const state = (['draft', 'scheduled', 'published'].includes(one('state')) ? one('state') : 'draft') as 'draft' | 'scheduled' | 'published';
  const values = { title: one('title'), body: one('body'), author_name: one('author_name'), state, publish_at: at, labels: many('label').join(','), post_ids: many('post').join(','), complete_posts: flag(b, 'complete_posts') ? 'on' : '' };
  return { values, when, state, labels: many('label'), posts: many('post'), complete: flag(b, 'complete_posts') };
}

changelogAdmin.post('/changelog/new', async (c) => {
  needRole(c, 'member');
  const { ctx } = await loadAdmin(c);
  const f = await readEntryForm(c);
  try {
    if (f.state === 'scheduled' && !Number.isFinite(f.when)) return editor(c, { values: f.values, fields: { publish_at: 'Pick a date and time.' }, error: 'Pick a date and time to schedule this.', status: 422 });
    const entry = await createEntry(ctx, { title: f.values.title, body: f.values.body, labels: f.labels, author_name: f.values.author_name, complete_posts: f.complete, publish_at: f.state === 'scheduled' ? f.when : null, state: f.state === 'published' ? 'draft' : f.state, post_ids: f.posts }, { name: c.get('user')?.name ?? 'The team' });
    if (f.state === 'published') await publishEntry(ctx, entry.id, { id: null, name: c.get('user')?.name ?? 'The team' });
    return done(c, `${C}/${entry.id}`, f.state === 'published' ? 'Entry published.' : 'Entry saved.');
  } catch (e) {
    const t = errorText(e);
    return editor(c, { values: f.values, fields: t.fields, error: t.message, status: 422 });
  }
});

changelogAdmin.get('/changelog/:id', async (c) => {
  const { ctx } = await loadAdmin(c);
  const e = await getEntry(ctx, c.req.param('id'));
  if (!e) throw fbErrors.entry_missing();
  return editor(c, { entry: e });
});

changelogAdmin.post('/changelog/images', async (c) => {
  needRole(c, 'member');
  const { ctx, portal } = await loadAdmin(c);
  if (!portal) return c.redirect(A);
  const b = await c.req.parseBody();
  const back = str(b, 'back');
  const to = back && back !== 'new' ? `${C}/${back.replace(/[^a-z0-9_]/gi, '')}` : `${C}/new`;
  try {
    const file = b.file;
    if (!(file instanceof File) || file.size === 0) throw fbErrors.image_invalid('Choose an image first.');
    const out = await saveImage(ctx, portal, await file.arrayBuffer(), file.type);
    return done(c, `${to}?img=${encodeURIComponent(out.url)}`, 'Image uploaded.');
  } catch (e) {
    return fail(c, to, e);
  }
});

changelogAdmin.post('/changelog/:id', async (c) => {
  needRole(c, 'member');
  const { ctx } = await loadAdmin(c);
  const id = c.req.param('id');
  const entry = await getEntry(ctx, id);
  if (!entry) throw fbErrors.entry_missing();
  const f = await readEntryForm(c);
  try {
    if (entry.state !== 'published' && f.state === 'scheduled' && !Number.isFinite(f.when)) {
      return editor(c, { entry, values: f.values, fields: { publish_at: 'Pick a date and time.' }, error: 'Pick a date and time to schedule this.', status: 422 });
    }
    const patch = { title: f.values.title, body: f.values.body, labels: f.labels, author_name: f.values.author_name, complete_posts: f.complete, post_ids: f.posts };
    if (entry.state === 'published') await updateEntry(ctx, id, patch);
    else {
      await updateEntry(ctx, id, { ...patch, state: f.state === 'published' ? 'draft' : f.state, publish_at: f.state === 'scheduled' ? f.when : null });
      if (f.state === 'published') await publishEntry(ctx, id, { id: null, name: c.get('user')?.name ?? 'The team' });
    }
    return done(c, `${C}/${id}`, f.state === 'published' && entry.state !== 'published' ? 'Entry published.' : 'Entry saved.');
  } catch (e) {
    const t = errorText(e);
    return editor(c, { entry, values: f.values, fields: t.fields, error: t.message, status: 422 });
  }
});

changelogAdmin.post('/changelog/:id/publish', async (c) => {
  needRole(c, 'member');
  const { ctx } = await loadAdmin(c);
  const id = c.req.param('id');
  try {
    await publishEntry(ctx, id, { id: null, name: c.get('user')?.name ?? 'The team' });
    return done(c, `${C}/${id}`, 'Entry published.');
  } catch (e) {
    return fail(c, `${C}/${id}`, e);
  }
});

changelogAdmin.post('/changelog/:id/delete', async (c) => {
  needRole(c, 'admin');
  const { ctx } = await loadAdmin(c);
  try {
    await deleteEntry(ctx, c.req.param('id'));
    return done(c, C, 'Entry deleted.');
  } catch (e) {
    return fail(c, C, e);
  }
});

// ---------------------------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------------------------

changelogAdmin.get('/subscribers', async (c) => {
  const { ctx, portal } = await loadAdmin(c);
  if (!portal) return c.redirect(A);
  const status = ['active', 'pending', 'unsubscribed'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'active';
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const [counts, rows, mail] = await Promise.all([subscriberCounts(ctx), listSubscribers(ctx, { status, limit: 51, offset }), codesAvailable(c.env)]);
  const shown = rows.slice(0, 50);
  return renderPage(c, { title: 'Subscribers', crumbs: [{ label: 'Feedback', href: A }, { label: 'Changelog', href: C }, { label: 'Subscribers' }] }, (
    <>
      <link rel="stylesheet" href="/m/feedback/admin.css" />
      <PageHeader title="Subscribers" description="People who asked for changelog emails. Each one confirmed their address and can leave with one click." />
      {!mail ? <Callout tone="warn" title="Email is not set up">Nobody can subscribe by email until sending is configured. The RSS feed still works.</Callout> : null}
      <Tabs
        label="Subscriber status"
        items={[
          { id: 'active', label: 'Active', count: counts.active, href: `${A}/subscribers?status=active` },
          { id: 'pending', label: 'Waiting to confirm', count: counts.pending, href: `${A}/subscribers?status=pending` },
          { id: 'unsubscribed', label: 'Unsubscribed', count: counts.unsubscribed, href: `${A}/subscribers?status=unsubscribed` },
        ]}
        active={status}
      />
      <Card flush>
        <Table
          caption="Subscribers"
          columns={[
            { key: 'email', label: 'Email' },
            { key: 'freq', label: 'Gets' },
            { key: 'since', label: 'Joined', hideOnMobile: true },
            { key: 'act', label: 'Actions', srOnly: true },
          ]}
          rows={shown.map((s) => ({
            email: s.email,
            freq: s.frequency === 'each' ? 'Each entry' : s.frequency === 'weekly' ? 'Weekly digest' : 'Monthly digest',
            since: formatDate(s.created_at),
            act: (
              <form method="post" action={`${A}/subscribers/${s.id}/remove`}>
                <ConfirmButton id={`rm-${s.id}`} size="sm" variant="ghost" title="Remove this subscriber" body="They stop getting emails. They can subscribe again later." confirmLabel="Remove">
                  Remove
                </ConfirmButton>
              </form>
            ),
          }))}
          empty={<EmptyState bare icon="mail" title="No subscribers here" body="Subscribers appear after they confirm their address on your changelog page." />}
        />
      </Card>
      <p class="row">
        {offset > 0 ? <LinkButton href={`${A}/subscribers?status=${status}&offset=${Math.max(0, offset - 50)}`}>Previous</LinkButton> : null}
        {rows.length > 50 ? <LinkButton href={`${A}/subscribers?status=${status}&offset=${offset + 50}`}>Next</LinkButton> : null}
      </p>
      <p class="hint">{plural(counts.active, 'active subscriber')}. {formatNumber(counts.pending)} waiting to confirm.</p>
    </>
  ));
});

changelogAdmin.post('/subscribers/:id/remove', async (c) => {
  needRole(c, 'admin');
  const { ctx } = await loadAdmin(c);
  await removeSubscriber(ctx, c.req.param('id'));
  return done(c, `${A}/subscribers`, 'Subscriber removed.');
});
