/** The Account tab: name, username, email address and deleting the account. */
import { Button, Callout, Card, ConfirmButton, Field, Input, OtpInput, formatDateTime } from '../../ui';
import { BASE, fieldError, Notice, type View } from './view';

function NameCard({ v }: { v: View }) {
  const locked = v.data.mode === 'impersonating';
  return (
    <Card title="Name" description="Shown to the people you work with.">
      <form method="post" action={`${BASE}/name`} class="stack">
        <Notice v={v} section="name" shown={['name']} />
        <Field id="name" label="Full name" error={fieldError(v, 'name', 'name')}>
          <Input id="name" name="name" value={v.kept.name ?? v.data.account.name} required maxlength={80} autocomplete="name" disabled={locked} invalid={!!fieldError(v, 'name', 'name')} />
        </Field>
        <div class="row">
          <Button type="submit" variant="primary" disabled={locked}>
            Save name
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UsernameCard({ v }: { v: View }) {
  const { account, mode } = v.data;
  const locked = mode !== 'ok' || !account.hasPassword;
  const error = fieldError(v, 'username', 'username');
  const hint = account.hasPassword
    ? 'Lets you sign in with a username as well as your email. 3 to 30 letters, numbers, dots or underscores. Leave it empty to remove it.'
    : 'A username needs a password. Set one on the Security tab first.';
  return (
    <Card title="Username" description="An optional way to sign in.">
      <form method="post" action={`${BASE}/username`} class="stack">
        <Notice v={v} section="username" shown={['username']} />
        <Field id="username" label="Username" optional hint={hint} error={error}>
          <Input id="username" name="username" value={v.kept.username ?? account.username ?? ''} maxlength={30} autocomplete="username" autocapitalize="none" spellcheck={false} disabled={locked} invalid={!!error} />
        </Field>
        <div class="row">
          <Button type="submit" variant="primary" disabled={locked}>
            Save username
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PendingEmail({ v, pending }: { v: View; pending: NonNullable<View['data']['pending']> }) {
  const error = fieldError(v, 'email', 'code');
  return (
    <div class="stack">
      <Callout tone="info" title="Check your inbox">
        If {pending.email} can be used, we sent a 6-digit code there. It works until {formatDateTime(pending.expiresAt)}.
      </Callout>
      <form method="post" action={`${BASE}/email/confirm`} class="stack" data-otp-submit>
        <Notice v={v} section="email" shown={['code']} />
        <Field id="email-code" label="Code from the email" error={error}>
          <OtpInput name="code" length={6} invalid={!!error} />
        </Field>
        <div class="row">
          <Button type="submit" variant="primary">
            Confirm new email
          </Button>
          <Button type="submit" formAction={`${BASE}/email/start`} name="email" value={pending.email} formnovalidate>
            Send a new code
          </Button>
          <Button type="submit" variant="ghost" formAction={`${BASE}/email/cancel`} formnovalidate>
            Cancel change
          </Button>
        </div>
      </form>
    </div>
  );
}

function EmailCard({ v }: { v: View }) {
  const { account, mode, pending } = v.data;
  const error = fieldError(v, 'email', 'email');
  return (
    <Card title="Email" description={`Your address is ${account.email}. It is where sign-in codes and notices go.`}>
      {pending ? (
        <PendingEmail v={v} pending={pending} />
      ) : (
        <form method="post" action={`${BASE}/email/start`} class="stack">
          <Notice v={v} section="email" shown={['email']} />
          <Field id="email" label="New email address" hint="We send a code to the new address. Your email only changes once you enter it." error={error}>
            <Input id="email" name="email" type="email" value={v.kept.email ?? ''} required maxlength={254} autocomplete="email" disabled={mode !== 'ok'} invalid={!!error} />
          </Field>
          <div class="row">
            <Button type="submit" variant="primary" disabled={mode !== 'ok'}>
              Send code
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function DeleteCard({ v }: { v: View }) {
  const { account, mode, blockers } = v.data;
  const error = fieldError(v, 'delete', 'confirm');
  const blocked = blockers.length > 0;
  const off = mode !== 'ok' || blocked;
  return (
    <section class="danger-zone card" aria-label="Delete account">
      <div class="card-head ruled">
        <div>
          <h2>Delete account</h2>
          <p>Removes you and your sign-in details from every workspace. This cannot be undone.</p>
        </div>
      </div>
      <form method="post" action={`${BASE}/delete`} class="card-body stack">
        <Notice v={v} section="delete" shown={['confirm']} />
        {blocked ? (
          <Callout tone="warn" title="You are the only owner of these workspaces">
            Make someone else an owner, or delete the workspace, before you delete your account.
          </Callout>
        ) : null}
        {blocked ? (
          <ul class="rows">
            {blockers.map((w) => (
              <li>
                <span class="row-text">
                  <b>{w.name}</b>
                  <span>{w.slug}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <Field id="confirm" label={`Type ${account.email} to confirm`} error={error}>
          <Input id="confirm" name="confirm" value={v.kept.confirm ?? ''} autocomplete="off" spellcheck={false} disabled={off} invalid={!!error} />
        </Field>
        <div class="row">
          {off ? (
            <Button variant="danger" icon="trash" disabled>
              Delete account
            </Button>
          ) : (
            <ConfirmButton id="delete-account" title="Delete your account?" body="You will be signed out everywhere and your account is erased. This cannot be undone." confirmLabel="Delete my account" icon="trash">
              Delete account
            </ConfirmButton>
          )}
        </div>
      </form>
    </section>
  );
}

export function AccountTab({ v }: { v: View }) {
  return (
    <>
      <NameCard v={v} />
      <UsernameCard v={v} />
      <EmailCard v={v} />
      <DeleteCard v={v} />
    </>
  );
}
