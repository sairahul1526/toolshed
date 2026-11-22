/**
 * The page at /app/api-keys: the list of keys, the list of service accounts, how to use the API
 * and (for the person who owns the install) the signing key.
 */
import type { ApiKey, ServiceAccount } from '../../core/apikeys';
import type { getSigningKeyStatus } from '../../core/jwt';
import { Callout, Card, ConfirmButton, CopyField, EmptyState, formatDate, formatDateTime, KeyValueList, LinkButton, PageHeader, Pill, Table, Tabs, plural } from '../../ui';
import { KEY_LIST_CAP, listHref } from './data';
import type { KeyPage } from './data';
import { LastUsed, MadeBy, roleLabel, ScopeTags, StateCell } from './display';

const BASE = '/app/api-keys';

export type SigningKeyStatus = Awaited<ReturnType<typeof getSigningKeyStatus>>;

export interface ListPageProps {
  tab: 'keys' | 'accounts';
  page: KeyPage;
  /** True when the list starts after another key, so there is a way back to the first page. */
  paged: boolean;
  includeRevoked: boolean;
  /** Keys that still work, for the tab count. */
  workingKeys: number;
  accounts: ServiceAccount[];
  now: number;
  origin: string;
  /** Present only for the person who owns the install. Null inside it means no key exists yet. */
  signing?: SigningKeyStatus;
}

export function ListPage({ tab, page, paged, includeRevoked, workingKeys, accounts, now, origin, signing }: ListPageProps) {
  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys let scripts and other apps use this workspace without a person signing in."
        actions={
          tab === 'accounts' ? (
            <LinkButton variant="primary" icon="plus" href={`${BASE}/accounts/new`}>
              Make a service account
            </LinkButton>
          ) : (
            <LinkButton variant="primary" icon="plus" href={`${BASE}/new`}>
              Make a key
            </LinkButton>
          )
        }
      />
      <div class="stack">
        <Tabs
          label="API keys sections"
          active={tab}
          items={[
            { id: 'keys', label: 'Keys', count: workingKeys, href: listHref({}) },
            { id: 'accounts', label: 'Service accounts', count: accounts.length, href: listHref({ tab: 'accounts' }) },
          ]}
        />
        {tab === 'accounts' ? <AccountsList accounts={accounts} /> : <KeysList page={page} paged={paged} includeRevoked={includeRevoked} now={now} />}
        <UsingTheApi origin={origin} />
        {signing !== undefined ? <SigningKeyPanel status={signing} origin={origin} now={now} /> : null}
      </div>
    </>
  );
}

/* ---------- Keys ---------- */

function KeyName({ apiKey }: { apiKey: ApiKey }) {
  return (
    <div>
      <a class="trunc" href={`${BASE}/${encodeURIComponent(apiKey.id)}`} title={apiKey.name}>
        {apiKey.name}
      </a>
      <div class="muted mono">{apiKey.prefix}…</div>
      <div class="muted trunc">{apiKey.kind === 'service' ? `Service account: ${apiKey.serviceAccountName ?? 'deleted'}` : 'Personal'}</div>
    </div>
  );
}

function KeysList({ page, paged, includeRevoked, now }: { page: KeyPage; paged: boolean; includeRevoked: boolean; now: number }) {
  const toggle = (
    <LinkButton size="sm" href={listHref({ revoked: !includeRevoked })}>
      {includeRevoked ? 'Hide revoked keys' : 'Show revoked keys'}
    </LinkButton>
  );
  if (page.total === 0) {
    return (
      <EmptyState
        icon="key"
        title="No keys yet"
        body="Make a key when a script or another app needs to read or change things here. You can limit what it can do and when it stops working."
        actions={
          <>
            <LinkButton variant="primary" icon="plus" href={`${BASE}/new`}>
              Make a key
            </LinkButton>
            {includeRevoked ? <LinkButton href={listHref({})}>Hide revoked keys</LinkButton> : <LinkButton href={listHref({ revoked: true })}>Show revoked keys</LinkButton>}
          </>
        }
      />
    );
  }
  const rows = page.keys.map((k) => ({
    name: <KeyName apiKey={k} />,
    can: (
      <div>
        <ScopeTags scopes={k.scopes} />
        <div class="muted">Acts as {roleLabel(k.role)}</div>
      </div>
    ),
    by: <MadeBy label={k.createdByLabel} at={k.createdAt} />,
    used: <LastUsed apiKey={k} now={now} />,
    state: <StateCell apiKey={k} now={now} />,
  }));
  return (
    <Card
      title="Keys"
      description={`${plural(page.total, 'key')}${includeRevoked ? ', revoked ones included' : ''}`}
      actions={toggle}
      flush
      footer={
        <>
          <span class="muted">Keys are stored scrambled. We can’t show one again after you make it.</span>
          <span class="spacer" />
          {paged ? <LinkButton size="sm" href={listHref({ revoked: includeRevoked })}>Back to first page</LinkButton> : null}
          {page.next ? (
            <LinkButton size="sm" href={listHref({ revoked: includeRevoked, after: page.next })} rel="next">
              Next
            </LinkButton>
          ) : null}
        </>
      }
    >
      <Table
        caption="API keys"
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'can', label: 'Can' },
          { key: 'by', label: 'Made by', hideOnMobile: true },
          { key: 'used', label: 'Last used' },
          { key: 'state', label: 'State' },
        ]}
        rows={rows}
      />
      {page.capped ? (
        <p class="hint">This list shows the newest {KEY_LIST_CAP} keys. Revoke keys you no longer use to see older ones.</p>
      ) : null}
    </Card>
  );
}

/* ---------- Service accounts ---------- */

function AccountsList({ accounts }: { accounts: ServiceAccount[] }) {
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon="server"
        title="No service accounts yet"
        body="A service account is a name for an app or a script. Its keys keep working when people leave the workspace."
        actions={
          <LinkButton variant="primary" icon="plus" href={`${BASE}/accounts/new`}>
            Make a service account
          </LinkButton>
        }
      />
    );
  }
  return (
    <Card title="Service accounts" description="Keys made for one of these act with its role and don’t depend on any person." flush>
      <Table
        caption="Service accounts"
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'role', label: 'Acts as' },
          { key: 'keys', label: 'Working keys', numeric: true },
          { key: 'by', label: 'Made by', hideOnMobile: true },
          { key: 'manage', label: 'Manage', srOnly: true },
        ]}
        rows={accounts.map((a) => ({
          name: (
            <a class="trunc" href={`${BASE}/accounts/${encodeURIComponent(a.id)}`} title={a.name}>
              {a.name}
            </a>
          ),
          role: <Pill>{roleLabel(a.role)}</Pill>,
          keys: a.keyCount,
          by: <MadeBy label={a.createdByLabel} at={a.createdAt} />,
          manage: (
            <LinkButton size="sm" href={`${BASE}/accounts/${encodeURIComponent(a.id)}`}>
              Manage
            </LinkButton>
          ),
        }))}
      />
    </Card>
  );
}

/* ---------- Using the API ---------- */

function UsingTheApi({ origin }: { origin: string }) {
  return (
    <Card title="Using the API" description="Send the key in an Authorization header with every request.">
      <div class="stack">
        <CopyField label="base URL" value={`${origin}/api/v1`} secret={false} />
        <KeyValueList
          items={[
            { label: 'Header', value: <span class="mono">Authorization: Bearer &lt;your key&gt;</span> },
            { label: 'Reference', value: <>See <span class="mono">docs/api.md</span> in the Toolshed repository for every route.</> },
          ]}
        />
        <p class="hint">
          Instead of sending the key each time, an app can swap it for a token that lasts 15 minutes with <span class="mono">POST /api/v1/token</span>. The token can only do the same or less than the key.
        </p>
      </div>
    </Card>
  );
}

/* ---------- Signing key ---------- */

function SigningKeyPanel({ status, origin, now }: { status: SigningKeyStatus; origin: string; now: number }) {
  return (
    <form method="post" action={`${BASE}/signing-key/rotate`}>
      <Card
        title="Signing key"
        description="Tokens made by this install are signed with this key. Other apps check them against the public key list."
        footer={
          <ConfirmButton
            id="signing"
            danger={false}
            variant="default"
            icon="refresh"
            title="Replace the signing key now?"
            body="New tokens are signed with a new key. Tokens already issued keep working until they expire, which is 15 minutes for most of them."
            confirmLabel="Rotate now"
          >
            Rotate now
          </ConfirmButton>
        }
      >
        <div class="stack">
          {status === null ? (
            <Callout tone="info" title="No signing key yet">
              One is made the first time a token is issued.
            </Callout>
          ) : (
            <KeyValueList
              items={[
                { label: 'Current key id', value: <span class="mono">{status.kid}</span> },
                { label: 'Made', value: formatDateTime(status.createdAt) },
                {
                  label: 'Next automatic rotation',
                  value: status.rotatesAt <= now ? 'On the next token' : formatDate(status.rotatesAt),
                },
              ]}
            />
          )}
          <CopyField label="public key list URL" value={`${origin}/.well-known/jwks.json`} secret={false} />
          <p class="hint">
            Only the person who owns this install sees this. The key is replaced on its own every 90 days.
          </p>
        </div>
      </Card>
    </form>
  );
}
