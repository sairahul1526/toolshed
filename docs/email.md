# Email

Toolshed sends a small number of emails: sign-in codes, invites, export links and the like. It sends them
through Cloudflare Email Sending, using a binding on the Worker. There are no API keys to store.

## Turn it on

1. Add your domain to Cloudflare Email Sending. From a terminal: `npx wrangler email sending enable example.com`.
   Add the DNS records Cloudflare shows you (SPF, DKIM and DMARC) and wait until the domain shows as verified.
2. Add the binding to `wrangler.jsonc`:

   ```jsonc
   "send_email": [{ "name": "EMAIL" }]
   ```

3. Set `EMAIL_FROM` to the address emails should come from, for example `hello@example.com`. It must be on
   the domain from step 1. A new install needs this to email the code that claims it:
   `npx wrangler secret put EMAIL_FROM`, or add it under `vars` in `wrangler.jsonc`.
4. Deploy.
5. Later, the install owner can change the sender on the Email screen and send a test email. An address
   saved there wins over `EMAIL_FROM`, and clearing it there turns sending off.

Until both the binding and a sender exist (`EMAIL_FROM` or one saved on the Email screen), the Email screen
says "Needs setup" and nothing is sent. Features
that depend on email (sign-in codes, invites) tell people so instead of failing quietly.

In development (`ENVIRONMENT` is `dev` or `test`) nothing leaves the machine. Emails are saved and shown at
`/dev/outbox`, with their full text, so you can click the links.

## The emails

| Template | When it is sent |
| --- | --- |
| `sign-in-code` | Someone asks for a code to sign in. |
| `claim-code` | The first person sets up a new install. |
| `invite` | An admin invites someone to a workspace. |
| `email-change` | Someone confirms a new email address. |
| `new-device` | An account is used from a device we have not seen. |
| `test` | The owner presses "Send test email". |
| `export-ready` | A workspace export is ready to download. |
| `notification` | An alert an admin chose to get by email. |

Every email has an HTML and a plain-text version, a subject without line breaks, and one button. Texts are
available in English and Spanish and follow the install language. The logo, accent colour and footer come
from the Appearance and Email settings; the layout uses inline styles only, so it holds up in Gmail, Outlook
and Apple Mail, in light and dark mode.

## What happens when sending fails

| Result | What we do |
| --- | --- |
| Temporary problem (network, a busy provider) | Log it as `retrying`, try again after 30 seconds, then after 1, 2 and 4 minutes. After the last try it is logged as `failed` and shows in the failed jobs list for the install owner. |
| The provider says the address bounced | Log `failed` and add the address to the suppression list. |
| The provider refuses for good (bad sender, domain not verified) | Log `failed`. No retries, because they would not help. |
| The address is on the suppression list | Log `suppressed` and do not send. The owner can remove an address from the list. |
| Too many to one address, or too many overall | Log `capped` and do not send. Defaults: 10 per address per hour and 300 per install per hour. |

Suppression keeps a bad address from hurting your sending reputation. Removing an address from the list is
recorded in the audit log.

## What is logged

The delivery log keeps the time, recipient, subject, template, status, number of tries and the provider's
message id. It keeps no email body, code or link in production, because those are secrets. In development the
body is kept so the outbox page can show it. Log entries are deleted after 30 days.

## Settings

All of these are install-wide settings, changed from the Email screen or the settings API.

| Setting | Meaning |
| --- | --- |
| `email.sender` | From address, from name and optional reply-to. |
| `email.footer` | A short line at the bottom of every email, such as your postal address. |
| `email.caps` | `perRecipientPerHour` and `perInstallPerHour`. |
| `email.logRetentionDays` | How long the delivery log is kept. Default 30. |

## For developers

```ts
import { renderEmail } from './core/email-templates';
import { sendEmail } from './core/email';

const mail = await renderEmail(env, {
  template: 'invite',
  data: { inviterName: 'Sam', workspaceName: 'Acme', role: 'member', days: 7, link },
  orgId,
});
const result = await sendEmail(env, { to: 'ana@example.com', ...mail, template: 'invite', orgId });
// result.status: 'sent' | 'dev' | 'not_configured' | 'failed' | 'retrying' | 'suppressed' | 'capped'
```

`sendEmail` never throws for delivery problems; check `result.status`. Use `emailReady(env)` or
`emailStatus(env)` to decide whether to show an email-dependent feature.
