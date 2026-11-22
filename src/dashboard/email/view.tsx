/** The Email screen's markup. Pure functions of what `data.ts` loaded; no reading or writing here. */
import { maskAddress } from './mask';
import { EMAIL_LOG_DAYS, EMAIL_STATUSES, type EmailLogItem, type EmailResult, type EmailSetup, type EmailStatus } from '../../core/email';
import { EMAIL_LANGUAGES, TEMPLATE_INFO, TEMPLATE_NAMES } from '../../core/email-templates';
import {
  Button,
  Callout,
  Card,
  CodeBlock,
  ConfirmButton,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  Input,
  KeyValueList,
  LinkButton,
  PageHeader,
  Pill,
  Section,
  SearchInput,
  Select,
  Stat,
  StatGrid,
  Table,
  Tabs,
  formatDateTime,
  formatNumber,
  plural,
  timeAgo,
  type CalloutTone,
  type TabItem,
} from '../../ui';
import type { SenderInput } from './actions';
import { LOG_PAGE_SIZE, type EmailPage, type PageQuery, type Tab, type Viewer } from './data';
import { LANGUAGE_LABELS } from './samples';
import { STATUS_INFO, statusInfo } from './statuses';

export interface SenderForm {
  values: SenderInput;
  errors: Record<string, string>;
}

export interface TestForm {
  to: string;
  /** Message for the address field. */
  fieldError?: string;
  /** The test could not run at all (not set up, too many tests). */
  failure?: string;
  result?: EmailResult;
}

export interface EmailViewProps {
  page: EmailPage;
  viewer: Viewer;
  query: PageQuery;
  /** The signed-in person's address, the default recipient of a test. */
  userEmail: string;
  /** True when the Worker has the EMAIL binding (Cloudflare Email Sending). */
  hasBinding: boolean;
  sender?: SenderForm;
  test?: TestForm;
}

const BASE = '/app/email';

function href(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return `${BASE}?${qs.toString()}`;
}

const MODE_PILL = { live: { tone: 'good', label: 'On' }, dev: { tone: 'neutral', label: 'Dev mode' }, off: { tone: 'solid', label: 'Needs setup' } } as const;

export function EmailView(props: EmailViewProps) {
  const { page, viewer } = props;
  const mode = MODE_PILL[page.status.mode];
  const items: TabItem[] = [
    { id: 'setup', label: 'Setup', href: href({ tab: 'setup' }) },
    { id: 'templates', label: 'Templates', count: TEMPLATE_NAMES.length, href: href({ tab: 'templates' }) },
    { id: 'log', label: 'Delivery log', href: href({ tab: 'log' }) },
    ...(viewer.isOwner ? [{ id: 'blocked', label: 'Blocked addresses', href: href({ tab: 'blocked' }) }] : []),
  ];
  return (
    <>
      <PageHeader
        title={
          <>
            Email <Pill tone={mode.tone}>{mode.label}</Pill>
          </>
        }
        description="Sign-in codes, invites and other emails, sent from your own address through Cloudflare Email Sending."
        actions={
          viewer.isOwner && page.status.mode !== 'off' ? (
            <LinkButton href={`${href({ tab: 'setup' })}#test`} icon="send">
              Send a test
            </LinkButton>
          ) : null
        }
      />
      <Tabs items={items} active={page.tab} label="Email sections" />
      <div class="stack">{tabBody(props)}</div>
    </>
  );
}

function tabBody(props: EmailViewProps) {
  switch (props.page.tab) {
    case 'templates':
      return <TemplatesTab {...props} />;
    case 'log':
      return <LogTab {...props} />;
    case 'blocked':
      return <BlockedTab {...props} />;
    default:
      return <SetupTab {...props} />;
  }
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

function SetupTab(props: EmailViewProps) {
  const { page, viewer } = props;
  if (!viewer.isOwner || !page.setup) return <ReadOnlyStatus status={page.status} />;
  const { sender, caps } = page.setup;
  const off = page.status.mode === 'off';
  return (
    <>
      <StatusCallout status={page.status} from={sender.fromAddress ? `${sender.fromName} <${sender.fromAddress}>` : null} />
      {off ? <SetupSteps hasBinding={props.hasBinding} /> : null}
      <SenderSection sender={props.sender ?? { values: { fromName: sender.fromName, fromAddress: sender.fromAddress, replyTo: sender.replyTo ?? '' }, errors: {} }} />
      <TestSection off={off} userEmail={props.userEmail} test={props.test} />
      <Section title="Limits" description="Limits stop a mistake or an attack from sending thousands of emails.">
        <Card>
          <KeyValueList
            items={[
              { label: 'To one address, each hour', value: formatNumber(caps.perRecipientPerHour) },
              { label: 'From this install, each hour', value: formatNumber(caps.perInstallPerHour) },
              { label: 'Delivery log kept for', value: plural(EMAIL_LOG_DAYS, 'day') },
            ]}
          />
          <p class="hint">These limits can’t be changed on this screen yet. An email over a limit is not sent and shows as Limit reached in the delivery log.</p>
        </Card>
      </Section>
    </>
  );
}

function ReadOnlyStatus({ status }: { status: EmailSetup }) {
  return status.mode === 'off' ? (
    <Callout tone="warn" title="Email is not set up">
      Email is not set up. Ask the person who runs this install.
    </Callout>
  ) : (
    <Callout tone="good" title="Email is set up">
      {status.mode === 'dev' ? 'Email is set up. In development, emails are kept in a local outbox and nothing is sent.' : 'Email is set up.'} The person who runs this install manages the sender and limits.
    </Callout>
  );
}

function StatusCallout({ status, from }: { status: EmailSetup; from: string | null }) {
  if (status.mode === 'live') {
    return (
      <Callout tone="good" title="Email is on">
        {`Emails are sent from ${from ?? 'your sender'} through Cloudflare Email Sending.`}
      </Callout>
    );
  }
  if (status.mode === 'dev') {
    return (
      <Callout
        tone="info"
        title="Development mode"
        actions={
          <LinkButton size="sm" href="/dev/outbox">
            Open the outbox
          </LinkButton>
        }
      >
        {status.reason}
      </Callout>
    );
  }
  return (
    <Callout tone="warn" title="Email is not set up">
      {status.reason}
    </Callout>
  );
}

/** From docs/email.md. Names the Cloudflare screens in words so the steps do not go stale with a link. */
function SetupSteps({ hasBinding }: { hasBinding: boolean }) {
  const steps: { title: string; body: string; done: boolean }[] = [
    {
      title: '1. Add your domain to Cloudflare Email Sending',
      body: 'In your Cloudflare dashboard, open Email Sending and add the domain you want to send from. Add the SPF, DKIM and DMARC records it shows you in your DNS, then wait until the domain shows as verified.',
      done: hasBinding,
    },
    {
      title: '2. Add the email binding to your Worker',
      body: 'In wrangler.jsonc, add "send_email": [{ "name": "EMAIL" }].',
      done: hasBinding,
    },
    { title: '3. Deploy again', body: 'Deploy the Worker so it picks up the binding.', done: hasBinding },
    {
      title: '4. Choose the sender and send a test',
      body: 'Come back to this screen, enter an address on the domain from step 1 under Sender, save, then send yourself a test email.',
      done: false,
    },
  ];
  return (
    <Card title="How to turn email on" description="Four steps. Until they are done, nothing is sent and features that need email say so.">
      <ul class="rows" aria-label="Setup steps">
        {steps.map((s) => (
          <li>
            <span class="row-text">
              <b>{s.title}</b>
              <span>{s.body}</span>
            </span>
            {s.done ? <Pill tone="good">Done</Pill> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SenderSection({ sender }: { sender: SenderForm }) {
  const { values, errors } = sender;
  const err = (key: string) => errors[key];
  return (
    <Section title="Sender" description="What people see in their inbox. Only the person who runs this install can change it.">
      <form method="post" action={`${BASE}/sender`}>
        <Card
          footer={
            <>
              <span class="spacer" />
              <Button type="submit" variant="primary" size="sm">
                Save sender
              </Button>
            </>
          }
        >
          <div class="form">
            <div class="form-row">
              <Field id="fromName" label="From name" error={err('fromName')}>
                <Input id="fromName" name="fromName" value={values.fromName} maxlength={60} required invalid={Boolean(err('fromName'))} autocomplete="off" />
              </Field>
              <Field id="fromAddress" label="From address" hint="Must be on the domain you added to Cloudflare Email Sending. Leave it empty to turn sending off." error={err('fromAddress')}>
                <Input id="fromAddress" name="fromAddress" type="email" value={values.fromAddress} placeholder="hello@example.com" invalid={Boolean(err('fromAddress'))} autocomplete="off" />
              </Field>
            </div>
            <Field id="replyTo" label="Replies go to" optional hint="Without this, replies go to the from address." error={err('replyTo')}>
              <Input id="replyTo" name="replyTo" type="email" value={values.replyTo} placeholder="help@example.com" invalid={Boolean(err('replyTo'))} autocomplete="off" />
            </Field>
          </div>
        </Card>
      </form>
    </Section>
  );
}

const RESULT: Record<EmailStatus, { tone: CalloutTone; title: string; body: string }> = {
  sent: { tone: 'good', title: 'Test email sent', body: 'Cloudflare accepted it. It can take a minute to arrive. Check your spam folder if you do not see it.' },
  dev: { tone: 'info', title: 'Kept in the dev outbox', body: 'Development mode. Nothing was sent. The email is in the outbox, with its full text.' },
  not_configured: { tone: 'warn', title: 'Not sent', body: 'Email sending is not set up yet.' },
  failed: { tone: 'bad', title: 'The test email failed', body: 'It was not sent and will not be tried again.' },
  retrying: { tone: 'warn', title: 'Not sent yet', body: 'Cloudflare had a temporary problem. We will try again over the next few minutes. Watch the delivery log.' },
  suppressed: { tone: 'warn', title: 'Not sent: this address is blocked', body: 'It bounced before. You can allow it again from the Blocked addresses tab.' },
  capped: { tone: 'warn', title: 'Not sent: limit reached', body: 'Too many emails went out this hour.' },
};

function TestSection({ off, userEmail, test }: { off: boolean; userEmail: string; test?: TestForm }) {
  const result = test?.result;
  const info = result ? RESULT[result.status] : null;
  return (
    <div id="test">
      <Section title="Send a test email" description="Sends a short email to check that setup works. Each person can send a few an hour.">
        {info && result ? (
          <Callout tone={info.tone} title={info.title}>
            {result.error ? `${info.body} ${result.error}` : info.body}
          </Callout>
        ) : null}
        {test?.failure ? (
          <Callout tone="warn" title="The test could not run">
            {test.failure}
          </Callout>
        ) : null}
        <form method="post" action={`${BASE}/test`}>
          <Card
            footer={
              <>
                <span class="spacer" />
                <Button type="submit" variant="primary" size="sm" icon="send" disabled={off}>
                  Send test email
                </Button>
              </>
            }
          >
            <Field id="to" label="Send it to" error={test?.fieldError} hint={off ? 'Set up email first, then you can send a test.' : undefined}>
              <Input id="to" name="to" type="email" value={test?.to ?? userEmail} required invalid={Boolean(test?.fieldError)} disabled={off} />
            </Field>
          </Card>
        </form>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

function TemplatesTab({ page, query }: EmailViewProps) {
  const preview = page.preview;
  if (!preview) return null;
  const link = (t: string, lang: string) => href({ tab: 'templates', t, lang });
  return (
    <div class="split">
      <Card
        title={preview.template}
        description={TEMPLATE_INFO[preview.template]}
        actions={
          <span class="row" role="group" aria-label="Language">
            {EMAIL_LANGUAGES.map((lang) => (
              <LinkButton size="sm" variant={lang === preview.lang ? 'primary' : 'default'} href={link(preview.template, lang)} aria-current={lang === preview.lang ? 'true' : undefined}>
                {LANGUAGE_LABELS[lang] ?? lang}
              </LinkButton>
            ))}
          </span>
        }
      >
        <div class="form">
          <KeyValueList items={[{ label: 'Subject', value: preview.mail.subject }]} />
          <div>
            <p class="section-label">Plain-text version</p>
            <CodeBlock code={preview.mail.text} label="Plain-text version" copy={false} />
          </div>
          <details>
            <summary>HTML source</summary>
            <CodeBlock code={preview.mail.html} label="HTML source" copy={false} />
          </details>
          <p class="hint">
            Filled with sample data. People get the same text laid out with your logo, accent color and footer, in their own language when there is a version for it.
          </p>
        </div>
      </Card>
      <Card title="Built-in emails" flush>
        <ul class="rows" aria-label="Templates">
          {TEMPLATE_NAMES.map((name) => (
            <li>
              <span class="row-text">
                <b>
                  <a href={link(name, query.lang)} aria-current={name === preview.template ? 'true' : undefined}>
                    {name}
                  </a>
                </b>
                <span>{TEMPLATE_INFO[name]}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------------------------

function LogTab({ page, viewer, query }: EmailViewProps) {
  const log = page.log;
  if (!log) return null;
  const filtered = Boolean(query.status || query.q);
  const { counts } = log;
  const notSent = (counts.suppressed ?? 0) + (counts.capped ?? 0) + (counts.not_configured ?? 0);
  const nextHref = log.nextCursor ? href({ tab: 'log', status: query.status, q: query.q, before: log.nextCursor }) : null;
  const rows = log.items.map((m) => ({
    when: <span title={formatDateTime(m.at)}>{timeAgo(m.at)}</span>,
    to: (
      <span class="row-text">
        {/* Masked here; the full address is in the row's details. */}
        <b class="trunc">{maskAddress(m.to)}</b>
      </span>
    ),
    email: (
      <span class="row-text">
        <b class="trunc" title={m.subject}>
          {m.subject}
        </b>
        <span class="trunc" title={m.error ?? undefined}>
          {[m.template, m.status !== 'sent' && m.error ? m.error : null].filter(Boolean).join(' · ')}
        </span>
      </span>
    ),
    status: <StatusPill status={m.status} />,
    details: (
      <Button size="sm" variant="ghost" data-open={`log-${m.id}`}>
        Details<span class="sr-only"> for {m.subject}</span>
      </Button>
    ),
  }));
  return (
    <>
      <StatGrid label="Emails in the last 7 days">
        <Stat label="Sent" value={formatNumber((counts.sent ?? 0) + (counts.dev ?? 0))} note="Last 7 days" />
        <Stat label="Failed" value={formatNumber(counts.failed ?? 0)} note="Last 7 days" />
        <Stat label="Retrying" value={formatNumber(counts.retrying ?? 0)} note="Last 7 days" />
        <Stat label="Not sent" value={formatNumber(notSent)} note="Blocked or over a limit" />
      </StatGrid>
      <Card
        title="Delivery log"
        description={
          viewer.isOwner
            ? 'Every email this install tried to send.'
            : 'Emails sent for this workspace, such as invites. Sign-in codes are not listed here.'
        }
        flush
        footer={<span class="note">Entries are deleted after {plural(EMAIL_LOG_DAYS, 'day')}. No email text, code or link is kept.</span>}
      >
        <div class="card-body">
          <FilterBar action={BASE}>
            <input type="hidden" name="tab" value="log" />
            <Select
              name="status"
              aria-label="Status"
              value={query.status ?? ''}
              options={[{ value: '', label: 'All statuses' }, ...EMAIL_STATUSES.map((s) => ({ value: s, label: STATUS_INFO[s].label }))]}
            />
            <SearchInput name="q" value={query.q ?? ''} label="Search by address or subject" placeholder="Search by address or subject" />
            {filtered ? (
              <LinkButton size="sm" variant="ghost" href={href({ tab: 'log' })}>
                Clear filters
              </LinkButton>
            ) : null}
          </FilterBar>
        </div>
        <Table
          caption="Delivery log"
          columns={[
            { key: 'when', label: 'When' },
            { key: 'to', label: 'To' },
            { key: 'email', label: 'Email', hideOnMobile: false },
            { key: 'status', label: 'Status' },
            { key: 'details', label: 'Details', srOnly: true },
          ]}
          rows={rows}
          empty={filtered ? <NoMatches /> : <NothingSent viewer={viewer} />}
        />
        {log.items.length > 0 ? (
          <nav class="pagination" aria-label="Delivery log pages">
            <span class="muted">{`Showing ${formatNumber(log.items.length)} ${log.items.length === 1 ? 'email' : 'emails'}, newest first`}</span>
            <span class="row">
              {query.before ? (
                <LinkButton size="sm" href={href({ tab: 'log', status: query.status, q: query.q })}>
                  Back to newest
                </LinkButton>
              ) : null}
              {nextHref ? (
                <LinkButton size="sm" href={nextHref} rel="next" icon="right">
                  Older
                </LinkButton>
              ) : null}
            </span>
          </nav>
        ) : null}
      </Card>
      {log.items.map((m) => (
        <LogDetail item={m} />
      ))}
      <Card title="What the statuses mean">
        <ul class="rows" aria-label="Statuses">
          {EMAIL_STATUSES.map((s) => (
            <li>
              <StatusPill status={s} />
              <span class="row-text">
                <span>{STATUS_INFO[s].meaning}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const info = statusInfo(status);
  return <Pill tone={info.tone}>{info.label}</Pill>;
}

function NoMatches() {
  return (
    <EmptyState
      bare
      icon="search"
      title="No emails match"
      body={`Nothing in the last ${plural(EMAIL_LOG_DAYS, 'day')} matches those filters. Try another status or a shorter search.`}
      actions={
        <LinkButton href={href({ tab: 'log' })} variant="primary">
          Clear filters
        </LinkButton>
      }
    />
  );
}

function NothingSent({ viewer }: { viewer: Viewer }) {
  return (
    <EmptyState
      bare
      icon="mail"
      title="No emails yet"
      body={viewer.isOwner ? 'Emails show up here as soon as one is sent: a sign-in code, an invite or a test.' : 'Emails for this workspace show up here as soon as one is sent, for example an invite.'}
      actions={
        viewer.isOwner ? (
          <LinkButton href={`${href({ tab: 'setup' })}#test`} variant="primary" icon="send">
            Send a test email
          </LinkButton>
        ) : undefined
      }
    />
  );
}

function LogDetail({ item }: { item: EmailLogItem }) {
  const info = statusInfo(item.status);
  return (
    <Dialog id={`log-${item.id}`} title="Email details" description={info.meaning} size="md" footer={<><span class="spacer" /><Button data-close>Close</Button></>}>
      <KeyValueList
        items={[
          { label: 'Status', value: <StatusPill status={item.status} /> },
          { label: 'To', value: item.to },
          { label: 'Subject', value: item.subject },
          { label: 'Email', value: item.template ?? 'Not named' },
          { label: 'Time', value: formatDateTime(item.at) },
          { label: 'Tries', value: formatNumber(item.attempts) },
          ...(item.error ? [{ label: 'What went wrong', value: item.error }] : []),
          ...(item.messageId ? [{ label: 'Cloudflare message id', value: <span class="mono">{item.messageId}</span> }] : []),
        ]}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Blocked addresses
// ---------------------------------------------------------------------------------------------

function BlockedTab({ page }: EmailViewProps) {
  const blocked = page.blocked ?? [];
  return (
    <Card
      title="Blocked addresses"
      description="Addresses that bounced or were reported. We do not email them, so they do not hurt your sending reputation."
      flush
      footer={blocked.length > 0 ? <span class="note">Allowing an address again is recorded in the audit log.</span> : undefined}
    >
      <Table
        caption="Blocked addresses"
        columns={[
          { key: 'address', label: 'Address' },
          { key: 'reason', label: 'Why' },
          { key: 'since', label: 'Since' },
          { key: 'action', label: 'Allow again', srOnly: true },
        ]}
        rows={blocked.map((b, i) => ({
          address: (
            <span class="row-text">
              <b class="trunc" title={b.address}>
                {b.address}
              </b>
            </span>
          ),
          reason: b.reason || 'Not recorded',
          since: formatDateTime(b.at),
          action: (
            <form method="post" action={`${BASE}/blocked/allow`}>
              <input type="hidden" name="address" value={b.address} />
              <ConfirmButton
                id={`allow-${i}`}
                size="sm"
                danger={false}
                title="Allow email to this address again?"
                body={`We will start sending to ${b.address} again. It was blocked because it bounced or was reported. If it still cannot receive email, it will bounce again, and repeated bounces can hurt your sending reputation. This is recorded in the audit log.`}
                confirmLabel="Allow again"
              >
                Allow again
              </ConfirmButton>
            </form>
          ),
        }))}
        empty={
          <EmptyState
            bare
            icon="shieldcheck"
            title="No blocked addresses"
            body="An address is added here when it bounces or is reported. Nothing has been blocked yet."
            actions={
              <LinkButton href={href({ tab: 'log' })} variant="primary">
                See the delivery log
              </LinkButton>
            }
          />
        }
      />
    </Card>
  );
}

export type { Tab };
export { LOG_PAGE_SIZE };
