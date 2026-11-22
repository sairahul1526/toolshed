# Email

Email sends sign-in codes, invites, export links and other messages from your own address, through Cloudflare Email Sending. This screen shows whether it works, lets you choose the sender, and shows what was sent.

## Who can do what

- The person who runs this install (the instance owner) can change the sender, send a test, and manage blocked addresses.
- Workspace admins can see whether email is set up, read the delivery log for their own workspace, and preview the emails.
- Members and viewers cannot open this screen.

## Turn email on

1. In your Cloudflare dashboard, open Email Sending and add the domain you want to send from. Add the SPF, DKIM and DMARC records it shows you, and wait until the domain is verified.
2. Add the email binding to your Worker (`"send_email": [{ "name": "EMAIL" }]` in the Worker config) and deploy again.
3. Come back to the Setup tab, enter an address on that domain under Sender, and save.
4. Send yourself a test email. The result appears right under the button.

Until all of this is done, nothing is sent. Features that need email say so instead of failing quietly.

## The tabs

- **Setup.** Status, the sender, the test email and the sending limits. The limits are read-only for now.
- **Templates.** Preview each built-in email in English and Spanish, with sample data. You see the subject, the plain-text version and the HTML source.
- **Delivery log.** Every email the install tried to send, newest first. Filter by status, search by address or subject, and open Details for the error. Entries are deleted after 30 days, and no email text, code or link is ever stored.
- **Blocked addresses.** Addresses that bounced or were reported. We do not email them, which protects your sending reputation.

## What the statuses mean

- **Sent:** Cloudflare accepted it.
- **Dev outbox:** development mode kept it instead of sending.
- **Not set up:** email was off when it was tried.
- **Retrying:** a temporary problem. We try again a few times over several minutes.
- **Failed:** it was not sent and will not be tried again. Details says why.
- **Blocked:** the address bounced before, so we did not try.
- **Limit reached:** too many emails went out that hour.

## Allow a blocked address again

Choose Allow again and confirm. Do this only if the address was fixed. If it cannot receive email it will bounce again, and repeated bounces can hurt your sending reputation. Every change is recorded in the audit log.
