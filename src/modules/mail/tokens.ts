/**
 * Signed links. Each purpose has its own key, so an unsubscribe token can never confirm a signup.
 * Unsubscribe links never expire (people unsubscribe from old emails); confirmation links do.
 */
import type { Env } from '../../env';
import { readSignedToken, signedToken } from '../../core/signing';

export const CONFIRM_DAYS = 7;

export interface PersonToken {
  /** workspace */
  o: string;
  /** subscriber */
  s: string;
  /** newsletter */
  l: string;
}

export const unsubscribeToken = (env: Env, t: PersonToken, broadcastId = ''): Promise<string> =>
  signedToken(env, 'mail.unsubscribe', { ...t, ...(broadcastId ? { b: broadcastId } : {}) });
export const readUnsubscribeToken = (env: Env, token: string) =>
  readSignedToken<PersonToken & { b?: string }>(env, 'mail.unsubscribe', token);

export const confirmToken = (env: Env, t: PersonToken): Promise<string> => signedToken(env, 'mail.confirm', { ...t }, CONFIRM_DAYS * 86400);
export const readConfirmToken = (env: Env, token: string, now?: number) => readSignedToken<PersonToken>(env, 'mail.confirm', token, now);

export interface ClickToken {
  /** workspace */
  o: string;
  /** link */
  k: string;
  /** delivery */
  d: string;
}
export const clickToken = (env: Env, t: ClickToken): Promise<string> => signedToken(env, 'mail.click', { ...t });
export const readClickToken = (env: Env, token: string) => readSignedToken<ClickToken>(env, 'mail.click', token);

export const openToken = (env: Env, t: { o: string; d: string }): Promise<string> => signedToken(env, 'mail.open', { ...t });
export const readOpenToken = (env: Env, token: string) => readSignedToken<{ o: string; d: string }>(env, 'mail.open', token);
