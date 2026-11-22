/** Every state of the invite page, and the page for someone who is signed in but in no workspace. */
import { Button, Callout, Field, Input, KeyValueList, LinkButton } from '../../ui';

export const inviteFooter = 'Accounts are by invite. Nobody can join a workspace without one.';

export interface InviteFacts {
  id: string;
  workspace: string;
  inviter: string;
  /** "Admin", "Member" and so on. */
  role: string;
  /** One line on what the role may do. */
  roleHelp: string;
  /** The invited address. */
  email: string;
}

function Facts({ invite }: { invite: InviteFacts }) {
  return (
    <KeyValueList
      items={[
        { label: 'Workspace', value: invite.workspace },
        { label: 'Invited by', value: invite.inviter },
        { label: 'Your role', value: invite.role },
        { label: 'Email', value: invite.email },
      ]}
    />
  );
}

/** Signed out: prove the invited inbox is yours first. */
export function InviteStart({ invite }: { invite: InviteFacts }) {
  return (
    <section class="card">
      <h1>Join {invite.workspace}</h1>
      <p class="sub">
        {invite.inviter} invited you. {invite.roleHelp}
      </p>
      <form class="form" method="post" action={`/invite/${invite.id}/start`}>
        <Facts invite={invite} />
        <Button variant="primary" size="block" type="submit">
          Email me a code
        </Button>
        <p class="sub">We send a 6-digit code to {invite.email} to check the address is yours. No password needed.</p>
      </form>
    </section>
  );
}

export interface InviteJoinProps {
  invite: InviteFacts;
  /** Ask for a name when the account still has the one made from its email address. */
  askName: boolean;
  name?: string;
  error?: string;
}

/** Signed in as the invited address: one press to join. */
export function InviteJoin({ invite, askName, name, error }: InviteJoinProps) {
  return (
    <section class="card">
      <h1>Join {invite.workspace}</h1>
      <p class="sub">
        {invite.inviter} invited you. {invite.roleHelp}
      </p>
      <form class="form" method="post" action={`/invite/${invite.id}`} novalidate>
        <Facts invite={invite} />
        {askName ? (
          <Field id="name" label="Your name" hint="What other people in the workspace see." error={error}>
            <Input id="name" name="name" value={name ?? ''} autocomplete="name" maxlength={80} required autofocus invalid={!!error} />
          </Field>
        ) : null}
        <Button variant="primary" size="block" type="submit">
          Join workspace
        </Button>
        <p class="sub">
          <a class="link" href="/app">
            Not now
          </a>
        </p>
      </form>
    </section>
  );
}

/** Signed in as someone else. */
export function InviteWrongAccount({ invite, current }: { invite: InviteFacts; current: string }) {
  return (
    <section class="card">
      <h1>This invite is for a different email</h1>
      <p class="sub">
        You’re signed in as {current}. The invite to {invite.workspace} was sent to {invite.email}.
      </p>
      <form class="form" method="post" action={`/invite/${invite.id}/start`}>
        <Button variant="primary" size="block" type="submit">
          Sign out and use {invite.email}
        </Button>
        <LinkButton size="block" href="/app">
          Stay signed in
        </LinkButton>
        <p class="sub err-code">TS-AUTH-403</p>
      </form>
    </section>
  );
}

export function InviteExpired({ inviter, sentOn, days }: { inviter: string; sentOn: string; days: number }) {
  return (
    <section class="card">
      <h1>This invite has expired</h1>
      <p class="sub">
        Invites work for {days} days. This one was sent by {inviter} on {sentOn}. Ask them to send it again.
      </p>
      <div class="form">
        <LinkButton variant="primary" size="block" href="/sign-in">
          I already have an account
        </LinkButton>
        <p class="sub err-code">TS-AUTH-410</p>
      </div>
    </section>
  );
}

export function InviteGone() {
  return (
    <section class="card">
      <h1>This invite no longer works</h1>
      <p class="sub">It was cancelled or already used, or the link is incomplete. Ask the person who invited you for a new one.</p>
      <div class="form">
        <LinkButton variant="primary" size="block" href="/sign-in">
          I already have an account
        </LinkButton>
        <p class="sub err-code">TS-AUTH-404</p>
      </div>
    </section>
  );
}

export interface WelcomeProps {
  email: string;
  invites: { id: string; workspace: string; inviter: string; role: string }[];
  canCreate: boolean;
  name?: string;
  error?: string;
}

/** Signed in, but in no workspace: accept an invite, create a workspace (when allowed), or sign out. */
export function Welcome({ email, invites, canCreate, name, error }: WelcomeProps) {
  return (
    <section class="card">
      <h1>You’re not in a workspace yet</h1>
      <p class="sub">You’re signed in as {email}.</p>
      <div class="form">
        {invites.map((invite) => (
          <Callout
            title={`${invite.inviter} invited you to ${invite.workspace}`}
            icon="mail"
            actions={
              <LinkButton variant="primary" size="sm" href={`/invite/${invite.id}`}>
                Open invite
              </LinkButton>
            }
          >
            You would join as {invite.role}.
          </Callout>
        ))}
        {canCreate ? (
          <form class="form" method="post" action="/welcome" novalidate>
            <Field id="name" label="Workspace name" hint="Your company or team. You can change it later." error={error}>
              <Input id="name" name="name" value={name ?? ''} maxlength={60} required invalid={!!error} />
            </Field>
            <Button variant={invites.length ? 'default' : 'primary'} size="block" type="submit">
              Create workspace
            </Button>
          </form>
        ) : invites.length === 0 ? (
          <Callout tone="info" title="Ask for an invite">
            A workspace admin can invite {email}. The invite arrives by email.
          </Callout>
        ) : null}
        <form method="post" action="/sign-out">
          <Button variant="ghost" size="block" type="submit">
            Sign out
          </Button>
        </form>
      </div>
    </section>
  );
}
