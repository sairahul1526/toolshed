/** Welcome emails, product emails, RSS, stats, deliverability and settings. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { emailStatus } from '../../core/email';
import {
  BarChart, Button, Callout, Card, Checkbox, CodeBlock, ConfirmButton, EmptyState, Field, Input, LinkButton, PageHeader, Pill, Select, Stat, StatGrid, Table, Textarea, formatNumber, timeAgo,
} from '../../ui';
import { getList, listLists } from './lists';
import { getSequence, MAX_STEPS, saveSequence } from './sequences';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, recentSent, sendTransactional, updateTemplate } from './transactional';
import { addFeed, checkFeed, listFeeds, removeFeed, setFeedStatus } from './rss';
import { growth, totals } from './stats';
import { countSuppressions, importBounced, listSuppressions, removeSuppression, BOUNCE_IMPORT_MAX } from './suppression';
import { getMailSettings, saveMailSettings } from './settings';
import { reqCtx, rememberBase } from './request';
import { canWrite, checked, flashAndGo, guard, HOME, page, plainError, readForm, safely, text, valuesOf, writer } from './dash-shared';
import { HOURLY_CAP } from './broadcasts';
import { baseUrl } from '../../core/net';

export const moreScreens = new Hono<AppEnv>();

// -- welcome emails --------------------------------------------------------------------------------

const SLOTS = MAX_STEPS;

async function sequencePage(c: import('hono').Context<AppEnv>, listId: string, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const ctx = reqCtx(c);
  const lists = await listLists(ctx);
  if (lists.length === 0) {
    return page(c, 'Welcome emails', (
      <>
        <PageHeader title="Welcome emails" description="A short series sent after someone confirms." />
        <EmptyState icon="mail" title="Create a newsletter first" body="Welcome emails belong to a newsletter." actions={canWrite(c) ? <LinkButton href={`${HOME}/lists`} variant="primary">Create a newsletter</LinkButton> : null} />
      </>
    ));
  }
  const list = lists.find((l) => l.id === listId) ?? lists[0]!;
  const { sequence, steps } = await getSequence(ctx, list.id);
  const write = canWrite(c);
  const v = (k: string, d: string) => (k in values ? values[k]! : d);
  const slots = Array.from({ length: SLOTS }, (_, i) => steps[i] ?? null);
  const filled = slots.reduce((n, st, i) => (st || (values[`subject${i}`] ?? '').trim() || (values[`body${i}`] ?? '').trim() ? i + 1 : n), 0);
  return page(c, 'Welcome emails', (
    <>
      <PageHeader title="Welcome emails" description="Up to 10 emails sent after someone confirms. Each one waits after the one before." />
      {lists.length > 1 ? (
        <form method="get" action={`${HOME}/sequence`} class="ml-filterbar"><Select name="list" aria-label="Newsletter" value={list.id} options={lists.map((l) => ({ value: l.id, label: l.name }))} /><Button type="submit">Show</Button></form>
      ) : null}
      {sequence?.status === 'active' ? <Callout tone="good" title="This series is on">New subscribers to {list.name} get these emails.</Callout> : <Callout tone="info" title="This series is off">Nothing is sent until you turn it on. People who joined before you turned it on are not added.</Callout>}
      <form method="post" action={`${HOME}/sequence`} class="ml-form-col">
        <input type="hidden" name="list" value={list.id} />
        {Array.from({ length: Math.min(SLOTS, Math.max(filled + (write ? 1 : 0), 1)) }, (_, i) => {
          const s = slots[i];
          return (
            <Card title={`Email ${i + 1}`} class="ml-step ml-fields">
              <Field id={`d${i}`} label={i === 0 ? 'Send after confirming (hours)' : 'Wait after the previous email (hours)'} error={errors[`delay${i}`]} hint="0 sends it right away.">
                <Input id={`d${i}`} name={`delay${i}`} type="number" min={0} max={8760} value={v(`delay${i}`, s ? String(Math.round(s.delay_minutes / 60)) : i === 0 ? '0' : '48')} invalid={!!errors[`delay${i}`]} disabled={!write} />
              </Field>
              <Field id={`s${i}`} label="Subject" error={errors[`subject${i}`]}><Input id={`s${i}`} name={`subject${i}`} value={v(`subject${i}`, s?.subject ?? '')} maxlength={200} invalid={!!errors[`subject${i}`]} disabled={!write} /></Field>
              <Field id={`b${i}`} label="Body" error={errors[`body${i}`]} hint="Markdown. Use {{first_name|there}} to add a name."><Textarea id={`b${i}`} name={`body${i}`} rows={8} value={v(`body${i}`, s?.body ?? '')} invalid={!!errors[`body${i}`]} disabled={!write} class="ml-body" /></Field>
            </Card>
          );
        })}
        {errors.form ? <p class="field-error" role="alert">{errors.form}</p> : null}
        {write ? (
          <div class="ml-actions">
            <Button type="submit" variant="primary" name="go" value="save">Save emails</Button>
            <Button type="submit" name="go" value={sequence?.status === 'active' ? 'off' : 'on'}>{sequence?.status === 'active' ? 'Turn off' : 'Save and turn on'}</Button>
          </div>
        ) : null}
        <p class="muted ml-small">Leave an email empty to remove it. Add the next email by saving, then it appears below.</p>
      </form>
    </>
  ), undefined, status);
}

moreScreens.get('/sequence', (c) => guard(c, 'Welcome emails', () => sequencePage(c, c.req.query('list') ?? '')));

moreScreens.post('/sequence', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const f = valuesOf(await readForm(c));
  const listId = f.list ?? '';
  await getList(ctx, listId);
  const steps: { delay_minutes: number; subject: string; body: string }[] = [];
  const errors: Record<string, string> = {};
  for (let i = 0; i < SLOTS; i++) {
    const subject = (f[`subject${i}`] ?? '').trim();
    const body = f[`body${i}`] ?? '';
    if (!subject && !body.trim()) continue;
    const hours = Number(f[`delay${i}`] ?? 0);
    if (!Number.isFinite(hours) || hours < 0 || hours > 8760) errors[`delay${i}`] = 'Use a number of hours from 0 to 8760.';
    if (!subject) errors[`subject${i}`] = 'Add a subject.';
    if (!body.trim()) errors[`body${i}`] = 'Write something in this email.';
    steps.push({ delay_minutes: Math.round(hours * 60), subject, body });
  }
  if (Object.keys(errors).length) return sequencePage(c, listId, errors, f, 422);
  const go = f.go ?? 'save';
  if (go === 'on' && steps.length === 0) return sequencePage(c, listId, { form: 'Add at least one email before turning the series on.' }, f, 422);
  try {
    await saveSequence(ctx, listId, { steps, ...(go === 'on' ? { status: 'active' } : go === 'off' ? { status: 'draft' } : {}) });
  } catch (e) {
    return sequencePage(c, listId, { form: plainError(e).message }, f, 422);
  }
  await auditFromRequest(c, { action: 'mail.sequence.save', targetType: 'mail_list', targetId: listId, summary: `Saved welcome emails (${go})` });
  return flashAndGo(c, 'ok', go === 'on' ? 'Saved and turned on.' : go === 'off' ? 'Turned off.' : 'Saved.', `${HOME}/sequence?list=${listId}`);
});

// -- product emails --------------------------------------------------------------------------------

async function templatesPage(c: import('hono').Context<AppEnv>, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const ctx = reqCtx(c);
  const [templates, sent] = await Promise.all([listTemplates(ctx), recentSent(ctx, 15)]);
  const base = baseUrl(c);
  const write = canWrite(c);
  const v = (k: string, d = '') => (k in values ? values[k]! : d);
  return page(c, 'Product emails', (
    <>
      <PageHeader title="Product emails" description="One-to-one emails your app sends, like receipts and password resets. They go to one person, not a list, and skip the unsubscribe footer." />
      <Card flush>
        <Table caption="Templates" columns={[{ key: 'name', label: 'Template' }, { key: 'key', label: 'Key' }, { key: 'subject', label: 'Subject', hideOnMobile: true }, { key: 'x', label: 'Actions', srOnly: true }]}
          rows={templates.map((t) => ({ name: <a class="ml-name" href={`${HOME}/templates/${t.id}`}>{t.name}</a>, key: <code>{t.key}</code>, subject: t.subject, x: '' }))}
          empty={<EmptyState icon="mail" title="No templates yet" body="Create one below, then send it from your app with one API call." bare />} />
      </Card>
      {write ? (
        <Card title="New template" description="Use {{name}} style tags. Values come from the data you send." class="ml-gap">
          <form method="post" action={`${HOME}/templates`} class="ml-form-col">
            <Field id="t-name" label="Name" error={errors.name}><Input id="t-name" name="name" value={v('name')} invalid={!!errors.name} /></Field>
            <Field id="t-key" label="Key" error={errors.key} hint="What your app uses to pick it, like welcome-receipt."><Input id="t-key" name="key" value={v('key')} invalid={!!errors.key} /></Field>
            <Field id="t-subject" label="Subject" error={errors.subject}><Input id="t-subject" name="subject" value={v('subject')} invalid={!!errors.subject} /></Field>
            <Field id="t-body" label="Body" error={errors.body} hint="Markdown."><Textarea id="t-body" name="body" rows={8} value={v('body')} invalid={!!errors.body} class="ml-body" /></Field>
            <div class="ml-actions"><Button type="submit" variant="primary">Create template</Button></div>
          </form>
        </Card>
      ) : null}
      <Card title="Send from your app" class="ml-gap">
        <p class="muted ml-small">Create an API key with the mail:send scope in settings, then call:</p>
        <CodeBlock label="Send a product email" code={`curl -X POST ${base}/api/v1/mail/send \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Idempotency-Key: order-1042" \\\n  -H "Content-Type: application/json" \\\n  -d '{"to":"ada@example.com","template":"welcome-receipt","data":{"first_name":"Ada"}}'`} />
      </Card>
      <Card title="Recent sends" flush class="ml-gap">
        <Table caption="Recent product emails" columns={[{ key: 'to', label: 'To' }, { key: 'template', label: 'Template', hideOnMobile: true }, { key: 'status', label: 'Status' }, { key: 'when', label: 'When', hideOnMobile: true }]}
          rows={sent.map((s) => ({ to: s.to_email, template: s.template_key || 'Custom', status: <Pill tone={s.status === 'sent' ? 'good' : s.status === 'failed' ? 'bad' : 'neutral'}>{s.status}</Pill>, when: timeAgo(s.created_at) }))}
          empty={<EmptyState icon="send" title="Nothing sent yet" bare />} />
      </Card>
    </>
  ), undefined, status);
}

moreScreens.get('/templates', (c) => guard(c, 'Product emails', () => templatesPage(c)));

moreScreens.post('/templates', async (c) => {
  writer(c);
  const f = await readForm(c);
  try {
    const t = await createTemplate(reqCtx(c), { key: text(f, 'key'), name: text(f, 'name'), subject: text(f, 'subject'), body: (f.body as string) ?? '' });
    return flashAndGo(c, 'ok', 'Template created.', `${HOME}/templates/${t.id}`);
  } catch (e) {
    const { message, fields } = plainError(e);
    return templatesPage(c, { ...fields, ...(Object.keys(fields).length ? {} : { name: message }) }, valuesOf(f), 422);
  }
});

async function templatePage(c: import('hono').Context<AppEnv>, id: string, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const t = await getTemplate(reqCtx(c), id);
  const write = canWrite(c);
  const v = (k: string, d: string) => (k in values ? values[k]! : d);
  return page(c, t.name, (
    <>
      <PageHeader title={t.name} description={`Key: ${t.key}`} />
      <Card>
        <form method="post" action={`${HOME}/templates/${t.id}`} class="ml-form-col">
          <Field id="t-name" label="Name" error={errors.name}><Input id="t-name" name="name" value={v('name', t.name)} invalid={!!errors.name} disabled={!write} /></Field>
          <Field id="t-key" label="Key" error={errors.key}><Input id="t-key" name="key" value={v('key', t.key)} invalid={!!errors.key} disabled={!write} /></Field>
          <Field id="t-subject" label="Subject" error={errors.subject}><Input id="t-subject" name="subject" value={v('subject', t.subject)} invalid={!!errors.subject} disabled={!write} /></Field>
          <Field id="t-body" label="Body" error={errors.body}><Textarea id="t-body" name="body" rows={10} value={v('body', t.body)} invalid={!!errors.body} disabled={!write} class="ml-body" /></Field>
          {write ? <div class="ml-actions"><Button type="submit" variant="primary">Save</Button></div> : null}
        </form>
      </Card>
      {write ? (
        <>
          <Card title="Send a test" class="ml-gap">
            <form novalidate method="post" action={`${HOME}/templates/${t.id}/test`} class="ml-form-col">
              <Field id="x-to" label="Send to" error={errors.to}><Input id="x-to" name="to" type="email" value={v('to', '')} invalid={!!errors.to} placeholder="you@example.com" /></Field>
              <div class="ml-actions"><Button type="submit">Send test</Button></div>
            </form>
          </Card>
          <form method="post" action={`${HOME}/templates/${t.id}/delete`} class="ml-gap"><ConfirmButton id="del-t" title="Delete this template?" body="Calls from your app that use its key will fail." confirmLabel="Delete template" danger>Delete template</ConfirmButton></form>
        </>
      ) : null}
    </>
  ), [{ label: 'Mail', href: HOME }, { label: 'Product emails', href: `${HOME}/templates` }, { label: t.name }], status);
}

moreScreens.get('/templates/:id', (c) => templatePage(c, c.req.param('id')));
moreScreens.post('/templates/:id/delete', async (c) => {
  writer(c);
  await deleteTemplate(reqCtx(c), c.req.param('id'));
  return flashAndGo(c, 'ok', 'Template deleted.', `${HOME}/templates`);
});
moreScreens.post('/templates/:id/test', async (c) => {
  writer(c);
  const id = c.req.param('id');
  const f = await readForm(c);
  try {
    const t = await getTemplate(reqCtx(c), id);
    await sendTransactional(reqCtx(c), { to: text(f, 'to'), template: t.key, data: {} });
  } catch (e) {
    const { message, fields } = plainError(e);
    return templatePage(c, id, { to: fields.to ?? fields.template ?? message }, valuesOf(f), 422);
  }
  return flashAndGo(c, 'ok', `Test sent to ${text(f, 'to')}.`, `${HOME}/templates/${id}`);
});
moreScreens.post('/templates/:id', async (c) => {
  writer(c);
  const id = c.req.param('id');
  const f = await readForm(c);
  try {
    await updateTemplate(reqCtx(c), id, { key: text(f, 'key'), name: text(f, 'name'), subject: text(f, 'subject'), body: (f.body as string) ?? '' });
  } catch (e) {
    const { message, fields } = plainError(e);
    return templatePage(c, id, { ...fields, ...(Object.keys(fields).length ? {} : { name: message }) }, valuesOf(f), 422);
  }
  return flashAndGo(c, 'ok', 'Saved.', `${HOME}/templates/${id}`);
});

// -- RSS to email ----------------------------------------------------------------------------------

async function feedsPage(c: import('hono').Context<AppEnv>, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const ctx = reqCtx(c);
  const [feeds, lists] = await Promise.all([listFeeds(ctx), listLists(ctx)]);
  const write = canWrite(c);
  return page(c, 'RSS to email', (
    <>
      <PageHeader title="RSS to email" description="Turn new posts from a blog or feed into emails. Mail checks each feed every hour." />
      <Callout tone="info" title="Drafts are the safe choice">In draft mode each new post becomes a draft for you to review. In send mode it goes out on its own. The first check only records what is already there, so old posts are never emailed.</Callout>
      <Card flush class="ml-gap">
        <Table caption="Feeds" columns={[{ key: 'url', label: 'Feed' }, { key: 'mode', label: 'Mode' }, { key: 'checked', label: 'Last checked', hideOnMobile: true }, { key: 'x', label: 'Actions', srOnly: true }]}
          rows={feeds.map((f) => ({
            url: <><span class="ml-url">{f.title || f.url}</span>{f.last_error ? <p class="field-error">{f.last_error}</p> : null}</>,
            mode: <Pill tone={f.status === 'paused' ? 'warn' : f.mode === 'send' ? 'solid' : 'neutral'}>{f.status === 'paused' ? 'Paused' : f.mode === 'send' ? 'Sends automatically' : 'Makes drafts'}</Pill>,
            checked: f.last_checked_at ? timeAgo(f.last_checked_at) : 'Not yet',
            x: write ? (
              <div class="ml-actions">
                <form method="post" action={`${HOME}/feeds/${f.id}/check`}><Button type="submit" size="sm">Check now</Button></form>
                <form method="post" action={`${HOME}/feeds/${f.id}/${f.status === 'paused' ? 'resume' : 'pause'}`}><Button type="submit" size="sm">{f.status === 'paused' ? 'Resume' : 'Pause'}</Button></form>
                <form method="post" action={`${HOME}/feeds/${f.id}/delete`}><ConfirmButton id={`rm-${f.id}`} title="Remove this feed?" body="Drafts it already made stay." confirmLabel="Remove" size="sm" danger>Remove</ConfirmButton></form>
              </div>
            ) : '',
          }))}
          empty={<EmptyState icon="rss" title="No feeds yet" body="Add the address of a feed below." bare />} />
      </Card>
      {write && lists.length ? (
        <Card title="Add a feed" class="ml-gap">
          <form novalidate method="post" action={`${HOME}/feeds`} class="ml-form-col">
            <Field id="r-url" label="Feed address" error={errors.url} hint="Starts with https://."><Input id="r-url" name="url" type="url" value={values.url ?? ''} invalid={!!errors.url} placeholder="https://example.com/feed.xml" /></Field>
            <Field id="r-list" label="Newsletter"><Select id="r-list" name="list_id" value={values.list_id ?? lists[0]!.id} options={lists.map((l) => ({ value: l.id, label: l.name }))} /></Field>
            <Field id="r-mode" label="What to do with new posts"><Select id="r-mode" name="mode" value={values.mode ?? 'draft'} options={[{ value: 'draft', label: 'Make a draft for me to review' }, { value: 'send', label: 'Send automatically' }]} /></Field>
            <div class="ml-actions"><Button type="submit" variant="primary">Add feed</Button></div>
          </form>
        </Card>
      ) : write ? <Callout tone="info" title="Create a newsletter first" actions={<LinkButton href={`${HOME}/lists`}>Create newsletter</LinkButton>}>Feeds send to a newsletter.</Callout> : null}
    </>
  ), undefined, status);
}

moreScreens.get('/feeds', (c) => guard(c, 'RSS to email', () => feedsPage(c)));

moreScreens.post('/feeds', async (c) => {
  writer(c);
  const f = await readForm(c);
  try {
    await addFeed(reqCtx(c), { list_id: text(f, 'list_id'), url: text(f, 'url'), mode: text(f, 'mode') || 'draft' });
  } catch (e) {
    const { message, fields } = plainError(e);
    return feedsPage(c, { url: fields.url ?? fields.list_id ?? message }, valuesOf(f), 422);
  }
  return flashAndGo(c, 'ok', 'Feed added. Current posts are noted so only new ones are emailed.', `${HOME}/feeds`);
});
moreScreens.post('/feeds/:id/check', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const feed = (await listFeeds(ctx)).find((f) => f.id === c.req.param('id'));
  if (!feed) return flashAndGo(c, 'error', 'That feed no longer exists.', `${HOME}/feeds`);
  try {
    const r = await checkFeed(ctx, feed);
    return flashAndGo(c, 'ok', r.added ? `${r.added} new ${r.added === 1 ? 'post' : 'posts'} found.` : 'No new posts.', `${HOME}/feeds`);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, `${HOME}/feeds`);
  }
});
moreScreens.post('/feeds/:id/pause', async (c) => { writer(c); await setFeedStatus(reqCtx(c), c.req.param('id'), 'paused'); return flashAndGo(c, 'ok', 'Feed paused.', `${HOME}/feeds`); });
moreScreens.post('/feeds/:id/resume', async (c) => { writer(c); await setFeedStatus(reqCtx(c), c.req.param('id'), 'active'); return flashAndGo(c, 'ok', 'Feed resumed.', `${HOME}/feeds`); });
moreScreens.post('/feeds/:id/delete', async (c) => { writer(c); await removeFeed(reqCtx(c), c.req.param('id')); return flashAndGo(c, 'ok', 'Feed removed.', `${HOME}/feeds`); });

// -- stats -----------------------------------------------------------------------------------------

moreScreens.get('/stats', (c) =>
  safely(c, 'Stats', async () => {
    const ctx = reqCtx(c);
    const [t, g, lists] = await Promise.all([totals(ctx), growth(ctx, { days: 30 }), listLists(ctx)]);
    const joined = g.reduce((n, d) => n + d.joined, 0);
    const left = g.reduce((n, d) => n + d.left, 0);
    return (
      <>
        <PageHeader title="Stats" description="How your audience is growing. Opens and clicks are per email, on each email's stats page." />
        <StatGrid>
          <Stat label="Subscribers" value={formatNumber(t.active)} />
          <Stat label="Joined, 30 days" value={formatNumber(joined)} />
          <Stat label="Left, 30 days" value={formatNumber(left)} />
          <Stat label="Blocked addresses" value={formatNumber(t.suppressed)} href={`${HOME}/deliverability`} />
        </StatGrid>
        <Card title="New subscribers per day" class="ml-gap">
          {t.subscribers === 0 ? <EmptyState icon="chart" title="Nothing to chart yet" body="Numbers appear once people join." bare /> : <BarChart title="New subscribers per day, last 30 days" data={g.map((d) => ({ label: d.day.slice(5), value: d.joined }))} />}
        </Card>
        <Card title="By newsletter" flush class="ml-gap">
          <Table caption="Subscribers by newsletter" columns={[{ key: 'n', label: 'Newsletter' }, { key: 'a', label: 'Subscribed', numeric: true }, { key: 'p', label: 'Waiting', numeric: true }]}
            rows={lists.map((l) => ({ n: l.name, a: formatNumber(l.active), p: formatNumber(l.pending) }))}
            empty={<EmptyState icon="list" title="No newsletters yet" bare />} />
        </Card>
      </>
    );
  }),
);

// -- deliverability --------------------------------------------------------------------------------

async function deliverabilityPage(c: import('hono').Context<AppEnv>, report?: { added: number; already: number; invalid: number; total: number }, error?: string, status?: 422) {
  const ctx = reqCtx(c);
  const [mail, counts, rows] = await Promise.all([emailStatus(c.env), countSuppressions(ctx), listSuppressions(ctx, { limit: 50 })]);
  const write = canWrite(c);
  const tone = mail.mode === 'live' ? 'good' : mail.mode === 'dev' ? 'warn' : 'bad';
  return page(c, 'Deliverability', (
    <>
      <PageHeader title="Deliverability" description="Whether your email can be sent, and who is blocked." />
      <Callout tone={tone} title={mail.mode === 'live' ? 'Email is set up' : mail.mode === 'dev' ? 'Email is in test mode' : 'Email is not set up'} actions={<LinkButton href="/app/email" size="sm">Open email settings</LinkButton>}>
        {mail.mode === 'live' ? 'Mail sends through the sender you set up on the Email screen.' : mail.mode === 'dev' ? 'Messages are written to the log, not delivered.' : mail.reason ?? 'Set up a sender to send.'}
      </Callout>
      <Callout tone="warn" title="No automatic bounce or complaint feedback yet">Your email provider does not tell Mail when a message bounces or gets marked as spam. Until that exists, block addresses by hand, import a list of bounced addresses below, or post them to the API. Check your provider&#39;s dashboard now and then.</Callout>
      <Card title="Before you send" class="ml-gap">
        <ul class="ml-plain">
          <li>Authenticate your sending domain with SPF, DKIM and DMARC. Your provider shows the records.</li>
          <li>Send to people who asked. Confirmation by email is on by default.</li>
          <li>Keep a real postal address in the footer. Set it in settings.</li>
          <li>Warm up slowly. Start with small sends to your most engaged people.</li>
          <li>Your workspace can send up to {formatNumber(HOURLY_CAP)} emails an hour; larger sends continue over several hours on their own.</li>
        </ul>
      </Card>
      <StatGrid>
        <Stat label="Bounced" value={formatNumber(counts.bounced ?? 0)} />
        <Stat label="Complaints" value={formatNumber(counts.complaint ?? 0)} />
        <Stat label="Unsubscribed" value={formatNumber(counts.unsubscribed ?? 0)} />
      </StatGrid>
      <Card title="Blocked addresses" flush class="ml-gap">
        <Table caption="Blocked addresses" columns={[{ key: 'email', label: 'Address' }, { key: 'reason', label: 'Reason' }, { key: 'when', label: 'When', hideOnMobile: true }, { key: 'x', label: 'Actions', srOnly: true }]}
          rows={rows.map((r) => ({ email: r.email, reason: <Pill tone={r.reason === 'unsubscribed' ? 'neutral' : 'bad'}>{r.reason}</Pill>, when: timeAgo(r.created_at), x: write ? <form method="post" action={`${HOME}/deliverability/${r.id}/remove`}><ConfirmButton id={`un-${r.id}`} title="Allow this address again?" body="Only do this if the person asked to hear from you again." confirmLabel="Allow again" size="sm">Allow again</ConfirmButton></form> : '' }))}
          empty={<EmptyState icon="shield" title="No blocked addresses" body="Bounced, complained and unsubscribed addresses show up here." bare />} />
      </Card>
      {write ? (
        <Card title="Import bounced addresses" description={`Paste up to ${BOUNCE_IMPORT_MAX} addresses, one per line or separated by commas.`} class="ml-gap">
          {report ? <Callout tone="good" title={`${report.added} blocked`}>{report.already} were already blocked and {report.invalid} were not valid addresses.</Callout> : null}
          <form method="post" action={`${HOME}/deliverability/bounced`} class="ml-form-col">
            <Field id="bn" label="Addresses" error={error}><Textarea id="bn" name="addresses" rows={5} invalid={!!error} placeholder="gone@example.com" /></Field>
            <div class="ml-actions"><Button type="submit">Block these addresses</Button></div>
          </form>
        </Card>
      ) : null}
    </>
  ), undefined, status);
}

moreScreens.get('/deliverability', (c) => guard(c, 'Deliverability', () => deliverabilityPage(c)));

moreScreens.post('/deliverability/bounced', async (c) => {
  writer(c);
  const f = await readForm(c);
  const list = text(f, 'addresses').split(/[\s,;]+/).filter(Boolean);
  if (list.length === 0) return deliverabilityPage(c, undefined, 'Paste at least one address.', 422);
  const report = await importBounced(reqCtx(c), list);
  await auditFromRequest(c, { action: 'mail.suppression.import', targetType: 'mail', targetId: undefined, summary: `Blocked ${report.added} bounced addresses` });
  return deliverabilityPage(c, report);
});

moreScreens.post('/deliverability/:id/remove', async (c) => {
  writer(c);
  await removeSuppression(reqCtx(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'mail.suppression.remove', targetType: 'mail_suppression', targetId: c.req.param('id'), summary: 'Allowed a blocked address again' });
  return flashAndGo(c, 'ok', 'Address allowed again.', `${HOME}/deliverability`);
});

// -- settings --------------------------------------------------------------------------------------

async function settingsPage(c: import('hono').Context<AppEnv>, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const s = await getMailSettings(c.env, reqCtx(c).org.id);
  const write = canWrite(c);
  const v = (k: string, d: string) => (k in values ? values[k]! : d);
  return page(c, 'Settings', (
    <>
      <PageHeader title="Settings" description="Defaults for every email you send from Mail." />
      <Card>
        <form method="post" action={`${HOME}/settings`} class="ml-form-col">
          <Field id="postal" label="Postal address" error={errors.postal} hint="Shown in the footer of every newsletter. Most countries require it."><Textarea id="postal" name="postal" rows={3} value={v('postal', s.postalAddress)} invalid={!!errors.postal} disabled={!write} /></Field>
          <Checkbox name="track_opens" value="1" label="Count opens by default" description="Off by default. Adds a tiny image to emails, and the footer says so." checked={values.postal !== undefined ? values.track_opens === '1' : s.trackOpens} disabled={!write} />
          <Checkbox name="track_clicks" value="1" label="Count clicks by default" description="Off by default. Links pass through your install first, and the footer says so." checked={values.postal !== undefined ? values.track_clicks === '1' : s.trackClicks} disabled={!write} />
          {write ? <div class="ml-actions"><Button type="submit" variant="primary">Save settings</Button></div> : null}
        </form>
      </Card>
      <Card title="Sample data" class="ml-gap"><p class="muted ml-small">Sample data is marked and can be cleared from the Home screen of your workspace without touching real subscribers.</p></Card>
    </>
  ), undefined, status);
}

moreScreens.get('/settings', (c) => guard(c, 'Settings', () => settingsPage(c)));
moreScreens.post('/settings', async (c) => {
  writer(c);
  const f = await readForm(c);
  const postal = text(f, 'postal');
  if (postal && postal.length < 8) return settingsPage(c, { postal: 'Enter your full postal address.' }, { ...valuesOf(f), track_opens: checked(f, 'track_opens') ? '1' : '', track_clicks: checked(f, 'track_clicks') ? '1' : '' }, 422);
  await saveMailSettings(c.env, reqCtx(c).org.id, { postalAddress: postal, trackOpens: checked(f, 'track_opens'), trackClicks: checked(f, 'track_clicks') });
  return flashAndGo(c, 'ok', 'Saved.', `${HOME}/settings`);
});
