/** Plain words for each delivery status, shared by the log, the filter and the detail dialog. */
import type { EmailStatus } from '../../core/email';
import type { PillTone } from '../../ui';

export interface StatusInfo {
  label: string;
  tone: PillTone;
  /** One or two sentences saying what happened and what, if anything, to do. */
  meaning: string;
}

export const STATUS_INFO: Record<EmailStatus, StatusInfo> = {
  sent: { label: 'Sent', tone: 'good', meaning: 'Cloudflare accepted the email for delivery.' },
  dev: { label: 'Dev outbox', tone: 'neutral', meaning: 'Development mode. The email was saved on this machine and nothing was sent.' },
  not_configured: { label: 'Not set up', tone: 'warn', meaning: 'Email sending is not set up, so the email was not sent.' },
  failed: {
    label: 'Failed',
    tone: 'bad',
    meaning: 'The email could not be sent and will not be tried again. The reason is shown in the details. An address that bounced is also added to the blocked list.',
  },
  retrying: {
    label: 'Retrying',
    tone: 'warn',
    meaning: 'A temporary problem, such as a busy provider. We try again after 30 seconds, then after 1, 2 and 4 minutes. If it still fails, it turns into Failed.',
  },
  suppressed: {
    label: 'Blocked',
    tone: 'neutral',
    meaning: 'This address bounced or was reported before, so we stopped sending to it to protect your sending reputation. The install owner can allow it again from the Blocked addresses tab.',
  },
  capped: {
    label: 'Limit reached',
    tone: 'warn',
    meaning: 'Too many emails went to this address, or out of this install, within one hour. The email was not sent.',
  },
};

export function statusInfo(status: string): StatusInfo {
  return STATUS_INFO[status as EmailStatus] ?? { label: status, tone: 'neutral', meaning: '' };
}
