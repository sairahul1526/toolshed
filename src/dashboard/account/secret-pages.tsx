/**
 * The pages that show a secret: the two-step setup and fresh recovery codes. They are sent straight
 * from the POST that made them, with `no-store`, and are never redirects or flash messages, so the
 * secret exists in one response and nowhere else.
 */
import type { Child } from 'hono/jsx';
import { Button, Callout, Card, CodeBlock, CopyField, Field, LinkButton, OtpInput, PageHeader } from '../../ui';
import { BASE } from './view';

/** The QR image comes from our own generator (a fixed SVG of squares), never from user input. */
function QrCode({ svg }: { svg: string }) {
  const sized = svg.replace('<svg ', '<svg width="200" height="200" role="img" aria-label="QR code for your authenticator app" ');
  return <div class="qr" dangerouslySetInnerHTML={{ __html: sized }} />;
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div class="stack">
      <Callout tone="warn" title="Save these now">
        Each code works once if you lose your authenticator. They are shown only this one time.
      </Callout>
      <CodeBlock code={codes.join('\n')} label="recovery codes" />
    </div>
  );
}

export function SetupPage(props: { secret: string; uri: string; qrSvg: string; recoveryCodes: string[]; error?: string }) {
  return (
    <>
      <PageHeader title="Set up two-step sign-in" description="Three short steps. Nothing changes until you enter a code at the end." />
      <div class="stack">
        <Card title="1. Add it to your authenticator app" description="Scan the picture with an app such as Google Authenticator or 1Password, or type the key in by hand.">
          <div class="stack">
            <QrCode svg={props.qrSvg} />
            <CopyField label="setup key" value={props.secret} />
          </div>
        </Card>
        <Card title="2. Keep your recovery codes">
          <RecoveryCodes codes={props.recoveryCodes} />
        </Card>
        <Card title="3. Enter the code it shows">
          <ConfirmStep error={props.error} />
        </Card>
      </div>
    </>
  );
}

export function ConfirmStep({ error }: { error?: string }) {
  return (
    <form method="post" action={`${BASE}/two-step/confirm`} class="stack" data-otp-submit>
      <Field id="two-step-code" label="6-digit code" error={error}>
        <OtpInput name="code" length={6} invalid={!!error} autofocus />
      </Field>
      <div class="row">
        <Button type="submit" variant="primary">
          Turn on two-step
        </Button>
        <LinkButton href={`${BASE}?tab=security`}>Cancel</LinkButton>
      </div>
    </form>
  );
}

export function RetryPage({ error }: { error: string }) {
  return (
    <>
      <PageHeader title="Set up two-step sign-in" description="Enter the code from your authenticator app. Your recovery codes were shown on the previous page." />
      <Card title="Enter the code">
        <ConfirmStep error={error} />
      </Card>
      <p class="hint">
        Lost the setup key? <a class="link" href={`${BASE}?tab=security`}>Go back</a> and start again.
      </p>
    </>
  );
}

export function NewCodesPage({ codes }: { codes: string[] }): Child {
  return (
    <>
      <PageHeader title="New recovery codes" description="Your old codes no longer work." />
      <Card>
        <RecoveryCodes codes={codes} />
      </Card>
      <div class="row">
        <LinkButton variant="primary" href={`${BASE}?tab=security`}>
          I have saved them
        </LinkButton>
      </div>
    </>
  );
}
