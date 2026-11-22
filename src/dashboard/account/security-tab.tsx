/** The Security tab: password, two-step sign-in and passkeys. */
import { Button, Card, ConfirmButton, Dialog, Field, Icon, Input, PasswordInput, Pill, formatDate } from '../../ui';
import { BASE, fieldError, Notice, type View } from './view';

/** The current-password box two-step actions ask for. Accounts without a password have none to ask. */
function CurrentPassword({ v, id }: { v: View; id: string }) {
  const error = fieldError(v, 'two-step', 'current');
  const locked = v.data.mode !== 'ok';
  return (
    <Field id={id} label="Current password" hint="Needed to change two-step sign-in." error={error}>
      <PasswordInput id={id} name="current" autocomplete="current-password" disabled={locked} invalid={!!error} />
    </Field>
  );
}

function PasswordCard({ v }: { v: View }) {
  const { account, mode } = v.data;
  const locked = mode !== 'ok';
  const error = fieldError(v, 'password', 'password');
  return (
    <Card title="Password" description={account.hasPassword ? 'You sign in with a password.' : 'You have no password. You sign in with an emailed code or a passkey.'}>
      <div class="stack">
        <form method="post" action={`${BASE}/password`} class="stack">
          <Notice v={v} section="password" shown={['password']} />
          <Field id="password" label={account.hasPassword ? 'New password' : 'Password'} hint="At least 10 characters. Setting one signs you out on your other devices." error={error}>
            <PasswordInput id="password" name="password" autocomplete="new-password" required minlength={10} disabled={locked} invalid={!!error} />
          </Field>
          <div class="row">
            <Button type="submit" variant="primary" disabled={locked}>
              {account.hasPassword ? 'Change password' : 'Set password'}
            </Button>
          </div>
        </form>
        {account.hasPassword ? (
          <form method="post" action={`${BASE}/password/remove`} class="row">
            {locked ? (
              <Button variant="danger" disabled>
                Remove password
              </Button>
            ) : (
              <ConfirmButton id="remove-password" title="Remove your password?" body="You will sign in with an emailed code or a passkey instead. Your username is removed too, because it only works with a password." confirmLabel="Remove password">
                Remove password
              </ConfirmButton>
            )}
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function TwoStepOff({ v }: { v: View }) {
  const locked = v.data.mode !== 'ok';
  return (
    <form method="post" action={`${BASE}/two-step/start`} class="stack">
      <Notice v={v} section="two-step" shown={['current']} />
      {v.data.account.hasPassword ? <CurrentPassword v={v} id="current-start" /> : null}
      <div class="row">
        <Button type="submit" variant="primary" disabled={locked}>
          Set up two-step
        </Button>
      </div>
    </form>
  );
}

function TwoStepOn({ v }: { v: View }) {
  const locked = v.data.mode !== 'ok';
  return (
    <form method="post" action={`${BASE}/two-step/off`} class="stack">
      <Notice v={v} section="two-step" shown={['current']} />
      {v.data.account.hasPassword ? <CurrentPassword v={v} id="current-manage" /> : null}
      <div class="row">
        {locked ? (
          <>
            <Button disabled>Make new recovery codes</Button>
            <Button variant="danger" disabled>
              Turn off two-step
            </Button>
          </>
        ) : (
          <>
            <ConfirmButton id="new-codes" danger={false} formAction={`${BASE}/two-step/codes`} title="Make new recovery codes?" body="The old codes stop working at once. You will see the new ones one time only." confirmLabel="Make new codes">
              Make new recovery codes
            </ConfirmButton>
            <ConfirmButton id="two-step-off" formAction={`${BASE}/two-step/off`} title="Turn off two-step sign-in?" body="Signing in will need only your usual details. You can turn it back on at any time." confirmLabel="Turn off">
              Turn off two-step
            </ConfirmButton>
          </>
        )}
      </div>
    </form>
  );
}

function TwoStepCard({ v }: { v: View }) {
  const on = v.data.account.twoStep;
  return (
    <Card
      title="Two-step sign-in"
      description="After your usual details, ask for a 6-digit code from an authenticator app."
      actions={<Pill tone={on ? 'good' : 'neutral'}>{on ? 'On' : 'Off'}</Pill>}
    >
      {on ? <TwoStepOn v={v} /> : <TwoStepOff v={v} />}
    </Card>
  );
}

function PasskeyRow({ v, p }: { v: View; p: View['data']['passkeys'][number] }) {
  const id = encodeURIComponent(p.id);
  const locked = v.data.mode !== 'ok';
  const renameId = `rename-${p.id}`;
  return (
    <li>
      <span class="mod-icon">
        <Icon name="key" />
      </span>
      <span class="row-text">
        <b>{p.name}</b>
        <span>{p.createdAt ? `Added ${formatDate(p.createdAt)}` : 'Added earlier'}</span>
      </span>
      {p.synced ? <Pill>Synced</Pill> : null}
      <Button size="sm" data-open={renameId} disabled={v.data.mode === 'impersonating'}>
        Rename
      </Button>
      <form method="post" action={`${BASE}/passkeys/${id}/remove`}>
        {locked ? (
          <Button size="sm" variant="danger" disabled>
            Remove
          </Button>
        ) : (
          <ConfirmButton id={`passkey-${p.id}`} size="sm" title={`Remove ${p.name}?`} body="You will no longer be able to sign in with this passkey." confirmLabel="Remove passkey">
            Remove
          </ConfirmButton>
        )}
      </form>
      <Dialog id={renameId} title="Rename passkey" size="sm" footer={<RenameFooter id={renameId} />}>
        <form id={`${renameId}-form`} method="post" action={`${BASE}/passkeys/${id}/rename`}>
          <Field id={`${renameId}-name`} label="Name">
            <Input id={`${renameId}-name`} name="name" value={p.name} required maxlength={60} autocomplete="off" />
          </Field>
        </form>
      </Dialog>
    </li>
  );
}

function RenameFooter({ id }: { id: string }) {
  return (
    <>
      <span class="spacer" />
      <Button data-close>Cancel</Button>
      <Button type="submit" variant="primary" form={`${id}-form`}>
        Save name
      </Button>
    </>
  );
}

function AddPasskey() {
  return (
    <div class="stack" data-passkey-only hidden>
      <Field id="passkey-name" label="Name for the new passkey" optional hint="For example Work laptop or Phone.">
        <Input id="passkey-name" name="passkey-name" maxlength={60} autocomplete="off" />
      </Field>
      <p class="err-text" data-passkey-error role="alert" hidden />
      <div class="row">
        <Button variant="primary" icon="plus" data-passkey-add data-name="#passkey-name" data-done={`${BASE}?tab=security`}>
          Add a passkey
        </Button>
      </div>
    </div>
  );
}

function PasskeysCard({ v }: { v: View }) {
  const { passkeys, mode } = v.data;
  return (
    <Card ruled flush title="Passkeys" description="Sign in with your fingerprint, face or screen lock instead of a password.">
      {v.problem?.section === 'passkeys' ? (
        <div class="card-body">
          <Notice v={v} section="passkeys" />
        </div>
      ) : null}
      {passkeys.length === 0 ? (
        <div class="card-body">
          <p class="hint">No passkeys yet.</p>
        </div>
      ) : (
        <ul class="rows">
          {passkeys.map((p) => (
            <PasskeyRow v={v} p={p} />
          ))}
        </ul>
      )}
      {mode === 'ok' ? (
        <div class="card-body">
          <AddPasskey />
          <script src="/assets/auth.js" defer />
        </div>
      ) : null}
    </Card>
  );
}

export function SecurityTab({ v }: { v: View }) {
  return (
    <>
      <PasswordCard v={v} />
      <TwoStepCard v={v} />
      <PasskeysCard v={v} />
    </>
  );
}
