/**
 * API keys. A key belongs to one workspace and lists the scopes it may use.
 * Only a hash of the key is stored; the full key is shown once, when it is created.
 */
import type { Env, Role } from '../env';

export interface VerifiedKey {
  orgId: string;
  keyId: string;
  name: string;
  scopes: string[];
  /** Role the key acts with inside the workspace. */
  role: Role;
}

/** Every key starts with this, so leaked keys are easy to spot and scan for. */
export const KEY_PREFIX = 'ts_';

/** Check a bearer token. Returns null when it is not a live key. */
export async function verifyApiKey(_env: Env, _token: string): Promise<VerifiedKey | null> {
  return null;
}
