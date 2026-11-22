/**
 * The one rule for `AUTH_SECRET`, shared by everything that derives a key from it (link signing,
 * the JWT keystore), so a weak secret is refused the same way everywhere.
 */
export const MIN_SECRET_LENGTH = 32;

/** `ok`, or why the secret cannot be used: nothing set, or shorter than `MIN_SECRET_LENGTH`. */
export function secretStatus(secret: unknown): 'ok' | 'missing' | 'short' {
  if (typeof secret !== 'string' || secret.trim() === '') return 'missing';
  return secret.trim().length >= MIN_SECRET_LENGTH ? 'ok' : 'short';
}
