/** People: newsletters, subscribers, import and export, custom fields and segments. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import {
  Button, Callout, Card, Checkbox, ConfirmButton, CopyField, EmptyState, Field, FilterBar, Input, KeyValueList, LinkButton, PageHeader, Pagination, Pill, SearchInput, Select, Table, Textarea, formatDate, formatNumber, timeAgo,
} from '../../ui';
import { createField, createList, deleteField, deleteList, deleteSegment, getList, getSegment, listFields, listLists, listSegments, saveSegment, updateList } from './lists';
import { describeFilter, EMPTY_FILTER, type Filter, type Rule } from './segments';
import { addTagToMany, deleteSubscriber, exportSubscribersCsv, fieldsOf, getSubscriber, importSubscribers, IMPORT_MAX_ROWS, joinList, querySubscribers, replaceTags, unsubscribe, updateSubscriber } from './subscribers';
import { recordBounce } from './suppression';
import { getMailSettings, saveMailSettings } from './settings';
import { reqCtx, rememberBase } from './request';
import { canWrite, checked, csvResponse, flashAndGo, guard, HOME, page, plainError, readForm, safely, text, valuesOf, writer } from './dash-shared';

export const peopleScreens = new Hono<AppEnv>();

const STATUS_TONE = { active: 'good', pending: 'warn', unsubscribed: 'neutral' } as const;
const PAGE = 25;

// -- newsletters -----------------------------------------------------------------------------------

async function listsPage(c: import('hono').Context<AppEnv>, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const ctx = reqCtx(c);
  const base = await rememberBase(c);
  const [lists, settings] = await Promise.all([listLists(ctx), getMailSettings(c.env, ctx.org.id)]);
  const write = canWrite(c);
  const v = (k: string, d = '') => (k in values ? values[k]! : d);
  return page(c, 'Newsletters', (
    <>
      <PageHeader title="Newsletters" description="Each newsletter has its own signup page, subscribers and archive." />
      {lists.length === 0 ? null : (
        <div class="ml-cards">
          {lists.map((l) => (
            <Card title={l.name} description={l.description || undefined} actions={write ? <LinkButton href={`${HOME}/lists/${l.id}`} size="sm">Settings</LinkButton> : undefined}>
              <p class="muted ml-small">{formatNumber(l.active)} subscribers{l.pending ? `, ${formatNumber(l.pending)} waiting to confirm` : ''}</p>
              <CopyField label="Signup page" value={`${base}/n/${l.slug}`} />
              <details class="ml-details">
                <summary>Embed on your site</summary>
                <CopyField label="Embed code" value={`<iframe src="${base}/n/${l.slug}/embed" title="Subscribe to ${l.name.replace(/["<>&]/g, '')}" width="100%" height="260" style="border:0"></iframe>`} />
              </details>
              <div class="ml-actions ml-gap">
                <LinkButton href={`${HOME}/subscribers?list=${l.id}`} size="sm">Subscribers</LinkButton>
                <LinkButton href={`${HOME}/sequence?list=${l.id}`} size="sm">Welcome emails</LinkButton>
                {l.archive_public ? <LinkButton href={`/n/${l.slug}/archive`} size="sm">Public archive</LinkButton> : null}
              </div>
            </Card>
          ))}
        </div>
      )}
      {write ? (
        <Card title={lists.length ? 'Add a newsletter' : 'Create your first newsletter'} description="People sign up on a page we host. Double opt-in is on, so everyone confirms by email first." class="ml-gap">
          <form method="post" action={`${HOME}/lists`} class="ml-form-col">
            <Field id="name" label="Name" error={errors.name}>
              <Input id="name" name="name" value={v('name')} maxlength={80} invalid={!!errors.name} placeholder="Weekly notes" />
            </Field>
            <Field id="description" label="Short description" optional hint="Shown on the signup page.">
              <Input id="description" name="description" value={v('description')} maxlength={300} />
            </Field>
            {settings.postalAddress ? null : (
              <Field id="postal" label="Postal address" error={errors.postal} hint="Most countries require a real address in the footer of every email. You can change it later in settings.">
                <Textarea id="postal" name="postal" rows={2} value={v('postal')} invalid={!!errors.postal} placeholder="Example Ltd, 1 Main Street, Springfield" />
              </Field>
            )}
            <div class="ml-actions"><Button type="submit" variant="primary">Create newsletter</Button></div>
          </form>
        </Card>
      ) : null}
    </>
  ), undefined, status);
}

peopleScreens.get('/lists', (c) => guard(c, 'Newsletters', () => listsPage(c)));

peopleScreens.post('/lists', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const f = await readForm(c);
  try {
    const postal = text(f, 'postal');
    const settings = await getMailSettings(c.env, ctx.org.id);
    if (!settings.postalAddress && postal.length < 8) {
      return listsPage(c, { postal: 'Add a postal address so your emails follow the law.' }, valuesOf(f), 422);
    }
    const list = await createList(ctx, { name: text(f, 'name'), description: text(f, 'description') });
    if (!settings.postalAddress) await saveMailSettings(c.env, ctx.org.id, { postalAddress: postal });
    await auditFromRequest(c, { action: 'mail.list.create', targetType: 'mail_list', targetId: list.id, summary: `Created newsletter ${list.name}` });
    return flashAndGo(c, 'ok', 'Newsletter created. Share its signup page to get your first subscribers.', `${HOME}/lists`);
  } catch (e) {
    const { message, fields } = plainError(e);
    return listsPage(c, { ...fields, ...(Object.keys(fields).length ? {} : { name: message }) }, valuesOf(f), 422);
  }
});

peopleScreens.get('/lists/:id', async (c) => {
  writer(c);
  const l = await getList(reqCtx(c), c.req.param('id'));
  return page(c, 'Newsletter settings', listSettings(l, {}, {}));
});

function listSettings(l: import('./types').List, errors: Record<string, string>, values: Record<string, string>) {
  const v = (k: string, d: string) => (k in values ? values[k]! : d);
  return (
    <>
      <PageHeader title={l.name} description="Settings for this newsletter." />
      <Card>
        <form method="post" action={`${HOME}/lists/${l.id}`} class="ml-form-col">
          <Field id="name" label="Name" error={errors.name}><Input id="name" name="name" value={v('name', l.name)} invalid={!!errors.name} /></Field>
          <Field id="slug" label="Address of the signup page" error={errors.slug} hint="Letters, numbers and dashes. Changing it breaks links you already shared."><Input id="slug" name="slug" value={v('slug', l.slug)} invalid={!!errors.slug} /></Field>
          <Field id="description" label="Short description" optional><Input id="description" name="description" value={v('description', l.description)} /></Field>
          <Field id="reply_to" label="Replies go to" optional error={errors.reply_to} hint="Leave empty to use your sender address."><Input id="reply_to" name="reply_to" type="email" value={v('reply_to', l.reply_to)} invalid={!!errors.reply_to} /></Field>
          <Field id="thanks_text" label="Message after signing up" optional><Input id="thanks_text" name="thanks_text" value={v('thanks_text', l.thanks_text)} /></Field>
          <Checkbox name="double_opt_in" value="1" label="Ask people to confirm by email" description="Recommended. It keeps fake and mistyped addresses off your list." checked={values.double_opt_in !== undefined ? true : !!l.double_opt_in} />
          <Checkbox name="archive_public" value="1" label="Publish sent emails in a public archive" checked={values.archive_public !== undefined ? true : !!l.archive_public} />
          <div class="ml-actions"><Button type="submit" variant="primary">Save</Button><LinkButton href={`${HOME}/lists`}>Back</LinkButton></div>
        </form>
      </Card>
      <Card title="Delete newsletter" class="ml-gap">
        <p class="muted ml-small">Deletes its subscribers, emails and stats. This cannot be undone.</p>
        <form method="post" action={`${HOME}/lists/${l.id}/delete`}>
          <ConfirmButton id="del-list" title={`Delete ${l.name}?`} body="Its subscribers, emails and stats are removed for good." confirmLabel="Delete newsletter" danger>Delete newsletter</ConfirmButton>
        </form>
      </Card>
    </>
  );
}

peopleScreens.post('/lists/:id', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const id = c.req.param('id');
  const f = await readForm(c);
  try {
    await updateList(ctx, id, {
      name: text(f, 'name'), slug: text(f, 'slug') || undefined, description: text(f, 'description'), reply_to: text(f, 'reply_to'), thanks_text: text(f, 'thanks_text'),
      double_opt_in: checked(f, 'double_opt_in'), archive_public: checked(f, 'archive_public'),
    });
  } catch (e) {
    const { message, fields } = plainError(e);
    const l = await getList(ctx, id);
    return page(c, 'Newsletter settings', listSettings(l, { ...fields, ...(Object.keys(fields).length ? {} : { name: message }) }, valuesOf(f)), undefined, 422);
  }
  return flashAndGo(c, 'ok', 'Saved.', `${HOME}/lists`);
});

peopleScreens.post('/lists/:id/delete', async (c) => {
  writer(c);
  await deleteList(reqCtx(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'mail.list.delete', targetType: 'mail_list', targetId: c.req.param('id'), summary: 'Deleted a newsletter' });
  return flashAndGo(c, 'ok', 'Newsletter deleted.', `${HOME}/lists`);
});

// -- subscribers -----------------------------------------------------------------------------------

async function filterFor(c: import('hono').Context<AppEnv>): Promise<Filter | undefined> {
  const seg = c.req.query('segment');
  return seg ? (await getSegment(reqCtx(c), seg)).parsed : undefined;
}

peopleScreens.get('/subscribers', (c) =>
  safely(c, 'Subscribers', async () => {
    const ctx = reqCtx(c);
    const q = c.req.query();
    const pageNo = Math.max(1, Number(q.page) || 1);
    const [lists, segments, fields] = await Promise.all([listLists(ctx), listSegments(ctx), listFields(ctx)]);
    const out = await querySubscribers(ctx, {
      listId: q.list || undefined,
      status: (q.status as 'active') || undefined,
      tag: q.tag || undefined,
      q: q.q || undefined,
      segment: await filterFor(c),
      limit: PAGE,
      offset: (pageNo - 1) * PAGE,
    });
    const write = canWrite(c);
    const keep = (extra: Record<string, string>) => {
      const p = new URLSearchParams();
      for (const k of ['list', 'status', 'tag', 'q', 'segment']) if (q[k]) p.set(k, q[k]!);
      for (const [k, val] of Object.entries(extra)) p.set(k, val);
      return `${HOME}/subscribers?${p}`;
    };
    const filtered = !!(q.list || q.status || q.tag || q.q || q.segment);
    return (
      <>
        <PageHeader
          title="Subscribers"
          description={`${formatNumber(out.total)} ${out.total === 1 ? 'person' : 'people'}${filtered ? ' match' : ''}`}
          actions={write ? (
            <>
              <LinkButton href={`${HOME}/subscribers/import`} icon="upload">Import CSV</LinkButton>
              <LinkButton href={keep({}).replace('/subscribers?', '/subscribers/export?')} icon="download">Export</LinkButton>
            </>
          ) : <LinkButton href={keep({}).replace('/subscribers?', '/subscribers/export?')} icon="download">Export</LinkButton>}
        />
        <form method="get" action={`${HOME}/subscribers`} class="ml-filterbar" role="search">
          <SearchInput name="q" value={q.q ?? ''} label="Search by email or name" />
          <Select name="list" label="Newsletter" value={q.list ?? ''} options={[{ value: '', label: 'All newsletters' }, ...lists.map((l) => ({ value: l.id, label: l.name }))]} />
          <Select name="status" label="Status" value={q.status ?? ''} options={[{ value: '', label: 'Any status' }, { value: 'active', label: 'Subscribed' }, { value: 'pending', label: 'Waiting to confirm' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Blocked' }]} />
          {segments.length ? <Select name="segment" label="Segment" value={q.segment ?? ''} options={[{ value: '', label: 'No segment' }, ...segments.map((s) => ({ value: s.id, label: s.name }))]} /> : null}
          <Input name="tag" value={q.tag ?? ''} placeholder="Tag" aria-label="Tag" maxlength={60} />
          <Button type="submit">Filter</Button>
          {filtered ? <LinkButton href={`${HOME}/subscribers`}>Clear</LinkButton> : null}
        </form>
        <Card flush>
          <Table
            caption="Subscribers"
            columns={[
              { key: 'email', label: 'Email' },
              { key: 'status', label: 'Status' },
              { key: 'tags', label: 'Tags', hideOnMobile: true },
              { key: 'source', label: 'Source', hideOnMobile: true },
              { key: 'joined', label: 'Joined', hideOnMobile: true },
            ]}
            rows={out.items.map((s) => ({
              email: <a class="ml-name" href={`${HOME}/subscribers/${s.id}`}>{s.email}{s.name ? <span class="muted"> {s.name}</span> : null}</a>,
              status: s.status ? <Pill tone={STATUS_TONE[s.status]}>{s.status === 'active' ? 'Subscribed' : s.status === 'pending' ? 'Waiting' : 'Unsubscribed'}</Pill> : <Pill>None</Pill>,
              tags: s.tags ? s.tags.split(',').map((t) => <span class="chip">{t}</span>) : '',
              source: s.source,
              joined: timeAgo(s.created_at),
            }))}
            empty={
              filtered
                ? <EmptyState icon="search" title="No one matches" body="Try fewer filters." actions={<LinkButton href={`${HOME}/subscribers`}>Clear filters</LinkButton>} bare />
                : <EmptyState icon="users" title="No subscribers yet" body="Share your signup page, add someone below, or import a CSV of people who agreed to hear from you." actions={lists.length ? <LinkButton href={`${HOME}/lists`}>Get the signup link</LinkButton> : <LinkButton href={`${HOME}/lists`} variant="primary">Create a newsletter</LinkButton>} bare />
            }
          />
        </Card>
        {out.total > PAGE ? <Pagination page={pageNo} pageSize={PAGE} total={out.total} href={(p) => keep({ page: String(p) })} noun={['person', 'people']} /> : null}
        {write && lists.length ? (
          <Card title="Add someone" description="Only add people who asked to hear from you. They are marked as subscribed without a confirmation email." class="ml-gap">
            <form method="post" action={`${HOME}/subscribers`} class="ml-form-col">
              <Field id="a-email" label="Email"><Input id="a-email" name="email" type="email" required autocomplete="off" /></Field>
              <Field id="a-name" label="Name" optional><Input id="a-name" name="name" maxlength={120} /></Field>
              <Field id="a-list" label="Newsletter"><Select id="a-list" name="list" value={q.list ?? lists[0]!.id} options={lists.map((l) => ({ value: l.id, label: l.name }))} /></Field>
              <Field id="a-tags" label="Tags" optional hint="Separate with commas."><Input id="a-tags" name="tags" /></Field>
              <Checkbox name="consent" value="1" label="This person agreed to receive these emails" description="Required. Your note is saved with them." />
              <div class="ml-actions"><Button type="submit" variant="primary">Add subscriber</Button></div>
            </form>
          </Card>
        ) : null}
        {fields.length ? <p class="muted ml-small">Custom fields: {fields.map((f) => f.key).join(', ')}. <a href={`${HOME}/fields`}>Manage</a></p> : null}
      </>
    );
  }),
);

peopleScreens.post('/subscribers', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const f = await readForm(c);
  if (!checked(f, 'consent')) return flashAndGo(c, 'error', 'Tick the box to confirm this person agreed to receive your emails.', `${HOME}/subscribers`);
  try {
    const list = await getList(ctx, text(f, 'list'));
    const res = await joinList(ctx, list, { email: text(f, 'email'), name: text(f, 'name'), tags: text(f, 'tags').split(',').map((t) => t.trim()).filter(Boolean), source: 'manual', confirmed: true }, { base: await rememberBase(c) });
    if (res.outcome === 'blocked') return flashAndGo(c, 'error', 'That address is blocked because it bounced or complained before.', `${HOME}/subscribers`);
    return flashAndGo(c, 'ok', 'Subscriber added.', res.subscriber ? `${HOME}/subscribers/${res.subscriber.id}` : `${HOME}/subscribers`);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).fields.email ?? plainError(e).message, `${HOME}/subscribers`);
  }
});

peopleScreens.get('/subscribers/export', async (c) => {
  const ctx = reqCtx(c);
  const csv = await exportSubscribersCsv(ctx, { listId: c.req.query('list') || undefined, segment: await filterFor(c) });
  return csvResponse('subscribers.csv', csv);
});

// import

async function importPage(c: import('hono').Context<AppEnv>, report?: import('./subscribers').ImportReport, errors: Record<string, string> = {}, status?: 422) {
  const lists = await listLists(reqCtx(c));
  return page(c, 'Import subscribers', (
    <>
      <PageHeader title="Import subscribers" description={`Upload a CSV with an email column. Up to ${formatNumber(IMPORT_MAX_ROWS)} rows at a time. Other columns become custom fields.`} />
      {report ? (
        <Callout tone={report.added ? 'good' : 'info'} title={`${formatNumber(report.added)} added out of ${formatNumber(report.total)} rows`}>
          <ul class="ml-plain">
            {report.already_subscribed ? <li>{formatNumber(report.already_subscribed)} were already on the newsletter.</li> : null}
            {report.duplicates_in_file ? <li>{formatNumber(report.duplicates_in_file)} appeared twice in the file.</li> : null}
            {report.invalid ? <li>{formatNumber(report.invalid)} had an invalid email{report.invalid_examples.length ? `, for example ${report.invalid_examples.slice(0, 3).join(', ')}` : ''}.</li> : null}
            {report.suppressed ? <li>{formatNumber(report.suppressed)} were skipped because they unsubscribed, bounced or complained before.</li> : null}
            {report.ignored_columns.length ? <li>Ignored columns: {report.ignored_columns.join(', ')}.</li> : null}
            {report.truncated ? <li>Only the first {formatNumber(IMPORT_MAX_ROWS)} rows were read. Import the rest in another file.</li> : null}
          </ul>
        </Callout>
      ) : null}
      <Card>
        <form method="post" action={`${HOME}/subscribers/import`} enctype="multipart/form-data" class="ml-form-col">
          <Field id="i-list" label="Newsletter"><Select id="i-list" name="list" value={lists[0]?.id ?? ''} options={lists.map((l) => ({ value: l.id, label: l.name }))} /></Field>
          <Field id="i-file" label="CSV file" error={errors.file} hint="First row is the header."><input id="i-file" class="input" type="file" name="file" accept=".csv,text/csv" /></Field>
          <Field id="i-csv" label="Or paste the CSV" optional><Textarea id="i-csv" name="csv" rows={6} placeholder={'email,name\nada@example.com,Ada'} /></Field>
          <Field id="i-tags" label="Add tags to everyone" optional hint="Separate with commas."><Input id="i-tags" name="tags" /></Field>
          <Checkbox name="consent" value="1" label="Everyone in this file agreed to receive these emails" description="Required. People who unsubscribed, bounced or complained before are skipped, even if they are in the file." />
          {errors.consent ? <p class="field-error" role="alert">{errors.consent}</p> : null}
          <div class="ml-actions"><Button type="submit" variant="primary" disabled={lists.length === 0}>Import</Button><LinkButton href={`${HOME}/subscribers`}>Back</LinkButton></div>
        </form>
      </Card>
    </>
  ), [{ label: 'Mail', href: HOME }, { label: 'Subscribers', href: `${HOME}/subscribers` }, { label: 'Import' }], status);
}

peopleScreens.get('/subscribers/import', (c) => {
  writer(c);
  return importPage(c);
});

peopleScreens.post('/subscribers/import', async (c) => {
  writer(c);
  const f = await readForm(c);
  const file = Array.isArray(f.file) ? f.file[0] : f.file;
  let csv = text(f, 'csv');
  if (file && typeof file !== 'string' && file.size > 0) {
    if (file.size > 2_000_000) return importPage(c, undefined, { file: 'That file is too large. Keep it under 2 MB.' }, 422);
    csv = await file.text();
  }
  if (!csv.trim()) return importPage(c, undefined, { file: 'Choose a file or paste some rows.' }, 422);
  if (!checked(f, 'consent')) return importPage(c, undefined, { consent: 'Confirm that these people agreed to receive your emails.' }, 422);
  try {
    const report = await importSubscribers(reqCtx(c), { listId: text(f, 'list'), csv, consent: true, tags: text(f, 'tags').split(',').map((t) => t.trim()).filter(Boolean) });
    await auditFromRequest(c, { action: 'mail.subscribers.import', targetType: 'mail_list', targetId: text(f, 'list'), summary: `Imported ${report.added} subscribers` });
    return importPage(c, report);
  } catch (e) {
    return importPage(c, undefined, { file: plainError(e).message }, 422);
  }
});

// one person

async function personPage(c: import('hono').Context<AppEnv>, id: string, errors: Record<string, string> = {}, status?: 422) {
  const d = await getSubscriber(reqCtx(c), id);
  const write = canWrite(c);
  const s = d.subscriber;
  return page(c, s.email, (
    <>
      <PageHeader title={s.email} description={s.name || undefined} />
      {d.suppressions.length ? <Callout tone="warn" title="Blocked from sending">Reason: {d.suppressions.map((x) => x.reason).join(', ')}. This stays in place even if they are imported again.</Callout> : null}
      <Card title="Details">
        <KeyValueList items={[
          { label: 'Source', value: s.source || 'Unknown' },
          { label: 'Joined', value: formatDate(s.created_at) },
          { label: 'Consent', value: s.consent_note || 'Not recorded' },
          { label: 'Opens', value: formatNumber(s.opens) },
          { label: 'Clicks', value: formatNumber(s.clicks) },
        ]} />
        {Object.keys(d.fields).length ? <KeyValueList items={Object.entries(d.fields).map(([k, val]) => ({ label: k, value: val }))} /> : null}
      </Card>
      <Card title="Newsletters" flush class="ml-gap">
        <Table caption="Memberships" columns={[{ key: 'list', label: 'Newsletter' }, { key: 'status', label: 'Status' }, { key: 'since', label: 'Since', hideOnMobile: true }]}
          rows={d.memberships.map((m) => ({ list: m.list_name, status: <Pill tone={STATUS_TONE[m.status]}>{m.status === 'active' ? 'Subscribed' : m.status === 'pending' ? 'Waiting' : 'Unsubscribed'}</Pill>, since: formatDate(m.joined_at) }))}
          empty={<EmptyState icon="mail" title="Not on any newsletter" bare />} />
      </Card>
      {write ? (
        <Card title="Edit" class="ml-gap">
          <form method="post" action={`${HOME}/subscribers/${id}`} class="ml-form-col">
            <Field id="p-name" label="Name" optional><Input id="p-name" name="name" value={s.name} maxlength={120} /></Field>
            <Field id="p-tags" label="Tags" optional error={errors.tags} hint="Separate with commas."><Input id="p-tags" name="tags" value={d.tags.join(', ')} invalid={!!errors.tags} /></Field>
            <div class="ml-actions"><Button type="submit" variant="primary">Save</Button></div>
          </form>
          <div class="ml-actions ml-gap">
            {d.memberships.some((m) => m.status !== 'unsubscribed') ? (
              <form method="post" action={`${HOME}/subscribers/${id}/unsubscribe`}><ConfirmButton id="unsub" title="Unsubscribe this person?" body="They stop getting every newsletter. They can sign up again." confirmLabel="Unsubscribe">Unsubscribe</ConfirmButton></form>
            ) : null}
            {d.suppressions.length === 0 ? (
              <form method="post" action={`${HOME}/subscribers/${id}/bounced`}><ConfirmButton id="bounce" title="Mark as bounced?" body="Use this when you know the address does not work. Nothing is sent to it again." confirmLabel="Mark as bounced">Mark as bounced</ConfirmButton></form>
            ) : null}
            <form method="post" action={`${HOME}/subscribers/${id}/delete`}><ConfirmButton id="del-sub" title="Delete this person?" body="Removes them and their history. If they later sign up again they start fresh." confirmLabel="Delete" danger>Delete</ConfirmButton></form>
          </div>
        </Card>
      ) : null}
    </>
  ), [{ label: 'Mail', href: HOME }, { label: 'Subscribers', href: `${HOME}/subscribers` }, { label: s.email }], status);
}

peopleScreens.get('/subscribers/:id', (c) => guard(c, 'Subscriber', () => personPage(c, c.req.param('id'))));

peopleScreens.post('/subscribers/:id', async (c) => {
  writer(c);
  const id = c.req.param('id');
  const f = await readForm(c);
  try {
    await updateSubscriber(reqCtx(c), id, { name: text(f, 'name'), tags: text(f, 'tags').split(',').map((t) => t.trim()).filter(Boolean) });
  } catch (e) {
    const { message, fields } = plainError(e);
    return personPage(c, id, { tags: fields.tags ?? message }, 422);
  }
  return flashAndGo(c, 'ok', 'Saved.', `${HOME}/subscribers/${id}`);
});

peopleScreens.post('/subscribers/:id/unsubscribe', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const id = c.req.param('id');
  const d = await getSubscriber(ctx, id);
  for (const m of d.memberships) await unsubscribe(ctx, { s: id, l: m.list_id }, 'manual');
  return flashAndGo(c, 'ok', 'Unsubscribed.', `${HOME}/subscribers/${id}`);
});

peopleScreens.post('/subscribers/:id/bounced', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const id = c.req.param('id');
  const d = await getSubscriber(ctx, id);
  await recordBounce(ctx, d.subscriber.email, 'Marked by hand');
  await auditFromRequest(c, { action: 'mail.subscriber.bounced', targetType: 'mail_subscriber', targetId: id, summary: 'Marked an address as bounced' });
  return flashAndGo(c, 'ok', 'Marked as bounced. Nothing will be sent to it.', `${HOME}/subscribers/${id}`);
});

peopleScreens.post('/subscribers/:id/delete', async (c) => {
  writer(c);
  await deleteSubscriber(reqCtx(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'mail.subscriber.delete', targetType: 'mail_subscriber', targetId: c.req.param('id'), summary: 'Deleted a subscriber' });
  return flashAndGo(c, 'ok', 'Subscriber deleted.', `${HOME}/subscribers`);
});

// -- custom fields ---------------------------------------------------------------------------------

peopleScreens.get('/fields', (c) =>
  safely(c, 'Custom fields', async () => {
    const fields = await listFields(reqCtx(c));
    const write = canWrite(c);
    return (
      <>
        <PageHeader title="Custom fields" description="Extra details about people, like company or plan. Use them in emails as {{company|there}} and in segments." />
        <Card flush>
          <Table caption="Custom fields" columns={[{ key: 'key', label: 'Key' }, { key: 'label', label: 'Label' }, { key: 'type', label: 'Type', hideOnMobile: true }, { key: 'x', label: 'Remove', srOnly: true }]}
            rows={fields.map((f) => ({ key: <code>{f.key}</code>, label: f.label, type: f.type, x: write ? <form method="post" action={`${HOME}/fields/${f.id}/delete`}><ConfirmButton id={`df-${f.id}`} title={`Remove ${f.label}?`} body="The values stay on people but are no longer listed here." confirmLabel="Remove" size="sm" danger>Remove</ConfirmButton></form> : '' }))}
            empty={<EmptyState icon="list" title="No custom fields" body="Add one, or import a CSV with extra columns." bare />} />
        </Card>
        {write ? (
          <Card title="Add a field" class="ml-gap">
            <form method="post" action={`${HOME}/fields`} class="ml-form-col">
              <Field id="f-key" label="Key" hint="Lowercase letters, numbers and underscores."><Input id="f-key" name="key" required /></Field>
              <Field id="f-label" label="Label"><Input id="f-label" name="label" required /></Field>
              <Field id="f-type" label="Type"><Select id="f-type" name="type" value="text" options={[{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }]} /></Field>
              <div class="ml-actions"><Button type="submit" variant="primary">Add field</Button></div>
            </form>
          </Card>
        ) : null}
      </>
    );
  }),
);

peopleScreens.post('/fields', async (c) => {
  writer(c);
  const f = await readForm(c);
  try {
    await createField(reqCtx(c), { key: text(f, 'key'), label: text(f, 'label'), type: text(f, 'type') || 'text' });
  } catch (e) {
    const { message, fields } = plainError(e);
    return flashAndGo(c, 'error', fields.key ?? fields.label ?? message, `${HOME}/fields`);
  }
  return flashAndGo(c, 'ok', 'Field added.', `${HOME}/fields`);
});

peopleScreens.post('/fields/:id/delete', async (c) => {
  writer(c);
  await deleteField(reqCtx(c), c.req.param('id'));
  return flashAndGo(c, 'ok', 'Field removed.', `${HOME}/fields`);
});

// -- segments --------------------------------------------------------------------------------------

const RULE_KINDS: { value: string; label: string; needsValue: boolean }[] = [
  { value: 'tag:has', label: 'Has the tag', needsValue: true },
  { value: 'tag:not', label: 'Does not have the tag', needsValue: true },
  { value: 'email:contains', label: 'Email contains', needsValue: true },
  { value: 'email:ends_with', label: 'Email ends with', needsValue: true },
  { value: 'name:set', label: 'Has a name', needsValue: false },
  { value: 'name:empty', label: 'Has no name', needsValue: false },
  { value: 'source:is', label: 'Came from', needsValue: true },
  { value: 'source:not', label: 'Did not come from', needsValue: true },
  { value: 'joined_days:within', label: 'Joined in the last (days)', needsValue: true },
  { value: 'opens:at_least', label: 'Opened at least (times)', needsValue: true },
  { value: 'clicks:at_least', label: 'Clicked at least (times)', needsValue: true },
  { value: 'field:is', label: 'Field is (key=value)', needsValue: true },
  { value: 'field:contains', label: 'Field contains (key=value)', needsValue: true },
  { value: 'field:set', label: 'Field is filled in (key)', needsValue: true },
  { value: 'field:empty', label: 'Field is empty (key)', needsValue: true },
];
const SLOTS = 5;

function ruleToRow(r: Rule): { kind: string; value: string } {
  if (r.type === 'field') return { kind: `field:${r.op}`, value: r.op === 'set' || r.op === 'empty' ? r.key : `${r.key}=${r.value ?? ''}` };
  const op = 'op' in r ? (r as { op: string }).op : '';
  return { kind: `${r.type}:${op}`, value: 'value' in r ? String((r as { value: unknown }).value) : '' };
}

function rowsToFilter(f: Record<string, string>): { filter: unknown; error?: string } {
  const rules: unknown[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const kind = (f[`kind${i}`] ?? '').trim();
    const value = (f[`value${i}`] ?? '').trim();
    if (!kind) continue;
    const [type, op] = kind.split(':') as [string, string];
    const spec = RULE_KINDS.find((k) => k.value === kind);
    if (!spec) return { filter: null, error: 'One of the rules is not recognised.' };
    if (spec.needsValue && !value) return { filter: null, error: `Fill in the value for "${spec.label}".` };
    if (type === 'field') {
      if (op === 'set' || op === 'empty') rules.push({ type, op, key: value.toLowerCase() });
      else {
        const [key, ...rest] = value.split('=');
        rules.push({ type, op, key: (key ?? '').trim().toLowerCase(), value: rest.join('=').trim() });
      }
    } else if (spec.needsValue) rules.push({ type, op, value });
    else rules.push({ type, op });
  }
  return { filter: { match: f.match === 'any' ? 'any' : 'all', rules } };
}

async function segmentForm(c: import('hono').Context<AppEnv>, id: string | null, name: string, filter: Filter, errors: Record<string, string> = {}, status?: 422) {
  const ctx = reqCtx(c);
  const count = filter.rules.length || id ? (await querySubscribers(ctx, { segment: filter, limit: 1 })).total : null;
  const rows = [...filter.rules.map(ruleToRow), ...Array.from({ length: SLOTS }, () => ({ kind: '', value: '' }))].slice(0, SLOTS);
  return page(c, id ? 'Edit segment' : 'New segment', (
    <>
      <PageHeader title={id ? name || 'Segment' : 'New segment'} description="A segment is a saved group of people. Use it to send an email to part of a newsletter." />
      {count !== null ? <Callout tone="info" title={`${formatNumber(count)} ${count === 1 ? 'person matches' : 'people match'} now`}>{describeFilter(filter)}</Callout> : null}
      <Card>
        <form method="post" action={id ? `${HOME}/segments/${id}` : `${HOME}/segments`} class="ml-form-col">
          <Field id="s-name" label="Name" error={errors.name}><Input id="s-name" name="name" value={name} invalid={!!errors.name} maxlength={80} /></Field>
          <Field id="s-match" label="People match"><Select id="s-match" name="match" value={filter.match} options={[{ value: 'all', label: 'All of these rules' }, { value: 'any', label: 'Any of these rules' }]} /></Field>
          {errors.rules ? <p class="field-error" role="alert">{errors.rules}</p> : null}
          <fieldset class="ml-rules"><legend>Rules</legend>
            {rows.map((r, i) => (
              <div class="ml-rule">
                <Select name={`kind${i}`} label={`Rule ${i + 1}`} value={r.kind} options={[{ value: '', label: i === 0 ? 'Choose a rule' : 'No rule' }, ...RULE_KINDS.map((k) => ({ value: k.value, label: k.label }))]} />
                <Input name={`value${i}`} value={r.value} aria-label={`Value for rule ${i + 1}`} maxlength={200} />
              </div>
            ))}
          </fieldset>
          <div class="ml-actions"><Button type="submit" variant="primary" name="go" value="save">Save segment</Button><Button type="submit" name="go" value="count">Check who matches</Button><LinkButton href={`${HOME}/segments`}>Back</LinkButton></div>
        </form>
        {id && canWrite(c) ? <form method="post" action={`${HOME}/segments/${id}/delete`} class="ml-gap"><ConfirmButton id="del-seg" title="Delete this segment?" body="Emails already sent are not affected." confirmLabel="Delete segment" danger>Delete segment</ConfirmButton></form> : null}
      </Card>
    </>
  ), [{ label: 'Mail', href: HOME }, { label: 'Segments', href: `${HOME}/segments` }, { label: id ? name || 'Segment' : 'New' }], status);
}

peopleScreens.get('/segments', (c) =>
  safely(c, 'Segments', async () => {
    const ctx = reqCtx(c);
    const segs = await listSegments(ctx);
    const write = canWrite(c);
    const parsed = await Promise.all(segs.map(async (s) => ({ s, f: (await getSegment(ctx, s.id)).parsed })));
    return (
      <>
        <PageHeader title="Segments" description="Saved groups of people, picked by tag, source, activity or custom field." actions={write ? <LinkButton href={`${HOME}/segments/new`} variant="primary" icon="plus">New segment</LinkButton> : null} />
        <Card flush>
          <Table caption="Segments" columns={[{ key: 'name', label: 'Segment' }, { key: 'rules', label: 'Rules', hideOnMobile: true }, { key: 'made', label: 'Created', hideOnMobile: true }]}
            rows={parsed.map(({ s, f }) => ({ name: <a class="ml-name" href={`${HOME}/segments/${s.id}`}>{s.name}</a>, rules: describeFilter(f), made: timeAgo(s.created_at) }))}
            empty={<EmptyState icon="filter" title="No segments yet" body="Create one to email only the people who joined this month, or who have a certain tag." actions={write ? <LinkButton href={`${HOME}/segments/new`} variant="primary">New segment</LinkButton> : null} bare />} />
        </Card>
      </>
    );
  }),
);

peopleScreens.get('/segments/new', (c) => {
  writer(c);
  return segmentForm(c, null, '', EMPTY_FILTER);
});

async function saveSeg(c: import('hono').Context<AppEnv>, id: string | null) {
  writer(c);
  const ctx = reqCtx(c);
  const f = valuesOf(await readForm(c));
  const built = rowsToFilter(f);
  const name = (f.name ?? '').trim();
  const show = async (errors: Record<string, string>) => {
    let flt: Filter = EMPTY_FILTER;
    try { if (!built.error) flt = (await import('./segments')).parseFilter(built.filter); } catch { /* shown below */ }
    return segmentForm(c, id, name, flt, errors, 422);
  };
  if (built.error) return show({ rules: built.error });
  if (f.go === 'count') {
    try { return segmentForm(c, id, name, (await import('./segments')).parseFilter(built.filter)); } catch (e) { return show({ rules: plainError(e).message }); }
  }
  try {
    const row = await saveSegment(ctx, { id: id ?? undefined, name, filter: built.filter });
    return flashAndGo(c, 'ok', 'Segment saved.', `${HOME}/segments/${row.id}`);
  } catch (e) {
    const { message, fields } = plainError(e);
    return show({ ...(fields.name ? { name: fields.name } : {}), ...(!fields.name ? { rules: fields.filter ?? message } : {}) });
  }
}

peopleScreens.post('/segments', (c) => saveSeg(c, null));
peopleScreens.get('/segments/:id', async (c) => {
  const seg = await getSegment(reqCtx(c), c.req.param('id'));
  return segmentForm(c, seg.id, seg.name, seg.parsed);
});
peopleScreens.post('/segments/:id/delete', async (c) => {
  writer(c);
  await deleteSegment(reqCtx(c), c.req.param('id'));
  return flashAndGo(c, 'ok', 'Segment deleted.', `${HOME}/segments`);
});
peopleScreens.post('/segments/:id', (c) => saveSeg(c, c.req.param('id')));
