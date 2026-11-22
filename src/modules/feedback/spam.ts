/**
 * Spam control for public forms. Layers, cheapest first:
 *   1. A hidden honeypot field. Bots fill it, people never see it.
 *   2. A signed timing token. A form submitted in under two and a half seconds, or after an hour, is refused.
 *   3. Rate limits per person and per day-salted visitor id.
 *   4. A link limit for unverified people. Over the limit means the post waits for approval.
 *   5. The moderation queue, blocking a person, and trusted people who skip the queue.
 */
import { rateLimit } from '../../core/ratelimit';
import type { Env } from '../../env';
import { fbErrors } from './errors';
import { readSignedToken, signedToken, visitorId } from './lib';
import type { Board, Person, Portal } from './types';
import { countLinks } from './util';

export const MIN_FORM_MS = 2500;
export const FORM_TTL_SEC = 3600;
export const LINKS_UNVERIFIED = 1;
export const LINKS_VERIFIED = 5;

export const LIMITS = {
  post: { limit: 5, windowSec: 3600 },
  postVisitor: { limit: 10, windowSec: 3600 },
  comment: { limit: 20, windowSec: 3600 },
  vote: { limit: 120, windowSec: 3600 },
  voteVisitor: { limit: 240, windowSec: 3600 },
} as const;

export function formToken(env: Env, scope: string): Promise<string> {
  return signedToken(env, 'feedback-form', { s: scope, t: Date.now() }, FORM_TTL_SEC);
}

export type FormCheck = 'ok' | 'honeypot' | 'too_fast' | 'bad_token';

/** Check the honeypot and the timing token of a public form. */
export async function checkForm(env: Env, scope: string, token: string | null | undefined, honeypot: string | null | undefined, now = Date.now()): Promise<FormCheck> {
  if (honeypot && honeypot.trim() !== '') return 'honeypot';
  if (!token) return 'bad_token';
  const body = await readSignedToken<{ s?: string; t?: number }>(env, 'feedback-form', token);
  if (!body || body.s !== scope || typeof body.t !== 'number') return 'bad_token';
  if (now - body.t < MIN_FORM_MS) return 'too_fast';
  return 'ok';
}

export type HeldReason = 'guest' | 'moderation' | 'links' | null;

/** Should this submission wait for an admin? Verified, trusted people skip the board's moderation setting. */
export function holdReason(person: Person, board: Board | null, text: string): HeldReason {
  if (person.trusted && !person.blocked) return null;
  if (!person.verified) return 'guest';
  if (board?.moderate) return 'moderation';
  const links = countLinks(text);
  if (links > LINKS_VERIFIED) return 'links';
  return null;
}

export function linkLimitHit(person: Person, text: string): boolean {
  if (person.trusted) return false;
  return countLinks(text) > (person.verified ? LINKS_VERIFIED : LINKS_UNVERIFIED);
}

export function heldMessage(reason: HeldReason): string {
  if (reason === 'guest') return 'Thanks. An admin will look at it before it appears, because you have not confirmed an email address.';
  if (reason === 'links') return 'Thanks. Posts with several links are checked by an admin before they appear.';
  if (reason === 'moderation') return 'Thanks. An admin will look at it before it appears.';
  return '';
}

/** Count one action against the person and their visitor id. Throws a 429 when over. */
export async function throttle(env: Env, portal: Portal, kind: 'post' | 'comment' | 'vote', person: Person, req: Request): Promise<void> {
  if (person.blocked) throw fbErrors.blocked();
  const rule = LIMITS[kind];
  const byPerson = await rateLimit(env, `feedback.${kind}:p:${person.id}`, rule);
  const vid = await visitorId(env, `feedback:${portal.org_id}`, req);
  const visitorRule = kind === 'post' ? LIMITS.postVisitor : kind === 'vote' ? LIMITS.voteVisitor : rule;
  const byVisitor = await rateLimit(env, `feedback.${kind}:v:${vid}`, visitorRule);
  if (!byPerson.ok || !byVisitor.ok) {
    throw fbErrors.spam_suspected(`You are doing that a lot. Try again in ${Math.ceil(Math.max(byPerson.retryAfter, byVisitor.retryAfter) / 60)} minutes.`);
  }
}
