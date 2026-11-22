/** The pages for a service account: making one, and the page where it is renamed or deleted. */
import type { ApiKey, KeyRole, ServiceAccount } from '../../core/apikeys';
import type { FieldErrors } from '../../core/errors';
import { Button, Callout, Card, ConfirmButton, DangerZone, Field, Input, KeyValueList, LinkButton, PageHeader, Select, formatDateTime, plural } from '../../ui';
import { Expiry, roleLabel, ScopeTags, shownStatus, StatusPill } from './display';
import type { AccountValues } from './forms';

const BASE = '/app/api-keys';

interface AccountFormProps {
  values: AccountValues;
  fields: FieldErrors;
  message: string | null;
  roles: KeyRole[];
}

function roleOptions(roles: KeyRole[]) {
  return roles.map((r) => ({ value: r, label: roleLabel(r) }));
}

export function NewAccountPage({ values, fields, message, roles }: AccountFormProps) {
  return (
    <>
      <PageHeader title="Make a service account" description="A name for an app or a script. Its keys act with the role you pick and keep working when people leave." />
      <form method="post" action={`${BASE}/accounts/new`} class="stack">
        {message ? (
          <Callout tone="bad" title="The service account wasn’t made">
            {message}
          </Callout>
        ) : null}
        <Card title="Details">
          <div class="stack">
            <Field id="name" label="Name" hint="For example Billing sync or Nightly backup." error={fields.name}>
              <Input id="name" name="name" value={values.name} required maxlength={80} autocomplete="off" invalid={!!fields.name} />
            </Field>
            <Field id="role" label="Role" hint="Every key of this account acts as this role. Admin can change settings, Member can add and edit, Viewer can only read." error={fields.role}>
              <Select id="role" name="role" options={roleOptions(roles)} value={values.role} invalid={!!fields.role} />
            </Field>
          </div>
        </Card>
        <div class="row">
          <Button type="submit" variant="primary" icon="plus">
            Make service account
          </Button>
          <LinkButton href={`${BASE}?tab=accounts`}>Cancel</LinkButton>
        </div>
      </form>
    </>
  );
}

export interface AccountDetailProps extends AccountFormProps {
  account: ServiceAccount;
  /** The account's keys that still work. */
  keys: ApiKey[];
  now: number;
}

export function AccountDetailPage({ account, keys, now, values, fields, message, roles }: AccountDetailProps) {
  const id = encodeURIComponent(account.id);
  return (
    <>
      <PageHeader
        title={account.name}
        description="Service account"
        actions={
          <>
            <LinkButton icon="left" href={`${BASE}?tab=accounts`}>
              All service accounts
            </LinkButton>
            <LinkButton variant="primary" icon="plus" href={`${BASE}/new?account=${id}`}>
              Make a key
            </LinkButton>
          </>
        }
      />
      <div class="stack">
        <Card title="Details">
          <KeyValueList
            items={[
              { label: 'Acts as', value: roleLabel(account.role) },
              { label: 'Made by', value: `${account.createdByLabel ?? 'Unknown'} on ${formatDateTime(account.createdAt)}` },
              { label: 'Working keys', value: String(account.keyCount) },
            ]}
          />
        </Card>

        <form method="post" action={`${BASE}/accounts/${id}`}>
          <Card
            title="Name and role"
            description="A new role applies to every key of this account on its next request."
            footer={
              <Button type="submit" variant="primary">
                Save changes
              </Button>
            }
          >
            <div class="stack">
              {message ? (
                <Callout tone="bad" title="The changes weren’t saved">
                  {message}
                </Callout>
              ) : null}
              <Field id="name" label="Name" error={fields.name}>
                <Input id="name" name="name" value={values.name} required maxlength={80} autocomplete="off" invalid={!!fields.name} />
              </Field>
              <Field id="role" label="Role" error={fields.role}>
                <Select id="role" name="role" options={roleOptions(roles)} value={values.role} invalid={!!fields.role} />
              </Field>
            </div>
          </Card>
        </form>

        <Card title="Keys" description="Keys that work now. Revoked and expired keys are on the main list." flush={keys.length > 0}>
          {keys.length === 0 ? (
            <p class="muted">No working keys. Make one for this account when an app needs it.</p>
          ) : (
            <ul class="rows">
              {keys.map((k) => (
                <li>
                  <span class="row-text">
                    <b>
                      <a href={`${BASE}/${encodeURIComponent(k.id)}`}>{k.name}</a>
                    </b>
                    <span>
                      <span class="mono">{k.prefix}…</span>
                    </span>
                    <span>
                      <ScopeTags scopes={k.scopes} />
                    </span>
                  </span>
                  <Expiry apiKey={k} now={now} />
                  <StatusPill status={shownStatus(k, now)} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <form method="post" action={`${BASE}/accounts/${id}/delete`}>
          <DangerZone
            items={[
              {
                title: 'Delete this service account',
                description:
                  account.keyCount === 0 ? 'It has no working keys. This can’t be undone.' : `Its ${plural(account.keyCount, 'working key')} stop working right away. This can’t be undone.`,
                action: (
                  <ConfirmButton
                    id="delete-account"
                    title={`Delete ${account.name}?`}
                    body={
                      account.keyCount === 0
                        ? 'The service account is removed. This can’t be undone.'
                        : `${plural(account.keyCount, 'working key')} will be revoked, so anything using them stops working right away. This can’t be undone.`
                    }
                    confirmLabel="Delete service account"
                  >
                    Delete service account
                  </ConfirmButton>
                ),
              },
            ]}
          />
        </form>
      </div>
    </>
  );
}
