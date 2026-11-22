/** Webhooks: the list on the Settings tab, and the pages to add one, change one and see its secret. */
import type { CatalogEvent, WebhookEndpoint } from '../../core/webhooks';
import type { FieldErrors } from '../../core/errors';
import { Button, Callout, Card, Checkbox, CopyField, EmptyState, Field, formatDateTime, Icon, Input, LinkButton, PageHeader, Pill, Section, Table, timeAgo } from '../../ui';
import type { PillTone } from '../../ui';
import { fieldError } from './forms';
import { ADMIN_ONLY, BASE, tabHref } from './frame';

export const HOOKS = `${BASE}/webhooks`;
export const hookHref = (id: string): string => `${HOOKS}/${encodeURIComponent(id)}`;

const STATUS: Record<WebhookEndpoint['status'], { label: string; tone: PillTone }> = {
  active: { label: 'Sending', tone: 'good' },
  paused: { label: 'Paused', tone: 'neutral' },
  disabled: { label: 'Turned off', tone: 'bad' },
};

const eventsText = (events: string[]): string => (events.includes('*') ? 'Everything' : events.length === 1 ? events[0]! : `${events.length} events`);

/* ---------- The tab ---------- */

export function WebhooksTab({ endpoints, canManage, now }: { endpoints: WebhookEndpoint[]; canManage: boolean; now: number }) {
  if (!canManage) {
    return (
      <Section title="Webhooks" description="Messages sent to another service when something happens here.">
        <Callout title="Admins only">{ADMIN_ONLY}</Callout>
      </Section>
    );
  }
  return (
    <Section title="Webhooks" description="Each one sends a signed message to an address you choose when something happens here. Use them to fill a spreadsheet, post to a chat or start an automation.">
      <Card
        flush
        title="Endpoints"
        actions={
          <LinkButton size="sm" variant="primary" icon="plus" href={`${HOOKS}/new`}>
            Add webhook
          </LinkButton>
        }
      >
        <Table
          caption="Webhooks"
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'url', label: 'Address', hideOnMobile: true },
            { key: 'events', label: 'Sends' },
            { key: 'status', label: 'Status' },
          ]}
          rows={endpoints.map((e) => ({
            name: (
              <a class="trunc" href={hookHref(e.id)} title={e.name}>
                {e.name}
              </a>
            ),
            url: (
              <span class="trunc mono" title={e.url}>
                {e.url}
              </span>
            ),
            events: <span class="trunc">{eventsText(e.events)}</span>,
            status: (
              <span class="row-text">
                <Pill tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Pill>
                {e.lastFailureAt !== null && e.consecutiveFailures > 0 ? <span>Last try failed {timeAgo(e.lastFailureAt, now)}</span> : null}
              </span>
            ),
          }))}
          empty={
            <EmptyState
              bare
              icon="send"
              title="No webhooks yet"
              body="Add one to send an event to another service as soon as it happens."
              actions={
                <LinkButton variant="primary" icon="plus" href={`${HOOKS}/new`}>
                  Add webhook
                </LinkButton>
              }
            />
          }
        />
      </Card>
    </Section>
  );
}

/* ---------- The form shared by "add" and "change" ---------- */

export interface HookValues {
  name: string;
  url: string;
  events: string[];
}

interface Choice {
  value: string;
  label: string;
  hint?: string;
}

interface ChoiceGroup {
  heading: string | null;
  choices: Choice[];
}

/** Everything a person can tick: all events, a tool's events, single events, and any saved pattern the list does not know. */
function eventChoices(catalog: CatalogEvent[], saved: string[]): ChoiceGroup[] {
  const groups: ChoiceGroup[] = [{ heading: null, choices: [{ value: '*', label: 'Everything', hint: 'Every event from every tool, including tools you turn on later.' }] }];
  const known = new Set(['*']);
  const modules = [...new Set(catalog.map((e) => e.module))];
  for (const id of modules) {
    const events = catalog.filter((e) => e.module === id);
    const name = events[0]!.moduleName;
    known.add(`${id}.*`);
    for (const e of events) known.add(e.type);
    groups.push({
      heading: name,
      choices: [{ value: `${id}.*`, label: `All ${name} events` }, ...events.map((e) => ({ value: e.type, label: e.type }))],
    });
  }
  const extra = saved.filter((v) => !known.has(v));
  if (extra.length > 0) groups.push({ heading: 'Other', choices: extra.map((v) => ({ value: v, label: v })) });
  return groups;
}

function HookForm({ action, values, errors, catalog, submit, locked }: { action: string; values: HookValues; errors: FieldErrors; catalog: CatalogEvent[]; submit: string; locked?: boolean }) {
  const eventsError = fieldError(errors, 'events');
  return (
    <form method="post" action={action} class="stack" autocomplete="off">
      <Card title="Where it goes">
        <div class="form">
          <Field id="name" label="Name" hint="Something you will recognise, such as Orders to the warehouse." error={errors.name}>
            <Input id="name" name="name" value={values.name} required maxlength={80} invalid={Boolean(errors.name)} />
          </Field>
          <Field id="url" label="Address" hint="The https address that receives the messages. Your developer or the tool you are connecting gives you this." error={errors.url}>
            <Input id="url" name="url" type="url" inputmode="url" value={values.url} required maxlength={2048} placeholder="https://example.com/hooks/toolshed" invalid={Boolean(errors.url)} disabled={locked} />
          </Field>
        </div>
      </Card>
      <Card title="What it sends" description="Pick the events that should be sent to this address.">
        <div class="stack" role="group" aria-label="Events">
          {eventChoices(catalog, values.events).map((g) => (
            <div>
              {g.heading ? <h3 class="lbl">{g.heading}</h3> : null}
              <div class="checks">
                {g.choices.map((c) => (
                  <Checkbox name="events" value={c.value} checked={values.events.includes(c.value)} label={c.label} description={c.hint} disabled={locked} />
                ))}
              </div>
            </div>
          ))}
          {eventsError ? (
            <p class="err-text" role="alert">
              {eventsError}
            </p>
          ) : null}
        </div>
      </Card>
      <div class="row">
        <Button type="submit" variant="primary">
          {submit}
        </Button>
        <LinkButton href={tabHref('webhooks')}>Cancel</LinkButton>
      </div>
    </form>
  );
}

export function NewHookPage({ values, errors, message, catalog }: { values: HookValues; errors: FieldErrors; message: string | null; catalog: CatalogEvent[] }) {
  return (
    <>
      <PageHeader title="Add a webhook" description="Toolshed will send a signed message to this address each time a chosen event happens." />
      <div class="stack">
        {message ? (
          <Callout tone="bad" title="The webhook wasn’t added">
            {message}
          </Callout>
        ) : null}
        <HookForm action={HOOKS} values={values} errors={errors} catalog={catalog} submit="Add webhook" />
      </div>
    </>
  );
}

/* ---------- The signing secret ---------- */

/**
 * Shown straight in the response to the post that asked for it. It is never put in a redirect,
 * a cookie or a later page, and the response is not cached.
 */
export function SecretPage({ endpoint, secret, fresh }: { endpoint: WebhookEndpoint; secret: string; fresh: boolean }) {
  return (
    <>
      <PageHeader title={fresh ? 'Webhook added' : 'Signing secret'} soft={endpoint.name} />
      <div class="stack">
        <Callout tone="warn" title="Keep this private">
          Whoever builds the receiver uses it to check that a message really came from your workspace. Treat it like a password. You can show it again from the webhook’s page while you are signed in.
        </Callout>
        <Card title="Signing secret" footer={<LinkButton variant="primary" href={hookHref(endpoint.id)}>{fresh ? 'I copied it' : 'Back to the webhook'}</LinkButton>}>
          <CopyField label="signing secret" value={secret} />
        </Card>
      </div>
    </>
  );
}

/* ---------- One webhook ---------- */

export interface HookPageProps {
  endpoint: WebhookEndpoint;
  values: HookValues;
  errors: FieldErrors;
  message: string | null;
  catalog: CatalogEvent[];
  /** While signed in as someone else only the name may change. */
  nameOnly: boolean;
}

export function HookPage({ endpoint, values, errors, message, catalog, nameOnly }: HookPageProps) {
  const status = STATUS[endpoint.status];
  const paused = endpoint.status !== 'active';
  const id = encodeURIComponent(endpoint.id);
  return (
    <>
      <PageHeader
        title={endpoint.name}
        description={<span class="mono">{endpoint.url}</span>}
        actions={
          <LinkButton href={tabHref('webhooks')} icon="left">
            All webhooks
          </LinkButton>
        }
      />
      <div class="stack">
        {nameOnly ? (
          <Callout tone="warn" title="Signed in as someone else">
            You can rename this webhook. The address, events, on and off switch, and signing secret stay as they are until you are signed in as yourself.
          </Callout>
        ) : null}
        {message ? (
          <Callout tone="bad" title="Nothing was saved">
            {message}
          </Callout>
        ) : null}
        {endpoint.status === 'disabled' ? (
          <Callout tone="bad" title="Toolshed turned this off">
            {endpoint.disabledReason ?? 'It kept failing, so we stopped sending.'} Fix the receiver, then press Turn on.
          </Callout>
        ) : null}
        <Card title="State">
          <dl class="kv">
            <dt>Status</dt>
            <dd>
              <Pill tone={status.tone}>{status.label}</Pill>
            </dd>
            <dt>Added</dt>
            <dd>
              {formatDateTime(endpoint.createdAt)}
              {endpoint.createdByLabel ? ` by ${endpoint.createdByLabel}` : ''}
            </dd>
            <dt>Last worked</dt>
            <dd>{endpoint.lastSuccessAt === null ? 'Not yet' : formatDateTime(endpoint.lastSuccessAt)}</dd>
          </dl>
        </Card>
        <HookForm action={`${hookHref(endpoint.id)}`} values={values} errors={errors} catalog={catalog} submit="Save changes" locked={nameOnly} />
        <Card
          title="Pause or turn on"
          description={paused ? 'Nothing is sent while it is off. Events that happen meanwhile are not sent later.' : 'Stop sending for a while. Events that happen while it is paused are not sent later.'}
          footer={
            <form method="post" action={`${hookHref(endpoint.id)}/status`}>
              <input type="hidden" name="status" value={paused ? 'active' : 'paused'} />
              <Button type="submit" icon={paused ? 'refresh' : 'ban'} disabled={nameOnly}>
                {paused ? 'Turn on' : 'Pause'}
              </Button>
            </form>
          }
        />
        <Card
          title="Signing secret"
          description="Used by the receiver to check that messages come from this workspace."
          footer={
            <form method="post" action={`/app/settings/webhooks/${id}/secret`}>
              <Button type="submit" icon="key" disabled={nameOnly}>
                Show secret
              </Button>
            </form>
          }
        />
        <section class="danger-zone card" aria-label="Danger zone">
          <div class="card-head ruled">
            <h2>Delete this webhook</h2>
          </div>
          <div class="card-body after-head">
            <form method="post" action={`${hookHref(endpoint.id)}/delete`} class="form">
              <p>The address stops receiving messages right away, and the log of what was sent to it is removed. This can’t be undone.</p>
              <div>
                <Button type="submit" variant="danger-solid" icon="trash" disabled={nameOnly}>
                  Delete webhook
                </Button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}

export { Icon };
