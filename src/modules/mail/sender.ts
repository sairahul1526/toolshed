/**
 * The only door to a mail provider. Mail never talks to one directly: it hands a finished message
 * to a `Sender`, and the only implementation, `coreSender`, calls the core `sendEmail`. A different
 * sender (a dedicated bulk provider later) only has to implement this interface.
 */
import { sendEmail, type EmailMessage } from '../../core/email';
import type { Env } from '../../env';

export type MailKind = 'mail.broadcast' | 'mail.confirm' | 'mail.sequence' | 'mail.test' | 'mail.transactional';

export interface Outgoing {
  orgId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  tag: MailKind;
  /** Groups the delivery log and makes "did we already send this?" answerable: `mail:<broadcast id>`. */
  template: string;
  replyTo?: string;
  /** `List-Unsubscribe` and `List-Unsubscribe-Post`, for one-click unsubscribe in mail apps. */
  headers?: Record<string, string>;
}

export type SendResult =
  | { ok: true; dev: boolean }
  | { ok: false; kind: 'suppressed' | 'capped' | 'not_configured' | 'failed'; error: string };

export interface Sender {
  send(message: Outgoing): Promise<SendResult>;
  /** True when a message with this `template` already went to this address. Used to resume a crashed send without repeating it. */
  alreadySent(orgId: string, to: string, template: string): Promise<boolean>;
}

export function coreSender(env: Env): Sender {
  return {
    async send(message) {
      const result = await sendEmail(env, { ...message } as EmailMessage);
      switch (result.status) {
        case 'sent':
        case 'retrying': // core queued its own retry; it will not be sent twice
          return { ok: true, dev: false };
        case 'dev':
          return { ok: true, dev: true };
        case 'suppressed':
          return { ok: false, kind: 'suppressed', error: result.error ?? 'This address can’t receive email.' };
        case 'capped':
          return { ok: false, kind: 'capped', error: result.error ?? 'The hourly email limit was reached.' };
        case 'not_configured':
          return { ok: false, kind: 'not_configured', error: 'Email sending isn’t set up for this install.' };
        default:
          return { ok: false, kind: 'failed', error: result.error ?? 'The email couldn’t be sent.' };
      }
    },
    async alreadySent(_orgId, to, template) {
      const row = await env.DB.prepare("SELECT 1 AS hit FROM email_log WHERE to_addr = ?1 AND template = ?2 AND status IN ('sent', 'dev', 'retrying') LIMIT 1")
        .bind(to.toLowerCase(), template)
        .first();
      return row !== null;
    },
  };
}
