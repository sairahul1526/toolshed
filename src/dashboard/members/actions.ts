/**
 * Reading the forms on this screen and turning a refusal from the member service into a message
 * a person can act on. The services check every value and every role again, so nothing here is
 * the only line of defence.
 */
import { INVITE_TTL_MS } from '../../auth/config';
import { AppError } from '../../core/errors';
import type { FieldErrors } from '../../core/errors';
import type { EmailStatus } from '../../core/email';
import type { Flash } from '../../ui';

type Body = Record<string, string | File | (string | File)[]>;

export function textField(body: Body, name: string): string {
  const value = body[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

export interface InviteValues {
  email: string;
  role: string;
}

export function readInvite(body: Body): InviteValues {
  return { email: textField(body, 'email').trim(), role: textField(body, 'role') || 'member' };
}

export interface InviteFailure {
  fields: FieldErrors;
  message: string | null;
  status: 403 | 404 | 409 | 422 | 429;
}

const STATUSES = new Set([403, 404, 409, 422, 429]);

/** A refusal to an invite, shown by the field it is about or above the form. Anything that is not a refusal is rethrown by the caller. */
export function inviteFailure(err: unknown): InviteFailure | null {
  if (!(err instanceof AppError)) return null;
  const status = (STATUSES.has(err.status) ? err.status : 422) as InviteFailure['status'];
  if (err.code === 'auth.already_member') return { fields: { email: err.message }, message: null, status };
  if (err.code === 'auth.role_unknown' || err.code === 'auth.role_over_owner') return { fields: { role: err.message }, message: null, status };
  const fields: FieldErrors = { ...(err.fields ?? {}) };
  const general = fields._;
  delete fields._;
  return { fields, message: general ?? (Object.keys(fields).length === 0 ? err.message : null), status };
}

/** The message for a refused change that has no form of its own to put it in. */
export function refusalFlash(err: unknown): Flash | null {
  return err instanceof AppError ? { kind: 'error', message: err.message } : null;
}

/** A name or address cut short for a message, which the flash cookie caps at 240 characters. */
export function short(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const DAYS = Math.round(INVITE_TTL_MS / 86_400_000);

/** What happened to the invite email, in words. The invite itself exists in every case. */
export function inviteFlash(status: EmailStatus, address: string, verb: 'sent' | 'sent again'): Flash {
  const email = short(address);
  const link = 'Copy its link from the Invites tab and send it yourself.';
  switch (status) {
    case 'sent':
      return { kind: 'ok', message: `Invite ${verb} to ${email}. It works for ${DAYS} days.` };
    case 'dev':
      return { kind: 'ok', message: `Invite ${verb} to ${email}. Dev mode saved the email to the outbox at /dev/outbox.` };
    case 'retrying':
      return { kind: 'ok', message: `Invite made for ${email}. The email didn’t go through yet and will be tried again shortly.` };
    case 'not_configured':
      return { kind: 'info', message: `Invite made for ${email}, but email sending isn’t set up, so nothing was sent. ${link}` };
    case 'suppressed':
      return { kind: 'info', message: `Invite made for ${email}, but that address can’t receive email from this workspace. ${link}` };
    case 'capped':
      return { kind: 'info', message: `Invite made for ${email}, but today’s email limit was reached. ${link}` };
    case 'failed':
      return { kind: 'info', message: `Invite made for ${email}, but the email couldn’t be sent. Press Resend to try again, or ${link.charAt(0).toLowerCase()}${link.slice(1)}` };
  }
}
