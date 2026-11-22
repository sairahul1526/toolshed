/**
 * The pages for one key: making it, the one-time page that shows its secret, and the page where
 * it is renamed, rotated or revoked.
 */
import type { Child } from 'hono/jsx';
import type { ApiKey, KeyRole, ServiceAccount } from '../../core/apikeys';
import type { FieldErrors } from '../../core/errors';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  ConfirmButton,
  CopyField,
  DangerZone,
  Field,
  formatDateTime,
  Input,
  KeyValueList,
  LinkButton,
  PageHeader,
  Select,
} from '../../ui';
import { Expiry, LastUsed, roleLabel, ScopeTags, scopeText, shownStatus, StatusPill } from './display';
import { curlExample, EXPIRY_CHOICES } from './forms';
import type { NewKeyValues, ScopeGroup } from './forms';

const BASE = '/app/api-keys';

/** How long a replaced key may keep working, for the rotate form. Seconds, as the service takes them. */
export const GRACE_CHOICES = [
  { value: '0', label: 'Stop it right away' },
  { value: '3600', label: 'Keep it working for 1 hour' },
  { value: '86400', label: 'Keep it working for 1 day' },
  { value: '604800', label: 'Keep it working for 7 days' },
];

/* ---------- Make a key ---------- */

export interface NewKeyProps {
  values: NewKeyValues;
  fields: FieldErrors;
  message: string | null;
  token: string;
  accounts: ServiceAccount[];
  roles: KeyRole[];
  groups: ScopeGroup[];
}

export function NewKeyPage({ values, fields, message, token, accounts, roles, groups }: NewKeyProps) {
  const accountOptions = [
    { value: '', label: 'Me (a personal key)' },
    ...accounts.map((a) => ({ value: a.id, label: `Service account: ${a.name} (${roleLabel(a.role)})` })),
  ];
  return (
    <>
      <PageHeader title="Make a key" description="A key lets a script or another app read or change things in this workspace." />
      <form method="post" action={`${BASE}/new`} class="stack">
        <input type="hidden" name="form_token" value={token} />
        {message ? (
          <Callout tone="bad" title="The key wasn’t made">
            {message}
          </Callout>
        ) : null}
        <Card title="Details">
          <div class="stack">
            <Field id="name" label="Name" hint="Something that tells you where it is used, such as Zapier or Nightly backup." error={fields.name}>
              <Input id="name" name="name" value={values.name} required maxlength={80} autocomplete="off" invalid={!!fields.name} />
            </Field>
            <div class="form-row">
              <Field
                id="account"
                label="Acts as"
                hint="A personal key stops working when you leave the workspace. A service account’s key doesn’t."
                error={fields.account}
              >
                <Select id="account" name="account" options={accountOptions} value={values.account} invalid={!!fields.account} />
              </Field>
              <Field id="role" label="Role" hint="Admin can change settings, Member can add and edit, Viewer can only read. A service account’s keys use its own role." error={fields.role}>
                <Select id="role" name="role" options={roles.map((r) => ({ value: r, label: roleLabel(r) }))} value={values.role} invalid={!!fields.role} />
              </Field>
            </div>
            <Field id="expires" label="Stops working" error={fields.expires}>
              <Select id="expires" name="expires" options={EXPIRY_CHOICES} value={values.expires} invalid={!!fields.expires} />
            </Field>
          </div>
        </Card>
        <Card title="What it can do" description="Pick only what the app needs. To change this later, make a new key.">
          <div class="stack" role="group" aria-label="Permissions">
            <Checkbox
              name="scopes"
              value="*"
              checked={values.scopes.includes('*')}
              label="Full access"
              description="Everything in every module, including modules you turn on later."
            />
            {groups.map((g) => (
              <div>
                <h3 class="lbl">{g.name}</h3>
                <div class="checks">
                  {g.scopes.map((s) => (
                    <Checkbox
                      name="scopes"
                      value={s.scope}
                      checked={values.scopes.includes(s.scope)}
                      label={s.label}
                      description={<span class="mono">{s.scope}</span>}
                    />
                  ))}
                </div>
              </div>
            ))}
            {groups.length === 0 ? <p class="hint">No module has permissions to pick yet, so full access is the only choice.</p> : null}
            {fields.scopes ? (
              <p class="err-text" role="alert">
                {fields.scopes}
              </p>
            ) : null}
          </div>
        </Card>
        <div class="row">
          <Button type="submit" variant="primary" icon="key">
            Make key
          </Button>
          <LinkButton href={BASE}>Cancel</LinkButton>
        </div>
      </form>
    </>
  );
}

/* ---------- The one-time page ---------- */

export interface SecretPageProps {
  created: ApiKey;
  secret: string;
  origin: string;
  title?: string;
  /** What else changed, for example how long the replaced key keeps working. */
  notice?: Child;
}

/**
 * Shown straight in the response to the post that made the key. It is the only page that ever
 * holds the secret: it is never put in a redirect, a cookie or a later page.
 */
export function SecretPage({ created, secret, origin, title = 'Copy your key now', notice }: SecretPageProps) {
  return (
    <>
      <PageHeader title={title} soft={created.name} />
      <div class="stack">
        <Callout tone="warn" title="You won’t see this again">
          We only keep a scrambled copy. If you lose it, revoke it and make a new one.
        </Callout>
        {notice}
        <Card title="Your key" footer={<LinkButton variant="primary" href={BASE}>I copied it</LinkButton>}>
          <div class="stack">
            <CopyField label="key" value={secret} secret={false} />
            <KeyValueList
              items={[
                { label: 'Name', value: created.name },
                { label: 'Acts as', value: created.kind === 'service' ? `${created.serviceAccountName ?? 'A service account'} (${roleLabel(created.role)})` : roleLabel(created.role) },
                { label: 'Can', value: <ScopeTags scopes={created.scopes} all /> },
                { label: 'Stops working', value: <Expiry apiKey={created} now={Date.now()} /> },
              ]}
            />
          </div>
        </Card>
        <Card title="Try it" description="Paste this into a terminal to check the key works.">
          <CodeBlock label="curl example" code={curlExample(origin, secret, created.scopes, created.role)} />
        </Card>
      </div>
    </>
  );
}

/* ---------- One key ---------- */

export interface KeyDetailProps {
  apiKey: ApiKey;
  now: number;
  /** Why this key can't be rotated by the person looking, or null when they can rotate it. */
  noRotate: string | null;
  name: string;
  nameError?: string;
}

export function KeyDetailPage({ apiKey, now, noRotate, name, nameError }: KeyDetailProps) {
  const status = shownStatus(apiKey, now);
  const live = apiKey.status === 'active';
  const id = encodeURIComponent(apiKey.id);
  return (
    <>
      <PageHeader
        title={apiKey.name}
        description={<span class="mono">{apiKey.prefix}…</span>}
        actions={
          <LinkButton href={BASE} icon="left">
            All keys
          </LinkButton>
        }
      />
      <div class="stack">
        <Card title="Details">
          <KeyValueList
            items={[
              { label: 'State', value: <StatusPill status={status} /> },
              { label: 'Kind', value: apiKey.kind === 'service' ? `Service account: ${apiKey.serviceAccountName ?? 'deleted'}` : 'Personal key' },
              { label: 'Acts as', value: roleLabel(apiKey.role) },
              {
                label: 'Can',
                value: (
                  <div class="stack">
                    {apiKey.scopes.map((s) => (
                      <div>
                        <span class="tag">{s}</span> <span class="muted">{scopeText(s)}</span>
                      </div>
                    ))}
                  </div>
                ),
              },
              { label: 'Made by', value: `${apiKey.createdByLabel ?? 'Unknown'} on ${formatDateTime(apiKey.createdAt)}` },
              { label: 'Last used', value: <LastUsed apiKey={apiKey} now={now} /> },
              { label: 'Stops working', value: <Expiry apiKey={apiKey} now={now} /> },
              ...(apiKey.revokedAt !== null ? [{ label: 'Revoked', value: formatDateTime(apiKey.revokedAt) }] : []),
              ...(apiKey.replacedBy ? [{ label: 'Replaced by', value: <a href={`${BASE}/${encodeURIComponent(apiKey.replacedBy)}`}>The key that took its place</a> }] : []),
              ...(apiKey.rotatedFrom ? [{ label: 'Replaces', value: <a href={`${BASE}/${encodeURIComponent(apiKey.rotatedFrom)}`}>The key it took over from</a> }] : []),
            ]}
          />
        </Card>

        {apiKey.revokedAt === null ? (
          <form method="post" action={`${BASE}/${id}/rename`}>
            <Card
              title="Name"
              description="Only the name changes. The secret, permissions and expiry stay as they are."
              footer={
                <Button type="submit" variant="primary">
                  Save name
                </Button>
              }
            >
              <Field id="rename" label="Name" error={nameError}>
                <Input id="rename" name="name" value={name} required maxlength={80} autocomplete="off" invalid={!!nameError} />
              </Field>
            </Card>
          </form>
        ) : (
          <Callout tone="info" title="This key is revoked">
            It no longer works and can’t be changed. Make a new key if you still need one.
          </Callout>
        )}

        {live && apiKey.replacedBy === null ? (
          noRotate ? (
            <Callout tone="info" title="Only its owner can rotate it">
              {noRotate}
            </Callout>
          ) : (
            <form method="post" action={`${BASE}/${id}/rotate`}>
              <Card
                title="Rotate the secret"
                description="Makes a new key with the same name, permissions and owner. Use it when a key may have leaked, or on a schedule."
                footer={
                  <ConfirmButton
                    id="rotate"
                    danger={false}
                    variant="default"
                    icon="refresh"
                    title={`Rotate ${apiKey.name}?`}
                    body="You get a new secret once. Apps using the old key need the new one, so update them before the old key stops."
                    confirmLabel="Rotate key"
                  >
                    Rotate key
                  </ConfirmButton>
                }
              >
                <Field id="grace" label="The old key" hint="Pick the shortest time that lets you update your apps. Stopping it right away is safest if the key leaked.">
                  <Select id="grace" name="grace" options={GRACE_CHOICES} value="0" />
                </Field>
              </Card>
            </form>
          )
        ) : null}

        {apiKey.revokedAt === null ? (
          <form method="post" action={`${BASE}/${id}/revoke`}>
            <DangerZone
              items={[
                {
                  title: 'Revoke this key',
                  description: 'Anything using it stops working right away. This can’t be undone, but you can make a new key.',
                  action: (
                    <ConfirmButton
                      id="revoke"
                      title={`Revoke ${apiKey.name}?`}
                      body="Anything using it stops working right away. This can’t be undone, but you can make a new key."
                      confirmLabel="Revoke key"
                    >
                      Revoke key
                    </ConfirmButton>
                  ),
                },
              ]}
            />
          </form>
        ) : null}
      </div>
    </>
  );
}
