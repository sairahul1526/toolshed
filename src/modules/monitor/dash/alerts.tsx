/** Alert channels: list, add, edit, test, delete. */
import { Hono } from 'hono';
import { parseJson } from '../../../core/db';
import type { AppEnv } from '../../../env';
import { Button, Card, ConfirmButton, EmptyState, LinkButton, PageHeader, Pill, Table, renderPage, timeAgo } from '../../../ui';
import { testChannel } from '../alerts';
import { type ChannelConfig, channelView, createChannel, deleteChannel, getChannel, listChannels, updateChannel } from '../channels';
import { workspaceZone } from '../maintenance';
import { CHANNEL_KINDS, type ChannelKind } from '../schema';
import { Assets, BASE, Back, KIND_LABEL, Problems, TextField, Toggle, failed, done, mctx, on, readForm, record, text, type C, type Errors, type Values } from './common';

const app = new Hono<AppEnv>();

const HELP: Record<ChannelKind, string> = {
  email: 'We email these addresses. Up to 5, separated by commas.',
  slack: 'Create an incoming webhook in Slack and paste its address.',
  discord: 'In your channel settings, open Integrations, create a webhook and paste its address.',
  teams: 'Use the Workflows template that posts to a channel when a webhook request is received, and paste its address.',
  telegram: 'Make a bot with BotFather, add it to your chat, then paste the bot token and the chat id.',
  webhook: 'We send a JSON POST. Add a secret and we sign every request with it.',
};

const isKind = (k: string | null | undefined): k is ChannelKind => !!k && (CHANNEL_KINDS as readonly string[]).includes(k);

/** Field errors for the config come back as "config.url"; the form uses the plain name. */
const flat = (errors: Errors): Errors => {
  const out: Errors = { ...errors };
  for (const [k, v] of Object.entries(errors)) if (k.startsWith('config.')) out[k.slice(7)] = v;
  return out;
};

/* ------------------------------------------------------------ list */

app.get('/alerts', async (c) => {
  const ctx = await mctx(c);
  const rows = await listChannels(ctx);
  const last = await ctx.db.all<{ channel_id: string; outcome: string; at: number }>(
    'SELECT channel_id, outcome, at FROM mon_alerts WHERE org_id = :org AND channel_id IS NOT NULL AND at = (SELECT MAX(at) FROM mon_alerts a WHERE a.org_id = mon_alerts.org_id AND a.channel_id = mon_alerts.channel_id) LIMIT 100',
  );
  const lastBy = new Map(last.map((x) => [x.channel_id, x]));
  const me = c.get('user')?.email;
  return renderPage(
    c,
    { title: 'Alerts', crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Alerts' }] },
    <>
      <Assets />
      <PageHeader
        title="Alerts"
        description="Where we send word when a monitor goes down, comes back or turns slow."
        actions={
          <LinkButton variant="primary" icon="plus" href={`${BASE}/alerts/new`}>
            Add channel
          </LinkButton>
        }
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            bare
            icon="bell"
            title="No alert channels yet"
            body="Without one, you only find out by looking. Pick where you want to hear about problems."
            actions={
              <>
                {me ? (
                  <form method="post" action={`${BASE}/alerts/me`}>
                    <Button type="submit" variant="primary">
                      Email me
                    </Button>
                  </form>
                ) : null}
                <LinkButton href={`${BASE}/alerts/new`}>Choose another channel</LinkButton>
              </>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <Table
            caption="Alert channels"
            columns={[
              { key: 'name', label: 'Channel' },
              { key: 'sends', label: 'Sends' },
              { key: 'last', label: 'Last alert', hideOnMobile: true },
              { key: 'actions', label: 'Actions', numeric: true },
            ]}
            rows={rows.map((ch) => {
              const v = channelView(ch);
              const l = lastBy.get(ch.id);
              return {
                name: (
                  <a class="mon-name" href={`${BASE}/alerts/${ch.id}`}>
                    <b>{ch.name}</b>
                    <span class="trunc">{KIND_LABEL[ch.kind]}{v.config.to ? `, ${v.config.to.join(', ')}` : ''}</span>
                  </a>
                ),
                sends: (
                  <>
                    {ch.enabled ? <Pill tone="good">On</Pill> : <Pill>Off</Pill>} <span class="muted">{ch.notify_recovery ? 'down and recovery' : 'down only'}{ch.notify_slow ? ', slow' : ''}</span>
                  </>
                ),
                last: l ? <>{timeAgo(l.at)} <Pill tone={l.outcome === 'sent' ? 'good' : l.outcome === 'failed' ? 'bad' : 'neutral'}>{l.outcome}</Pill></> : <span class="muted">None yet</span>,
                actions: (
                  <form method="post" action={`${BASE}/alerts/${ch.id}/test`}>
                    <Button type="submit" size="sm">
                      Send a test
                    </Button>
                  </form>
                ),
              };
            })}
          />
        </Card>
      )}
    </>,
  );
});

app.post('/alerts/me', async (c) => {
  const email = c.get('user')?.email;
  if (!email) return done(c, 'We couldn’t find your email address. Add a channel instead.', `${BASE}/alerts`);
  const ctx = await mctx(c);
  try {
    const ch = await createChannel(ctx, { name: 'Email me', kind: 'email', config: { to: [email] } });
    await record(c, 'monitor.channel_created', 'channel', ch.id, `Added channel ${ch.name}`);
    return done(c, 'We’ll email you when a monitor goes down or comes back.', `${BASE}/alerts`);
  } catch (e) {
    return failed(c, e, `${BASE}/alerts`, async () => c.redirect(`${BASE}/alerts`));
  }
});

/* ------------------------------------------------------------ form */

function valuesOf(kind: ChannelKind, ch?: Awaited<ReturnType<typeof getChannel>>, zone = 'UTC'): Values {
  if (!ch) return { kind, name: '', notifyRecovery: '1', enabled: '1', notifySlow: '0', repeatMin: '0' };
  const cfg = parseJson<ChannelConfig>(ch.config, {});
  return {
    kind,
    name: ch.name,
    to: (cfg.to ?? []).join(', '),
    chatId: cfg.chatId ?? '',
    enabled: ch.enabled ? '1' : '0',
    notifyRecovery: ch.notify_recovery ? '1' : '0',
    notifySlow: ch.notify_slow ? '1' : '0',
    repeatMin: String(ch.repeat_min),
    quietFrom: ch.quiet_from ?? '',
    quietTo: ch.quiet_to ?? '',
    zone,
  };
}

async function form(c: C, o: { kind: ChannelKind; v: Values; errors?: Errors; id?: string; status?: 422 }) {
  const ctx = await mctx(c);
  const zone = await workspaceZone(c.env, ctx.db.orgId);
  const errors = flat(o.errors ?? {});
  const editing = !!o.id;
  const title = editing ? 'Edit channel' : `Add ${KIND_LABEL[o.kind]} channel`;
  return renderPage(
    c,
    { title, crumbs: [{ label: 'Monitors', href: BASE }, { label: 'Alerts', href: `${BASE}/alerts` }, { label: title }], status: o.status },
    <>
      <Assets />
      <Back href={`${BASE}/alerts`}>All channels</Back>
      <PageHeader title={title} description={HELP[o.kind]} />
      {!editing ? (
        <nav class="tabs" aria-label="Channel type">
          {CHANNEL_KINDS.map((k) => (
            <a class="tab-link" href={`${BASE}/alerts/new?kind=${k}`} aria-current={k === o.kind ? 'page' : undefined}>
              {KIND_LABEL[k]}
            </a>
          ))}
        </nav>
      ) : null}
      <form method="post" action={editing ? `${BASE}/alerts/${o.id}/edit` : `${BASE}/alerts/new`} class="stack" novalidate>
        <input type="hidden" name="kind" value={o.kind} />
        <Problems errors={errors} shown={['name', 'to', 'url', 'secret', 'botToken', 'chatId', 'repeatMin', 'quietFrom', 'quietTo']} />
        <Card title="Where it goes" ruled>
          <div class="stack">
            <TextField id="name" label="Name" v={o.v} errors={errors} maxlength={80} placeholder={o.kind === 'email' ? 'On-call email' : `${KIND_LABEL[o.kind]} alerts`} />
            {o.kind === 'email' ? <TextField id="to" label="Send to" v={o.v} errors={errors} placeholder="you@example.com, team@example.com" inputmode="email" /> : null}
            {o.kind === 'telegram' ? (
              <div class="form-row">
                <TextField id="botToken" label="Bot token" v={{ ...o.v, botToken: '' }} errors={errors} optional={editing} placeholder={editing ? 'Leave empty to keep the current one' : '123456:ABC…'} autocomplete="off" />
                <TextField id="chatId" label="Chat id" v={o.v} errors={errors} placeholder="-1001234567890" />
              </div>
            ) : null}
            {o.kind !== 'email' && o.kind !== 'telegram' ? (
              <TextField id="url" label="Webhook address" v={{ ...o.v, url: '' }} errors={errors} optional={editing} placeholder={editing ? 'Leave empty to keep the current one' : 'https://'} inputmode="url" autocomplete="off" hint="Stored privately. We only show the first few characters again." />
            ) : null}
            {o.kind === 'webhook' ? <TextField id="secret" label="Signing secret" v={{ ...o.v, secret: '' }} errors={errors} optional placeholder={editing ? 'Leave empty to keep the current one' : 'Optional'} autocomplete="off" hint="We sign each request in the x-toolshed-signature header." /> : null}
          </div>
        </Card>
        <Card title="What it sends" ruled>
          <div class="stack">
            <Toggle name="enabled" label="Channel is on" description="Turn it off to stop alerts without deleting it." checked={on(o.v, 'enabled', true)} />
            <Toggle name="notifyRecovery" label="Tell me when it recovers" checked={on(o.v, 'notifyRecovery', true)} />
            <Toggle name="notifySlow" label="Tell me about slow responses" description="Only for monitors with a slow alert set." checked={on(o.v, 'notifySlow')} />
            <TextField id="repeatMin" label="Remind me every (minutes)" v={o.v} errors={errors} inputmode="numeric" hint="While a monitor stays down. 0 means don’t repeat." />
            <div class="form-row">
              <TextField id="quietFrom" label="Quiet hours start" v={o.v} errors={errors} optional placeholder="22:00" hint={`In ${zone}.`} />
              <TextField id="quietTo" label="Quiet hours end" v={o.v} errors={errors} optional placeholder="07:00" hint="Alerts wait, then send a summary." />
            </div>
          </div>
        </Card>
        <div class="row">
          <Button type="submit" variant="primary">
            {editing ? 'Save changes' : 'Add channel'}
          </Button>
          <LinkButton href={`${BASE}/alerts`}>Cancel</LinkButton>
        </div>
      </form>
      {editing ? (
        <div class="row">
          <form method="post" action={`${BASE}/alerts/${o.id}/test`}>
            <Button type="submit">Send a test</Button>
          </form>
          <form method="post" action={`${BASE}/alerts/${o.id}/delete`}>
            <ConfirmButton id={`delete-${o.id}`} title="Delete this channel?" body="Monitors that only use it will stop alerting. This can’t be undone." confirmLabel="Delete channel" icon="trash">
              Delete channel
            </ConfirmButton>
          </form>
        </div>
      ) : null}
    </>,
  );
}

function payload(v: Values, editing: boolean): Record<string, unknown> {
  const kind = text(v, 'kind') as ChannelKind;
  const config: Record<string, unknown> = {};
  if (kind === 'email') config.to = text(v, 'to');
  else if (kind === 'telegram') {
    if (text(v, 'botToken').trim() || !editing) config.botToken = text(v, 'botToken');
    config.chatId = text(v, 'chatId');
  } else {
    if (text(v, 'url').trim() || !editing) config.url = text(v, 'url');
    if (kind === 'webhook' && (text(v, 'secret').trim() || !editing)) config.secret = text(v, 'secret');
  }
  return {
    name: text(v, 'name'),
    kind,
    config,
    enabled: on(v, 'enabled'),
    notifyRecovery: on(v, 'notifyRecovery'),
    notifySlow: on(v, 'notifySlow'),
    repeatMin: text(v, 'repeatMin'),
    quietFrom: text(v, 'quietFrom'),
    quietTo: text(v, 'quietTo'),
  };
}

app.get('/alerts/new', (c) => {
  const k = new URL(c.req.url).searchParams.get('kind');
  const kind: ChannelKind = isKind(k) ? k : 'email';
  return form(c, { kind, v: valuesOf(kind) });
});

app.post('/alerts/new', async (c) => {
  const v = await readForm(c);
  const kind: ChannelKind = isKind(text(v, 'kind')) ? (text(v, 'kind') as ChannelKind) : 'email';
  const ctx = await mctx(c);
  try {
    const ch = await createChannel(ctx, payload(v, false));
    await record(c, 'monitor.channel_created', 'channel', ch.id, `Added channel ${ch.name}`);
    return done(c, `${ch.name} added. Send a test to check it works.`, `${BASE}/alerts`);
  } catch (e) {
    return failed(c, e, `${BASE}/alerts/new?kind=${kind}`, (errors) => form(c, { kind, v, errors, status: 422 }));
  }
});

app.get('/alerts/:id', async (c) => {
  const ctx = await mctx(c);
  const ch = await getChannel(ctx, c.req.param('id'));
  return form(c, { kind: ch.kind, v: valuesOf(ch.kind, ch), id: ch.id });
});

app.post('/alerts/:id/edit', async (c) => {
  const ctx = await mctx(c);
  const ch = await getChannel(ctx, c.req.param('id'));
  const v = await readForm(c);
  v.kind = ch.kind;
  try {
    const next = await updateChannel(ctx, ch.id, payload(v, true));
    await record(c, 'monitor.channel_updated', 'channel', ch.id, `Updated channel ${next.name}`);
    return done(c, 'Changes saved.', `${BASE}/alerts`);
  } catch (e) {
    return failed(c, e, `${BASE}/alerts/${ch.id}`, (errors) => form(c, { kind: ch.kind, v, errors, id: ch.id, status: 422 }));
  }
});

app.post('/alerts/:id/test', async (c) => {
  const ctx = await mctx(c);
  const ch = await getChannel(ctx, c.req.param('id'));
  try {
    await testChannel(c.env, ctx.db.orgId, ch);
    return done(c, `Test sent to ${ch.name}.`, `${BASE}/alerts`);
  } catch (e) {
    return failed(c, e, `${BASE}/alerts`, async () => c.redirect(`${BASE}/alerts`));
  }
});

app.post('/alerts/:id/delete', async (c) => {
  const ctx = await mctx(c);
  const ch = await getChannel(ctx, c.req.param('id'));
  await deleteChannel(ctx, ch.id);
  await record(c, 'monitor.channel_deleted', 'channel', ch.id, `Deleted channel ${ch.name}`);
  return done(c, `${ch.name} was deleted.`, `${BASE}/alerts`);
});

export default app;
