/** Every state of the sign-in page. Plain forms: each one works without JavaScript, passkeys aside. */
import { Button, Callout, Checkbox, Field, Input, KeyValueList, LinkButton, OtpInput, PasswordInput } from '../../ui';
import { CODE_LENGTH, CODE_MAX_ATTEMPTS, CODE_TTL_MS } from '../config';

const CODE_MINUTES = CODE_TTL_MS / 60_000;

/** The passkey script. Loaded only on pages that have a passkey button. */
export function AuthScript() {
  return <script src="/assets/auth.js" defer />;
}

export const signInFooter = 'New here? Ask an admin of your workspace to invite you.';

/** A passkey button that stays hidden until the script knows this browser can use passkeys. */
function PasskeyButton({ next, primary }: { next: string; primary?: boolean }) {
  return (
    <>
      <Button variant={primary ? 'primary' : 'default'} size="block" icon="finger" data-passkey-signin data-next={next} hidden>
        Sign in with a passkey
      </Button>
      <p class="err-text" role="alert" data-passkey-error hidden />
    </>
  );
}

export interface EmailStepProps {
  next: string;
  email?: string;
  error?: string;
  /** A problem with the whole attempt rather than the field, for example a suspended account. */
  blocked?: string;
  /** A signed-in person proving it is still them. */
  again?: boolean;
}

export function EmailStep({ next, email, error, blocked, again }: EmailStepProps) {
  return (
    <section class="card">
      <h1>{again ? 'Sign in again' : 'Sign in'}</h1>
      <p class="sub">{again ? 'Confirm it’s you before you change how this account signs in.' : 'Use the email your workspace invited.'}</p>
      <form class="form" method="post" action="/sign-in" novalidate>
        <input type="hidden" name="next" value={next} />
        {blocked ? <Callout tone="bad">{blocked}</Callout> : null}
        <PasskeyButton next={next} />
        <div class="divider" data-passkey-only hidden>
          or
        </div>
        <Field id="email" label="Email" error={error}>
          <Input id="email" name="email" type="email" value={email ?? ''} autocomplete="username" inputmode="email" autocapitalize="none" spellcheck={false} required autofocus={!again} readonly={!!again} invalid={!!error} />
        </Field>
        <Button variant="primary" size="block" type="submit" name="intent" value="code">
          Email me a code
        </Button>
        <p class="sub">
          <button class="link" type="submit" name="intent" value="password">
            Use a password instead
          </button>
        </p>
      </form>
      <AuthScript />
    </section>
  );
}

export interface CodeStepProps {
  email: string;
  error?: string;
  /** True when the code can no longer be used and a new one is needed. */
  dead?: boolean;
}

export function CodeStep({ email, error, dead }: CodeStepProps) {
  return (
    <section class="card">
      <h1>Check your email</h1>
      <p class="sub">
        We sent a {CODE_LENGTH}-digit code to <b>{email}</b>. It works for {CODE_MINUTES} minutes.
      </p>
      <form class="form" method="post" action="/sign-in/code" data-otp-submit>
        <div>
          <OtpInput name="code" length={CODE_LENGTH} label={`${CODE_LENGTH}-digit code`} invalid={!!error} autofocus />
          {error ? (
            <p class="err-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {dead ? (
          <Button variant="primary" size="block" type="submit" form="resend-form">
            Send a new code
          </Button>
        ) : (
          <Button variant="primary" size="block" type="submit">
            Continue
          </Button>
        )}
        <div class="row">
          {dead ? null : (
            <button class="link" type="submit" form="resend-form">
              Send a new code
            </button>
          )}
          <span class="spacer" />
          <a class="link" href="/sign-in">
            Use a different email
          </a>
        </div>
        <Callout>The email also has a sign-in link. Opening it on this device works too. No email after a minute? Check the address and your spam folder.</Callout>
      </form>
      <form id="resend-form" method="post" action="/sign-in/code/resend" />
    </section>
  );
}

export interface PasswordStepProps {
  /** Known when the person typed their email on the first page. */
  email?: string;
  identifier?: string;
  error?: string;
}

export function PasswordStep({ email, identifier, error }: PasswordStepProps) {
  return (
    <section class="card">
      <h1>Enter your password</h1>
      {email ? (
        <p class="sub">
          {email} ·{' '}
          <a class="link" href="/sign-in">
            Change
          </a>
        </p>
      ) : (
        <p class="sub">Use your email or username.</p>
      )}
      <form class="form" method="post" action="/sign-in/password">
        {email ? (
          <input class="sr-only" type="text" name="username" value={email} autocomplete="username" readonly tabindex={-1} aria-hidden="true" />
        ) : (
          <Field id="identifier" label="Email or username">
            <Input id="identifier" name="identifier" value={identifier ?? ''} autocomplete="username" autocapitalize="none" spellcheck={false} required autofocus invalid={!!error} />
          </Field>
        )}
        <Field id="password" label="Password" error={error}>
          <PasswordInput id="password" name="password" required autofocus={!!email} invalid={!!error} maxlength={1024} />
        </Field>
        <Button variant="primary" size="block" type="submit">
          Sign in
        </Button>
        <div class="row">
          {email ? (
            <button class="link" type="submit" form="forgot-form">
              Forgot it? Email me a code
            </button>
          ) : null}
          <span class="spacer" />
          <a class="link" href="/sign-in">
            Sign in another way
          </a>
        </div>
      </form>
      <form id="forgot-form" method="post" action="/sign-in/password/code" />
    </section>
  );
}

export function TwoStepStep({ error, trustUntil }: { error?: string; trustUntil: string }) {
  return (
    <section class="card">
      <h1>Two-step check</h1>
      <p class="sub">Enter the 6-digit code from your authenticator app.</p>
      <form class="form" method="post" action="/sign-in/two-step" data-otp-submit>
        <div>
          <OtpInput name="code" label="Authenticator code" invalid={!!error} autofocus />
          {error ? (
            <p class="err-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <Checkbox name="trust" value="yes" label="Trust this device for 30 days" description={`You won’t be asked for a code here until ${trustUntil}.`} />
        <Button variant="primary" size="block" type="submit">
          Continue
        </Button>
        <div class="row">
          <a class="link" href="/sign-in/recovery">
            Use a recovery code
          </a>
          <span class="spacer" />
          <a class="link" href="/sign-in">
            Use a passkey
          </a>
        </div>
      </form>
    </section>
  );
}

export function RecoveryStep({ error }: { error?: string }) {
  return (
    <section class="card">
      <h1>Use a recovery code</h1>
      <p class="sub">Enter one of the codes you saved when you turned on two-step sign-in. Each one works once.</p>
      <form class="form" method="post" action="/sign-in/recovery">
        <Field id="code" label="Recovery code" error={error}>
          <Input id="code" name="code" class="mono" autocomplete="off" autocapitalize="none" spellcheck={false} required autofocus invalid={!!error} maxlength={64} />
        </Field>
        <Button variant="primary" size="block" type="submit">
          Continue
        </Button>
        <p class="sub">
          <a class="link" href="/sign-in/two-step">
            Use my authenticator app
          </a>
        </p>
      </form>
    </section>
  );
}

export interface LinkStepProps {
  token: string;
  email: string;
  device: string;
  ip: string | null;
  when: string;
  minutesLeft: number;
}

export function LinkStep({ token, email, device, ip, when, minutesLeft }: LinkStepProps) {
  return (
    <section class="card">
      <h1>Finish signing in</h1>
      <p class="sub">
        You opened a sign-in link for <b>{email}</b>.
      </p>
      <form class="form" method="post" action={`/sign-in/link/${token}`}>
        <KeyValueList
          items={[
            { label: 'Asked from', value: device },
            { label: 'IP address', value: ip ?? 'Unknown' },
            { label: 'When', value: when },
          ]}
        />
        <Button variant="primary" size="block" type="submit" autofocus>
          Finish signing in
        </Button>
        <p class="hint">
          Wasn’t you? Close this page. The link stops working in {minutesLeft} {minutesLeft === 1 ? 'minute' : 'minutes'}.
        </p>
      </form>
    </section>
  );
}

const DEAD_LINK: Record<'used' | 'expired' | 'invalid', string> = {
  used: 'It was already used. A link works once.',
  expired: `It ran out. A link works for ${CODE_MINUTES} minutes.`,
  invalid: 'Check that you opened the whole link, or ask for a new one.',
};

export function DeadLink({ state }: { state: 'used' | 'expired' | 'invalid' }) {
  return (
    <section class="card">
      <h1>This link no longer works</h1>
      <p class="sub">{DEAD_LINK[state]}</p>
      <div class="form">
        <LinkButton variant="primary" size="block" href="/sign-in">
          Sign in
        </LinkButton>
        <p class="sub err-code">TS-AUTH-410</p>
      </div>
    </section>
  );
}

export type LimitedReason = 'codes' | 'requests' | 'password' | 'two-step';

const LIMITED_WHY: Record<LimitedReason, string> = {
  codes: `We pause after ${CODE_MAX_ATTEMPTS} wrong codes in a row, to stop guessing. A passkey or the link in the email still works now.`,
  requests: 'Too many codes were asked for. The last one we sent still works until it runs out.',
  password: 'We pause after too many wrong passwords, to stop guessing. A passkey or an emailed code still works now.',
  'two-step': 'We pause after too many wrong authenticator codes, to stop guessing.',
};

export function LimitedStep({ email, wait, reason, next }: { email?: string; wait: string; reason: LimitedReason; next: string }) {
  return (
    <section class="card">
      <h1>Too many tries</h1>
      <p class="sub">{email ? <>Sign-in for {email} is paused for a moment.</> : 'Sign-in is paused for a moment.'}</p>
      <div class="form">
        <Callout tone="warn" title={`Try again in ${wait}.`}>
          {LIMITED_WHY[reason]}
        </Callout>
        <PasskeyButton next={next} primary />
        <LinkButton size="block" href="/sign-in">
          Start again
        </LinkButton>
        <p class="sub err-code">TS-AUTH-429</p>
      </div>
      <AuthScript />
    </section>
  );
}

export function InviteOnly() {
  return (
    <section class="card">
      <h1>Accounts are by invite</h1>
      <p class="sub">Ask an admin of your workspace to invite you. The invite email has a link that sets up your account.</p>
      <div class="form">
        <LinkButton variant="primary" size="block" href="/sign-in">
          I already have an account
        </LinkButton>
      </div>
    </section>
  );
}
