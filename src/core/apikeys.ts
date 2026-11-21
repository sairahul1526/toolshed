/**
 * API keys. A key belongs to one workspace, lists the scopes it may use and acts with a role.
 * Only a hash of the key is stored; the full key is shown once, when it is created.
 *
 * This file is the public face. The parts live in `./keys/`:
 * format (what a key looks like), verify (the per-request check), manage (make, list, rename,
 * revoke, rotate), service-accounts, members (what happens when a member leaves), scopes.
 */
export { generateKey, KEY_PREFIX, parseKey } from './keys/format';
export type { KeyMode } from './keys/format';
export { createApiKey, getApiKey, listApiKeys, MAX_ACTIVE_KEYS, MAX_ROTATE_GRACE_SECONDS, renameApiKey, revokeApiKey, rotateApiKey } from './keys/manage';
export type { CreatedKey, CreateKeyInput, RotatedKey } from './keys/manage';
export { limitKeysForUser, revokeKeysForUser } from './keys/members';
export type { ApiKey, KeyKind, KeyStatus } from './keys/rows';
export { ALL_SCOPES, checkScopes, listScopes, MAX_SCOPES, scopesBeyond } from './keys/scopes';
export type { ScopeInfo } from './keys/scopes';
export {
  createServiceAccount,
  deleteServiceAccount,
  getServiceAccount,
  listServiceAccounts,
  MAX_SERVICE_ACCOUNTS,
  updateServiceAccount,
} from './keys/service-accounts';
export type { ServiceAccount } from './keys/service-accounts';
export { capRole, KEY_ROLES, keyErrors } from './keys/shared';
export type { KeyActor, KeyRole } from './keys/shared';
export { API_KEY_RATE_LIMIT, enforceApiKeyRateLimit, LAST_USED_INTERVAL_MS, touchApiKey, verifyApiKey } from './keys/verify';
export type { VerifiedKey } from './keys/verify';
