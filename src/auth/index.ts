/**
 * Auth entry points used by src/app.tsx.
 *
 * - `loadAuth` fills `user`, `org` and `auth` on the request from a session cookie, an API key
 *   (`Authorization: Bearer ts_…`, see core/apikeys.ts) or a JWT (core/jwt.ts). It never rejects.
 * - `authApp` serves /sign-in, /sign-out, /setup (first-run claim), /invite/:id, /welcome and the
 *   passkey calls under /api/auth/passkey.
 * Role and scope checks live in core/guards.ts and only read what `loadAuth` set. Everything the
 * Members, Account and Users screens need is exported from ./service.
 */
// Registers the daily clean-up of used codes and ended sessions.
import './cleanup';

export { loadAuth } from './load';
export { authApp } from './routes';
export { currentSession } from './session';
export type { SessionInfo } from './session';
