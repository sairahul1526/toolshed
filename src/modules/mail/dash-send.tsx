/** Broadcasts: the home screen, the editor, the preview and the numbers for one email. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { emailStatus } from '../../core/email';
import { baseUrl } from '../../core/net';
import { enforceRateLimit } from '../../core/ratelimit';
import {
  Button, Callout, Card, Checkbox, ConfirmButton, EmptyState, Field, Input, LinkButton, PageHeader, Pagination, Pill, Select, Stat, StatGrid, Table, Textarea, formatDateTime, formatNumber, timeAgo,
} from '../../ui';
import { checkBroadcast, createBroadcast, deleteBroadcast, duplicateBroadcast, filterOf, getBroadcast, listBroadcasts, previewBroadcast, sendTest, updateBroadcast } from './broadcasts';
import { pauseBroadcast, resumeBroadcast, scheduleBroadcast, startBroadcast, unscheduleBroadcast } from './engine';
import { describeFilter, EMPTY_FILTER } from './segments';
import { getMailSettings } from './settings';
import { getSegment, listLists, listSegments } from './lists';
import { broadcastStats } from './stats';
import { totals } from './stats';
import { querySubscribers } from './subscribers';
import { reqCtx, rememberBase } from './request';
import type { Broadcast, BroadcastStatus } from './types';
import { canWrite, checked, flashAndGo, fromUtcLocal, HOME, page, plainError, raw, readForm, safely, text, utcLocal, valuesOf, writer } from './dash-shared';

export const sendScreens = new Hono<AppEnv>();

const STATUS: Record<BroadcastStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'solid' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'warn' },
  sending: { label: 'Sending', tone: 'solid' },
  paused: { label: 'Paused', tone: 'warn' },
  sent: { label: 'Sent', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
};

export const StatusPill = ({ status }: { status: BroadcastStatus }) => <Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>;

// -- home ------------------------------------------------------------------------------------------

sendScreens.get('/', (c) =>
  safely(c, 'Broadcasts', async () => {
    const ctx = reqCtx(c);
    const pageNo = Math.max(1, Number(c.req.query('page')) || 1);
    const status = c.req.query('status') ?? '';
    const [lists, t, settings, mail, out] = await Promise.all([
      listLists(ctx),
      totals(ctx),
      getMailSettings(c.env, ctx.org.id),
      emailStatus(c.env),
      listBroadcasts(ctx, { status: status || undefined, limit: 20, offset: (pageNo - 1) * 20 }),
    ]);
    const write = canWrite(c);
    const steps = [
      { done: mail.mode !== 'off', title: 'Check that email can be sent', body: mail.mode === 'live' ? 'Your install sends real email.' : mail.mode === 'dev' ? 'This install is in test mode, so emails are saved instead of sent.' : 'Email is not set up yet. Mail cannot send until it is.', action: <LinkButton href="/app/email" size="sm">{mail.mode === 'off' ? 'Set up email' : 'Open email settings'}</LinkButton> },
      { done: lists.length > 0 && !!settings.postalAddress.trim(), title: 'Name your newsletter and add a postal address', body: 'People sign up on a page we host. Most countries need a real postal address in every email.', action: <LinkButton href={`${HOME}/lists`} size="sm">{lists.length ? 'Add your address' : 'Create newsletter'}</LinkButton> },
      { done: t.broadcasts > 0, title: 'Write your first issue', body: 'Start with Markdown. Send yourself a test before it goes to anyone else.', action: lists.length ? <LinkButton href={`${HOME}/new`} variant="primary" size="sm">Write an email</LinkButton> : null },
    ];
    const first = !settings.firstRunDone && (t.broadcasts === 0 || steps.some((s) => !s.done));
    return (
      <>
        <PageHeader
          title="Broadcasts"
          description="One-off emails to a newsletter. Welcome emails and product emails have their own screens."
          actions={write && lists.length ? <LinkButton href={`${HOME}/new`} variant="primary" icon="plus">New email</LinkButton> : null}
        />
        {mail.mode === 'off' ? <Callout tone="warn" title="Email sending is off" actions={<LinkButton href="/app/email" size="sm">Open the email screen</LinkButton>}>{mail.reason}</Callout> : null}
        {first ? (
          <Card title="Get set up in three steps" class="ml-gap">
            <ol class="ml-steps">
              {steps.map((s, i) => (
                <li class={s.done ? 'is-done' : ''}>
                  <span class="ml-step-n" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
                  <div><strong>{s.title}</strong><p class="muted ml-small">{s.body}</p></div>
                  {write ? s.action : null}
                </li>
              ))}
            </ol>
          </Card>
        ) : null}
        <StatGrid>
          <Stat label="Subscribers" value={formatNumber(t.active)} href={`${HOME}/subscribers`} />
          <Stat label="Waiting to confirm" value={formatNumber(t.pending)} href={`${HOME}/subscribers?status=pending`} />
          <Stat label="Unsubscribed" value={formatNumber(t.unsubscribed)} />
          <Stat label="Emails" value={formatNumber(t.broadcasts)} />
        </StatGrid>
        <nav class="ml-filter" aria-label="Filter by status">
          {['', 'draft', 'scheduled', 'sending', 'sent'].map((s) => (
            <a class={s === status ? 'chip is-on' : 'chip'} href={s ? `${HOME}?status=${s}` : HOME} aria-current={s === status ? 'true' : undefined}>{s ? STATUS[s as BroadcastStatus].label : 'All'}</a>
          ))}
        </nav>
        <Card flush>
          <Table
            caption="Broadcasts"
            columns={[
              { key: 'subject', label: 'Email' },
              { key: 'status', label: 'Status' },
              { key: 'list', label: 'Newsletter', hideOnMobile: true },
              { key: 'sent', label: 'Sent', numeric: true, hideOnMobile: true },
              { key: 'when', label: 'When', hideOnMobile: true },
            ]}
            rows={out.items.map((b) => ({
              subject: <a class="ml-name" href={b.status === 'draft' ? `${HOME}/b/${b.id}` : `${HOME}/b/${b.id}/stats`}>{b.subject || 'Untitled'}</a>,
              status: <StatusPill status={b.status} />,
              list: lists.find((l) => l.id === b.list_id)?.name ?? 'Deleted',
              sent: b.status === 'draft' ? '' : `${formatNumber(b.sent_count)} of ${formatNumber(b.total)}`,
              when: b.status === 'scheduled' && b.scheduled_at ? formatDateTime(b.scheduled_at) : timeAgo(b.finished_at ?? b.updated_at),
            }))}
            empty={
              <EmptyState
                icon="mail"
                title="No emails yet"
                body="Write your first issue, send yourself a test, then send it to your subscribers."
                actions={write && lists.length ? <LinkButton href={`${HOME}/new`} variant="primary">Write an email</LinkButton> : write ? <LinkButton href={`${HOME}/lists`} variant="primary">Create a newsletter first</LinkButton> : null}
                bare
              />
            }
          />
        </Card>
        {out.total > 20 ? <Pagination page={pageNo} pageSize={20} total={out.total} href={(p) => `${HOME}?page=${p}${status ? `&status=${status}` : ''}`} noun={['email', 'emails']} /> : null}
      </>
    );
  }),
);

// -- new and edit ----------------------------------------------------------------------------------

sendScreens.get('/new', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const lists = await listLists(ctx);
  if (lists.length === 0) return flashAndGo(c, 'info', 'Create a newsletter first, then write an email for it.', `${HOME}/lists`);
  const settings = await getMailSettings(c.env, ctx.org.id);
  const b = await createBroadcast(ctx, { list_id: c.req.query('list') || lists[0]!.id, track_opens: settings.trackOpens, track_clicks: settings.trackClicks });
  return c.redirect(`${HOME}/b/${b.id}`, 303);
});

async function editor(c: import('hono').Context<AppEnv>, b: Broadcast, errors: Record<string, string> = {}, values: Record<string, string> = {}, status?: 422) {
  const ctx = reqCtx(c);
  const [lists, segments, check, mail] = await Promise.all([listLists(ctx), listSegments(ctx), checkBroadcast(ctx, b), emailStatus(c.env)]);
  const locked = !['draft', 'scheduled'].includes(b.status);
  const v = (k: string, d: string) => (k in values ? values[k]! : d);
  const write = canWrite(c);
  const filter = filterOf(b);
  const levelTone = { ok: 'good', warn: 'warn', block: 'bad' } as const;
  return page(c, b.subject || 'New email', (
    <>
      <PageHeader
        title={b.subject || 'New email'}
        soft={<StatusPill status={b.status} />}
        actions={
          <>
            <LinkButton href={`${HOME}/b/${b.id}/preview`} target="_blank" rel="noopener" icon="eye">Preview</LinkButton>
            {b.status !== 'draft' ? <LinkButton href={`${HOME}/b/${b.id}/stats`}>Stats</LinkButton> : null}
          </>
        }
      />
      {locked ? <Callout tone="info" title="This email can’t be edited">It has gone out or is sending. You can duplicate it to send a new version.</Callout> : null}
      {b.status === 'scheduled' && b.scheduled_at ? <Callout tone="info" title={`Scheduled for ${formatDateTime(b.scheduled_at)} UTC`}>You can still edit it until it starts.</Callout> : null}
      <div class="ml-editor">
        <form method="post" action={`${HOME}/b/${b.id}`} class="ml-form-col" data-ml-editor>
          <Card title="Email">
            <Field id="list_id" label="Newsletter">
              <Select id="list_id" name="list_id" value={v('list_id', b.list_id)} options={lists.map((l) => ({ value: l.id, label: `${l.name} (${l.active})` }))} disabled={locked} />
            </Field>
            <Field id="subject" label="Subject" error={errors.subject}>
              <Input id="subject" name="subject" value={v('subject', b.subject)} maxlength={200} invalid={!!errors.subject} disabled={locked} placeholder="Say what is inside" />
            </Field>
            <Field id="preheader" label="Preview text" optional hint="The grey line next to the subject in most inboxes.">
              <Input id="preheader" name="preheader" value={v('preheader', b.preheader)} maxlength={200} disabled={locked} />
            </Field>
            <Field id="format" label="Format">
              <Select id="format" name="format" value={v('format', b.format)} options={[{ value: 'markdown', label: 'Markdown (recommended)' }, { value: 'html', label: 'Raw HTML' }]} disabled={locked} />
            </Field>
            <div class="ml-toolbar" role="toolbar" aria-label="Formatting" data-ml-toolbar>
              {[['bold', 'Bold'], ['italic', 'Italic'], ['heading', 'Heading'], ['link', 'Link'], ['button', 'Button'], ['image', 'Image'], ['divider', 'Divider'], ['tag', 'Insert name']].map(([k, l]) => (
                <button type="button" class="btn sm" data-ml-fmt={k} disabled={locked}>{l}</button>
              ))}
            </div>
            <Field id="body" label="Body" error={errors.body} hint="Use {{first_name|there}} to add a name with a fallback. A button is ::button[Label](https://example.com).">
              <Textarea id="body" name="body" rows={16} value={v('body', b.body)} invalid={!!errors.body} disabled={locked} class="ml-body" spellcheck />
            </Field>
          </Card>
          <Card title="Who gets it">
            {segments.length ? (
              <Field id="segment" label="Only send to a segment" optional hint="Leave empty to send to everyone confirmed on the newsletter.">
                <Select id="segment" name="segment" value={v('segment', filter.rules.length ? 'keep' : '')} options={[{ value: '', label: 'Everyone on the newsletter' }, ...(filter.rules.length ? [{ value: 'keep', label: `Keep current filter: ${describeFilter(filter)}` }] : []), ...segments.map((s) => ({ value: s.id, label: s.name }))]} disabled={locked} />
              </Field>
            ) : <p class="muted ml-small">Everyone confirmed on the newsletter gets this. <a href={`${HOME}/segments`}>Create a segment</a> to send to part of it.</p>}
            <Checkbox name="track_opens" value="1" label="Count opens" description="Adds a tiny image. Subscribers are told in the footer." checked={v('track_opens', String(b.track_opens)) === '1' || v('track_opens', '') === '1'} disabled={locked} />
            <Checkbox name="track_clicks" value="1" label="Count clicks" description="Links go through your install first. Subscribers are told in the footer." checked={v('track_clicks', String(b.track_clicks)) === '1' || v('track_clicks', '') === '1'} disabled={locked} />
            <Checkbox name="in_archive" value="1" label="Show in the public archive after it is sent" checked={v('in_archive', String(b.in_archive)) === '1' || v('in_archive', '') === '1'} disabled={locked} />
          </Card>
          {write && !locked ? <div class="ml-actions"><Button type="submit" variant="primary" name="action" value="save">Save</Button></div> : null}
        </form>
        <aside class="ml-side">
          <Card title="Before you send" description={check.ready ? 'Nothing blocks this email.' : 'Fix the red items first.'}>
            <ul class="ml-check">
              {check.items.map((i) => (
                <li class={`is-${i.level}`}>
                  <Pill tone={levelTone[i.level]}>{i.level === 'ok' ? 'Ready' : i.level === 'warn' ? 'Check' : 'Fix'}</Pill>
                  <div><strong>{i.title}</strong>{i.detail ? <p class="muted ml-small">{i.detail}</p> : null}</div>
                </li>
              ))}
            </ul>
            <p class="muted ml-small">{formatNumber(check.audience)} {check.audience === 1 ? 'person' : 'people'} will get this.{check.hours > 1 ? ` About ${check.hours} hours to send.` : ''}</p>
          </Card>
          {write ? (
            <Card title="Send">
              <form method="post" action={`${HOME}/b/${b.id}/test`} class="ml-stack">
                <Field id="to" label="Send a test to" error={errors.to}>
                  <Input id="to" name="to" type="email" value={v('to', '')} placeholder="you@example.com" invalid={!!errors.to} autocomplete="email" />
                </Field>
                <Button type="submit" disabled={mail.mode === 'off'}>Send test</Button>
              </form>
              {b.status === 'draft' || b.status === 'scheduled' ? (
                <>
                  <form method="post" action={`${HOME}/b/${b.id}/schedule`} class="ml-stack ml-gap">
                    <Field id="when" label="Schedule for (UTC)" error={errors.when}>
                      <Input id="when" name="when" type="datetime-local" value={v('when', b.scheduled_at ? utcLocal(b.scheduled_at) : utcLocal(Date.now() + 86_400_000))} invalid={!!errors.when} />
                    </Field>
                    <div class="ml-actions">
                      <Button type="submit" disabled={!check.ready}>{b.status === 'scheduled' ? 'Change time' : 'Schedule'}</Button>
                      {b.status === 'scheduled' ? <Button type="submit" formaction={`${HOME}/b/${b.id}/unschedule`}>Unschedule</Button> : null}
                    </div>
                  </form>
                  <form method="post" action={`${HOME}/b/${b.id}/send`} class="ml-gap">
                    <ConfirmButton id="send-now" title="Send to everyone now?" body={`${formatNumber(check.audience)} ${check.audience === 1 ? 'person' : 'people'} will get this email. You can’t take it back.`} confirmLabel="Send now" danger={false} variant="default">Send now</ConfirmButton>
                  </form>
                </>
              ) : null}
              {b.status === 'sending' ? <form method="post" action={`${HOME}/b/${b.id}/pause`}><Button type="submit">Pause sending</Button></form> : null}
              {b.status === 'paused' ? <form method="post" action={`${HOME}/b/${b.id}/resume`}><Button type="submit" variant="primary">Resume sending</Button></form> : null}
            </Card>
          ) : null}
          {write ? (
            <Card>
              <div class="ml-actions">
                <form method="post" action={`${HOME}/b/${b.id}/duplicate`}><Button type="submit" size="sm">Duplicate</Button></form>
                {b.status !== 'sending' ? (
                  <form method="post" action={`${HOME}/b/${b.id}/delete`}>
                    <ConfirmButton id="del-b" title="Delete this email?" body="Its stats are removed too. Emails already delivered stay in inboxes." confirmLabel="Delete email" size="sm">Delete</ConfirmButton>
                  </form>
                ) : null}
              </div>
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  ), [{ label: 'Mail', href: HOME }, { label: b.subject || 'New email' }], status);
}

sendScreens.get('/b/:id', async (c) => {
  const b = await getBroadcast(reqCtx(c), c.req.param('id'));
  return editor(c, b);
});

async function filterFrom(c: import('hono').Context<AppEnv>, f: Record<string, unknown>): Promise<unknown> {
  if (!('segment' in f) || f.segment === 'keep') return undefined;
  if (!f.segment) return EMPTY_FILTER;
  return (await getSegment(reqCtx(c), String(f.segment))).parsed;
}

sendScreens.post('/b/:id', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const id = c.req.param('id');
  const f = await readForm(c);
  const b = await getBroadcast(ctx, id);
  try {
    const filter = await filterFrom(c, f);
    await updateBroadcast(ctx, id, {
      list_id: text(f, 'list_id') || b.list_id,
      subject: text(f, 'subject'),
      preheader: text(f, 'preheader'),
      format: text(f, 'format') === 'html' ? 'html' : 'markdown',
      body: raw(f, 'body'),
      ...(filter ? { filter } : {}),
      track_opens: checked(f, 'track_opens'),
      track_clicks: checked(f, 'track_clicks'),
      in_archive: checked(f, 'in_archive'),
    });
  } catch (e) {
    const { message, fields } = plainError(e);
    return editor(c, b, { ...fields, ...(Object.keys(fields).length ? {} : { subject: message }) }, valuesOf(f), 422);
  }
  return flashAndGo(c, 'ok', 'Saved.', `${HOME}/b/${id}`);
});

sendScreens.post('/b/:id/test', async (c) => {
  writer(c);
  const ctx = reqCtx(c);
  const id = c.req.param('id');
  const f = await readForm(c);
  const b = await getBroadcast(ctx, id);
  try {
    await enforceRateLimit(c.env, `mail.test:${ctx.org.id}`, { limit: 20, windowSec: 3600 }, 'You sent a lot of tests. Try again in a while.');
    await sendTest(ctx, id, text(f, 'to'), await rememberBase(c));
  } catch (e) {
    const { message, fields } = plainError(e);
    return editor(c, b, { to: fields.to ?? message }, valuesOf(f), 422);
  }
  return flashAndGo(c, 'ok', `A test went to ${text(f, 'to')}.`, `${HOME}/b/${id}`);
});

async function act(c: import('hono').Context<AppEnv>, label: string, run: (id: string) => Promise<unknown>, done: string, after?: (id: string) => string) {
  writer(c);
  const id = c.req.param('id') as string;
  try {
    await run(id);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, `${HOME}/b/${id}`);
  }
  await auditFromRequest(c, { action: `mail.broadcast.${label}`, targetType: 'mail_broadcast', targetId: id, summary: done });
  return flashAndGo(c, 'ok', done, after ? after(id) : `${HOME}/b/${id}`);
}

sendScreens.post('/b/:id/send', (c) => act(c, 'send', (id) => startBroadcast(reqCtx(c), id), 'Sending started. You can close this page.', (id) => `${HOME}/b/${id}/stats`));
sendScreens.post('/b/:id/pause', (c) => act(c, 'pause', (id) => pauseBroadcast(reqCtx(c), id), 'Sending paused.'));
sendScreens.post('/b/:id/resume', (c) => act(c, 'resume', (id) => resumeBroadcast(reqCtx(c), id), 'Sending resumed.', (id) => `${HOME}/b/${id}/stats`));
sendScreens.post('/b/:id/unschedule', (c) => act(c, 'unschedule', (id) => unscheduleBroadcast(reqCtx(c), id), 'Schedule removed.'));
sendScreens.post('/b/:id/schedule', async (c) => {
  writer(c);
  const f = await readForm(c);
  const at = fromUtcLocal(text(f, 'when'));
  const id = c.req.param('id');
  if (!Number.isFinite(at) || at < Date.now() + 60_000) {
    const b = await getBroadcast(reqCtx(c), id);
    return editor(c, b, { when: 'Pick a time in the future, in UTC.' }, valuesOf(f), 422);
  }
  return act(c, 'schedule', (i) => scheduleBroadcast(reqCtx(c), i, at), `Scheduled for ${formatDateTime(at)} UTC.`);
});
sendScreens.post('/b/:id/duplicate', async (c) => {
  writer(c);
  const copy = await duplicateBroadcast(reqCtx(c), c.req.param('id'));
  return flashAndGo(c, 'ok', 'Duplicated as a new draft.', `${HOME}/b/${copy.id}`);
});
sendScreens.post('/b/:id/delete', async (c) => {
  writer(c);
  try {
    await deleteBroadcast(reqCtx(c), c.req.param('id'));
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, `${HOME}/b/${c.req.param('id')}`);
  }
  return flashAndGo(c, 'ok', 'Email deleted.', HOME);
});

// -- preview ---------------------------------------------------------------------------------------

/** The email itself, opened in its own tab. A sandbox policy keeps scripts out even if one slipped through. */
sendScreens.get('/b/:id/preview', async (c) => {
  const ctx = reqCtx(c);
  const q = c.req.query('as')?.trim().toLowerCase();
  let subscriberId: string | undefined;
  if (q) subscriberId = (await querySubscribers(ctx, { q, limit: 1 })).items[0]?.id;
  const p = await previewBroadcast(ctx, c.req.param('id'), { base: baseUrl(c), ...(subscriberId ? { subscriberId } : {}) });
  const bar = `<div style="font:14px system-ui;padding:8px 12px;background:#f4f4f5;color:#111;border-bottom:1px solid #ddd">Preview as ${p.who.replace(/[<>&"]/g, '')}. Subject: ${p.subject.replace(/[<>&"]/g, '')}</div>`;
  return new Response(bar + p.html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'", 'cache-control': 'no-store' },
  });
});

// -- stats for one email ---------------------------------------------------------------------------

sendScreens.get('/b/:id/stats', (c) =>
  safely(c, 'Email stats', async () => {
    const ctx = reqCtx(c);
    const b = await getBroadcast(ctx, c.req.param('id'));
    const s = await broadcastStats(ctx, b);
    const pct = (n: number) => (s.sent ? `${Math.round((n / s.sent) * 1000) / 10}%` : '0%');
    const working = b.status === 'sending' || b.status === 'scheduled';
    return (
      <>
        <PageHeader title={b.subject || 'Untitled'} soft={<StatusPill status={b.status} />} actions={<LinkButton href={`${HOME}/b/${b.id}`}>{b.status === 'draft' ? 'Edit' : 'Open'}</LinkButton>} />
        {working ? <Callout tone="info" title="Sending is in progress">This page does not refresh itself. Reload to see new numbers. You can close it; sending carries on.</Callout> : null}
        {b.status === 'paused' ? <Callout tone="warn" title="Sending is paused">{b.last_error || 'Resume it when you are ready.'}</Callout> : null}
        {b.status === 'failed' ? <Callout tone="bad" title="Sending stopped">{b.last_error || 'Too many messages could not be delivered.'}</Callout> : null}
        <StatGrid>
          <Stat label="Sent" value={formatNumber(s.sent)} note={`of ${formatNumber(s.total)}`} />
          <Stat label="Waiting" value={formatNumber(s.queued)} />
          <Stat label="Failed or skipped" value={formatNumber(s.failed + s.skipped)} note="Skipped means unsubscribed or blocked" />
          <Stat label="Unsubscribed after" value={formatNumber(s.unsubscribed)} />
        </StatGrid>
        {s.tracking.opens || s.tracking.clicks ? (
          <StatGrid label="Engagement">
            {s.tracking.opens ? <Stat label="Opened" value={pct(s.opened)} note={`${formatNumber(s.opened)} people. Open counts are rough: some apps load images on their own.`} /> : null}
            {s.tracking.clicks ? <Stat label="Clicked" value={pct(s.clicked)} note={`${formatNumber(s.clicked)} people`} /> : null}
          </StatGrid>
        ) : <Callout tone="info" title="Tracking was off for this email">Mail only counts opens and clicks when you switch it on in the editor.</Callout>}
        {s.tracking.clicks ? (
          <Card title="Links" flush>
            <Table caption="Link clicks" columns={[{ key: 'url', label: 'Link' }, { key: 'clicks', label: 'Clicks', numeric: true }]} rows={s.links.map((l) => ({ url: <span class="ml-url">{l.url}</span>, clicks: formatNumber(l.clicks) }))} empty={<EmptyState icon="link" title="No clicks yet" bare />} />
          </Card>
        ) : null}
      </>
    );
  }),
);
