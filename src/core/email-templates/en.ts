import type { Messages } from './types';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const minutes = (n: number) => plural(n, 'minute', 'minutes');
const hours = (n: number) => plural(n, 'hour', 'hours');
const days = (n: number) => plural(n, 'day', 'days');

export const en: Messages = {
  common: {
    sentBy: (brand) => `Sent by ${brand}.`,
    ignore: 'If you did not expect this email, you can ignore it.',
    linkFallback: 'If the button does not work, copy this link into your browser:',
  },
  'sign-in-code': (d, b) => ({
    subject: `Your ${b.name} sign-in code`,
    preheader: `Use the code inside to sign in. It works for ${minutes(d.minutes)}.`,
    heading: `Sign in to ${b.name}`,
    paragraphs: [`Enter this code on the sign-in page. It works for ${minutes(d.minutes)} and only once.`],
    code: d.code,
    buttonIntro: 'Or open this link on this device to sign in without typing the code:',
    button: { label: `Sign in to ${b.name}`, href: d.link },
    small: ['If you did not ask to sign in, you can ignore this email. Nobody can sign in without the code or the link.'],
  }),
  'claim-code': (d, b) => ({
    subject: `Finish setting up ${b.name}`,
    preheader: `Your setup code works for ${minutes(d.minutes)}.`,
    heading: `Finish setting up ${b.name}`,
    paragraphs: [`Enter this code to become the owner of this install. It works for ${minutes(d.minutes)}.`],
    code: d.code,
    small: ['If you did not start this setup, ignore this email and nothing changes.'],
  }),
  invite: (d, b) => ({
    subject: `${d.inviterName} invited you to ${d.workspaceName}`,
    preheader: `Join ${d.workspaceName} on ${b.name} as ${d.role}.`,
    heading: `Join ${d.workspaceName}`,
    paragraphs: [
      `${d.inviterName} invited you to ${d.workspaceName} on ${b.name}. You will join as ${d.role}.`,
      `The invite works for ${days(d.days)}.`,
    ],
    button: { label: 'Accept the invite', href: d.link },
    small: ['If you do not know this person, you can ignore this email.'],
  }),
  'email-change': (d, b) => ({
    subject: `Confirm your new email for ${b.name}`,
    preheader: `Your confirmation code works for ${minutes(d.minutes)}.`,
    heading: 'Confirm your new email address',
    paragraphs: [`Enter this code to use this address for ${b.name}. It works for ${minutes(d.minutes)}.`],
    code: d.code,
    small: ['If you did not ask for this change, ignore this email. Your account stays as it is.'],
  }),
  'new-device': (d, b) => ({
    subject: `New sign-in to ${b.name}`,
    preheader: `${d.device} signed in to your account.`,
    heading: 'New sign-in to your account',
    paragraphs: [`We saw a sign-in from a device we did not know.`, `Device: ${d.device}`, `IP address: ${d.ip}`, `Time: ${d.time}`],
    small: ['If this was you, there is nothing to do. If not, sign in, open Account, and sign out of all sessions.'],
  }),
  test: (_d, b) => ({
    subject: `Test email from ${b.name}`,
    preheader: 'Email sending works.',
    heading: 'Email sending works',
    paragraphs: [`This is a test email from ${b.name}. If you can read it, sign-in codes and invites will reach people too.`],
  }),
  'export-ready': (d) => ({
    subject: 'Your export is ready',
    preheader: `The download works for ${hours(d.hours)}.`,
    heading: 'Your export is ready',
    paragraphs: [`Everything in your workspace is in one file. The download link works for ${hours(d.hours)}, and only workspace admins can open it.`],
    button: { label: 'Download your export', href: d.link },
  }),
  notification: (d) => ({
    subject: d.title,
    preheader: d.body,
    heading: d.title,
    paragraphs: d.body ? d.body.split(/\n{2,}/) : [],
    ...(d.link ? { button: { label: d.linkLabel ?? 'Open', href: d.link } } : {}),
  }),
};
