/** Reading the Email forms. The checks themselves live in the email service; these only shape the input. */
import { z } from 'zod';
import { parse } from '../../core/errors';
import { normaliseAddress } from '../../core/email';

type Body = Record<string, unknown>;

function text(body: Body, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export interface SenderInput {
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

/** Hand-sent posts can be huge; the page only ever needs to show a little of what was typed back. */
const KEEP = 1000;

/** What the sender form sent, kept as typed so a validation error can show it again. The service checks the values. */
export function readSender(body: Body): SenderInput {
  return { fromName: text(body, 'fromName').slice(0, KEEP), fromAddress: text(body, 'fromAddress').slice(0, KEEP), replyTo: text(body, 'replyTo').slice(0, KEEP) };
}

export function readTestTo(body: Body): string {
  return text(body, 'to').trim().slice(0, KEEP);
}

/** The address on an "Allow again" form. */
export function readBlockedAddress(body: Body): string {
  return normaliseAddress(parse(z.string().min(1, 'Choose an address.').max(254), text(body, 'address')));
}
