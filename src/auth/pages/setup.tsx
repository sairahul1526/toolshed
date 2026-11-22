/** Every state of the first-run setup: claim, code, name the workspace, what first, already claimed. */
import { Button, Callout, Checkbox, Field, Input, LinkButton, OtpInput, RadioCards, Select } from '../../ui';
import { CODE_LENGTH, CODE_TTL_MS } from '../config';
import { AuthScript } from './sign-in';

export const setupFooter = 'Toolshed · open source · runs on your Cloudflare account';

const STEPS = ['Claim', 'Workspace', 'What first'] as const;

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol class="steps" aria-label="Setup steps">
      {STEPS.map((name, i) => (
        <li class={i + 1 < at ? 'done' : undefined} aria-current={i + 1 === at ? 'step' : undefined}>
          <b>{i + 1}</b>
          {name}
        </li>
      ))}
    </ol>
  );
}

/** "m•••@example.com": enough to recognise the address, not enough to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '•••' : `${email.slice(0, 1)}•••${email.slice(at)}`;
}

export function ClaimStep({ ownerEmail, error }: { ownerEmail: string; error?: string }) {
  return (
    <>
      <Steps at={1} />
      <section class="card">
        <h1>Claim this Toolshed</h1>
        <p class="sub">It’s new and has no owner yet. Only the owner email set when it was deployed can claim it.</p>
        <form class="form" method="post" action="/setup">
          {error ? <Callout tone="bad">{error}</Callout> : null}
          <Field
            id="owner-email"
            label="Owner email"
            hint={
              <>
                Wrong address? Change <code>OWNER_EMAIL</code> in your Cloudflare dashboard, then open this page again.
              </>
            }
          >
            <Input id="owner-email" value={maskEmail(ownerEmail)} readonly />
          </Field>
          <Button variant="primary" size="block" type="submit" autofocus>
            Send me a code
          </Button>
        </form>
      </section>
    </>
  );
}

/** `OWNER_EMAIL` is missing or is not an email address: nobody can claim until it is set. */
export function NotClaimable() {
  return (
    <>
      <Steps at={1} />
      <section class="card">
        <h1>Set an owner email first</h1>
        <p class="sub">This Toolshed is new and has no owner yet. It can’t be claimed until it knows who the owner is.</p>
        <div class="form">
          <Callout tone="warn" title="What to do">
            Set <code>OWNER_EMAIL</code> to your email address in your Cloudflare dashboard (Workers, this Worker, Settings, Variables and secrets), then open this page again.
          </Callout>
          <LinkButton size="block" href="/setup">
            Check again
          </LinkButton>
          <p class="sub err-code">TS-AUTH-010</p>
        </div>
      </section>
    </>
  );
}

export interface ClaimCodeProps {
  ownerEmail: string;
  error?: string;
  /** True when the code can no longer be used and a new one is needed. */
  dead?: boolean;
  /** True when the code could not be emailed and was written to the Worker's log instead. */
  logged?: boolean;
}

export function ClaimCodeStep({ ownerEmail, error, dead, logged }: ClaimCodeProps) {
  const minutes = CODE_TTL_MS / 60_000;
  return (
    <>
      <Steps at={1} />
      <section class="card">
        <h1>{logged ? 'Get the code from your logs' : 'Check your email'}</h1>
        <p class="sub">
          {logged ? (
            <>This Toolshed can’t send email yet, so we wrote a {CODE_LENGTH}-digit code to its log instead. It works for {minutes} minutes.</>
          ) : (
            <>
              Enter the {CODE_LENGTH}-digit code we sent to {maskEmail(ownerEmail)}. It works for {minutes} minutes.
            </>
          )}
        </p>
        <form class="form" method="post" action="/setup/code" data-otp-submit>
          {logged ? (
            <Callout title="Where to find it">
              In your Cloudflare dashboard open Workers, this Worker, then Logs. Or run <code>npx wrangler tail</code> and ask for a new code. Look for the line that starts with “Toolshed claim code”.
            </Callout>
          ) : null}
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
              Claim it
            </Button>
          )}
          {dead ? null : (
            <p class="hint">
              {logged ? 'Can’t find it? ' : 'No email after a minute? Check spam, or '}
              <button class="link" type="submit" form="resend-form">
                {logged ? 'Write a new code to the log' : 'send a new code'}
              </button>
              .
            </p>
          )}
        </form>
        <form id="resend-form" method="post" action="/setup" />
      </section>
    </>
  );
}

export function ClaimPaused({ wait }: { wait: string }) {
  return (
    <>
      <Steps at={1} />
      <section class="card">
        <h1>Too many tries</h1>
        <p class="sub">Claiming is paused for a moment.</p>
        <div class="form">
          <Callout tone="warn" title={`Try again in ${wait}.`}>
            We pause after too many codes or wrong guesses, so nobody can guess their way in.
          </Callout>
          <LinkButton size="block" href="/setup">
            Start again
          </LinkButton>
          <p class="sub err-code">TS-AUTH-429</p>
        </div>
      </section>
    </>
  );
}

export interface WorkspaceStepProps {
  values: { name: string; slug: string; yourName: string; timezone: string };
  timezones: string[];
  errors?: Partial<Record<'name' | 'slug' | 'yourName' | 'timezone', string>>;
  /** True on the first visit: the script may pick the browser's own time zone. */
  detectZone?: boolean;
}

export function WorkspaceStep({ values, timezones, errors = {}, detectZone }: WorkspaceStepProps) {
  return (
    <>
      <Steps at={2} />
      <section class="card">
        <h1>Name your workspace</h1>
        <p class="sub">You can change all of this later in Settings.</p>
        <form class="form" method="post" action="/setup/workspace" novalidate>
          <Field id="name" label="Workspace name" error={errors.name}>
            <Input id="name" name="name" value={values.name} maxlength={60} required autofocus invalid={!!errors.name} autocomplete="organization" />
          </Field>
          <Field id="slug" label="Short name" optional hint="Used in links and emails. Letters, numbers and dashes. Leave it empty and we make one from the name." error={errors.slug}>
            <Input id="slug" name="slug" class="mono" value={values.slug} maxlength={40} autocapitalize="none" spellcheck={false} autocomplete="off" invalid={!!errors.slug} />
          </Field>
          <div class="form-row">
            <Field id="your-name" label="Your name" error={errors.yourName}>
              <Input id="your-name" name="yourName" value={values.yourName} maxlength={80} required autocomplete="name" invalid={!!errors.yourName} />
            </Field>
            <Field id="timezone" label="Time zone" error={errors.timezone}>
              <Select id="timezone" name="timezone" value={values.timezone} options={timezones.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))} invalid={!!errors.timezone} {...(detectZone ? { 'data-timezone': '' } : {})} />
            </Field>
          </div>
          <Button variant="primary" size="block" type="submit">
            Continue
          </Button>
        </form>
        {detectZone ? <AuthScript /> : null}
      </section>
    </>
  );
}

export interface FirstCard {
  id: string;
  title: string;
  body: string;
  icon: string;
  /** True when the module can fill itself with sample rows. */
  hasSample: boolean;
}

export function FirstStep({ cards, error }: { cards: FirstCard[]; error?: string }) {
  return (
    <>
      <Steps at={3} />
      <section class="card">
        <h1>What do you want to do first?</h1>
        <p class="sub">We switch that module on and take you straight to it. Pick one.</p>
        <form class="form" method="post" action="/setup/first">
          {error ? (
            <p class="err-text" role="alert">
              {error}
            </p>
          ) : null}
          <RadioCards name="module" label="What to do first" columns={2} options={cards.map((card) => ({ value: card.id, label: card.title, description: card.body, icon: card.icon }))} />
          {cards.some((card) => card.hasSample) ? (
            <Checkbox name="sample" value="yes" checked label="Show sample data" description="So the pages aren’t empty. It goes away when real data arrives." />
          ) : null}
          <Button variant="primary" size="block" type="submit">
            Open my dashboard
          </Button>
          <p class="sub">
            <a class="link" href="/app">
              Skip, I’ll look around first
            </a>
          </p>
        </form>
      </section>
    </>
  );
}

export function AlreadyClaimed({ signedIn }: { signedIn: boolean }) {
  return (
    <section class="card">
      <h1>This Toolshed already has an owner</h1>
      <p class="sub">{signedIn ? 'There is nothing left to set up here.' : 'Ask them to invite you. If you already have an account, sign in.'}</p>
      <div class="form">
        <LinkButton variant="primary" size="block" href={signedIn ? '/app' : '/sign-in'}>
          {signedIn ? 'Open my dashboard' : 'Sign in'}
        </LinkButton>
        <p class="sub err-code">TS-AUTH-011</p>
      </div>
    </section>
  );
}
