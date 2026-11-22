/**
 * The one rule for `AUTH_SECRET`, shared by everything that derives a key from it (link signing,
 * the JWT keystore, sign-in), so a weak secret is refused the same way everywhere.
 */
import { errors } from './errors';

export const MIN_SECRET_LENGTH = 32;

/** `ok`, or why the secret cannot be used: nothing set, or shorter than `MIN_SECRET_LENGTH`. */
/** The example value shipped in `.dev.vars.example`. */
export const PLACEHOLDER_SECRET = 'replace-with-a-long-random-string';

export function secretStatus(secret: unknown): 'ok' | 'missing' | 'short' {
  if (typeof secret !== 'string' || secret.trim() === '') return 'missing';
  // The value in `.dev.vars.example` is public, so it counts as not set.
  if (secret.trim() === PLACEHOLDER_SECRET) return 'missing';
  return secret.trim().length >= MIN_SECRET_LENGTH ? 'ok' : 'short';
}

/**
 * Stops with a setup error the operator can act on when `AUTH_SECRET` is missing or too short.
 * A short secret can be guessed, and everything signed with it (sessions, codes, tokens) with it.
 */
export function requireSecret(env: { AUTH_SECRET?: unknown }): void {
  if (secretStatus(env.AUTH_SECRET) !== 'ok') {
    throw errors.needs_setup(`Set AUTH_SECRET to a random value of at least ${MIN_SECRET_LENGTH} characters, then try again.`);
  }
}
