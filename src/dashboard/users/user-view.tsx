/** One person: what they have, and what the owner may do about it. */
import type { AdminUserDetail } from '../../auth/service';
import type { FieldErrors } from '../../core/errors';
import { Avatar, Button, Callout, Card, Field, formatDate, formatDateTime, Input, KeyValueList, LinkButton, PageHeader, Pill, plural, Select, Textarea, timeAgo } from '../../ui';
import { BAN_CHOICES, BASE, clip, userHref } from './data';

export interface UserForms {
  banReason: string;
  banDays: string;
  deleteConfirm: string;
  errors: FieldErrors;
}

export const emptyForms = (): UserForms => ({ banReason: '', banDays: '', deleteConfirm: '', errors: {} });

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

function BanNote({ user }: { user: AdminUserDetail }) {
  const until = user.banExpiresAt ? `until ${formatDateTime(user.banExpiresAt)}` : 'until you lift it';
  return (
    <Callout tone="bad" title={`Banned ${until}`}>
      {user.banReason ? `Reason: ${user.banReason.replace(/[.!?\s]+$/, '')}.` : 'No reason was given.'} They can’t sign in and every device was signed out.
    </Callout>
  );
}

function Details({ user, now }: { user: AdminUserDetail; now: number }) {
  return (
    <Card title="Details">
      <KeyValueList
        items={[
          { label: 'Email', value: user.email },
          ...(user.username ? [{ label: 'Username', value: user.username }] : []),
          {
            label: 'Workspaces',
            value:
              user.memberships.length === 0 ? (
                <span class="muted">None</span>
              ) : (
                <div class="stack">
                  {user.memberships.map((w) => (
                    <div>
                      {w.name} <span class="muted">{ROLE[w.role] ?? w.role}</span>
                    </div>
                  ))}
                </div>
              ),
          },
          { label: 'Security', value: [user.passkeys > 0 ? plural(user.passkeys, 'passkey') : null, user.twoStep ? 'Two-step on' : null].filter(Boolean).join(', ') || 'No passkey or two-step sign-in' },
          { label: 'Made', value: formatDate(user.createdAt) },
          { label: 'Last seen', value: user.lastSeenAt ? timeAgo(user.lastSeenAt, now) : 'Not signed in on any device' },
        ]}
      />
    </Card>
  );
}

function SignInAs({ user }: { user: AdminUserDetail }) {
  return (
    <Card title="Sign in as them" description="See what they see, for up to an hour. Every action is logged under your name, and account changes are blocked while you are signed in as them.">
      <form method="post" action={`${userHref(user.id)}/sign-in-as`} class="stack">
        {user.banned ? <p class="hint">Lift the ban first. A banned account can’t be signed in as.</p> : null}
        <div>
          <Button type="submit" icon="eye" disabled={user.banned}>
            Sign in as {clip(user.name || user.email, 30)}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function BanCard({ user, forms }: { user: AdminUserDetail; forms: UserForms }) {
  if (user.banned) {
    return (
      <Card title="Lift the ban" description="They can sign in again. Sessions and invites that ended when you banned them stay ended.">
        <form method="post" action={`${userHref(user.id)}/unban`}>
          <Button type="submit" icon="check">
            Lift ban
          </Button>
        </form>
      </Card>
    );
  }
  const { errors } = forms;
  return (
    <Card title="Ban" description="They can’t sign in, they are signed out on every device, their API keys stop working and the invites they sent are cancelled. You can lift the ban any time.">
      <form method="post" action={`${userHref(user.id)}/ban`} class="stack">
        <Field id="ban-reason" label="Reason" optional hint="Only you, the owner, see this." error={errors.reason}>
          <Textarea id="ban-reason" name="reason" rows={2} maxlength={200} value={forms.banReason} invalid={!!errors.reason} />
        </Field>
        <Field id="ban-days" label="For how long" error={errors.days}>
          <Select id="ban-days" name="days" options={BAN_CHOICES} value={forms.banDays} invalid={!!errors.days} />
        </Field>
        <div>
          <Button type="submit" variant="danger-solid" icon="shield">
            Ban {clip(user.name || user.email, 30)}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DeleteCard({ user, forms }: { user: AdminUserDetail; forms: UserForms }) {
  const error = forms.errors.confirm;
  return (
    <Card class="danger-zone" title="Delete account" description="This can’t be undone.">
      <form method="post" action={`${userHref(user.id)}/delete`} class="stack">
        <Callout tone="bad" title="What is lost">
          Their account, devices, passkeys and API keys are deleted for good. A person who is the only owner of a workspace can’t be deleted until that workspace has another owner or is deleted.
        </Callout>
        <Field id="delete-confirm" label={<>Type <span class="mono">{user.email}</span> to confirm</>} error={error}>
          <Input id="delete-confirm" name="confirm" value={forms.deleteConfirm} autocomplete="off" spellcheck={false} required invalid={!!error} />
        </Field>
        <div>
          <Button type="submit" variant="danger-solid" icon="trash">
            Delete account
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function UserPage({ user, now, forms }: { user: AdminUserDetail; now: number; forms: UserForms }) {
  const protectedAccount = user.isYou || user.isInstanceOwner;
  return (
    <>
      <PageHeader
        title={clip(user.name || user.email, 80)}
        description={
          <span class="row">
            <Avatar name={user.name || user.email} src={user.image} size="sm" />
            <span class="row-text"><span>{user.email}</span></span>
            {user.banned ? <Pill tone="bad">Banned</Pill> : <Pill tone="good">Active</Pill>}
            {user.isInstanceOwner ? <Pill>{user.isYou ? 'You, owner' : 'Owner'}</Pill> : null}
          </span>
        }
        actions={
          <LinkButton href={BASE} icon="left">
            All users
          </LinkButton>
        }
      />
      <div class="stack">
        {user.banned ? <BanNote user={user} /> : null}
        <Details user={user} now={now} />
        {protectedAccount ? (
          <Callout tone="info" title={user.isYou ? 'This is your account' : 'This account owns this Toolshed'}>
            It can’t be banned, deleted or signed in as from here. Manage your own account in Settings.
          </Callout>
        ) : (
          <>
            <SignInAs user={user} />
            <BanCard user={user} forms={forms} />
            <DeleteCard user={user} forms={forms} />
          </>
        )}
      </div>
    </>
  );
}
