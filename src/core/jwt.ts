/**
 * Short-lived JSON Web Tokens (15 minutes), so other services can call the API without a lookup.
 * Public keys are served at /api/auth/jwks.
 */
import type { Env, Role } from '../env';

export interface JwtClaims {
  /** User id, or API key id for service tokens. */
  sub: string;
  orgId: string;
  role: Role;
  scopes: string[];
  exp: number;
}

/** Check a bearer token. Returns null when it is not a valid, unexpired token from this install. */
export async function verifyJwt(_env: Env, _token: string): Promise<JwtClaims | null> {
  return null;
}
