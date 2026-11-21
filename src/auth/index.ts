/**
 * Auth entry points used by src/app.tsx.
 *
 * PLACEHOLDER: this file only keeps the app bootable until the real auth lands. The contract:
 * - `loadAuth` fills `user`, `org` and `auth` on the request from a session cookie, an API key
 *   (`Authorization: Bearer ts_…`, see core/apikeys.ts) or a JWT (core/jwt.ts). It never rejects.
 * - `authApp` serves /api/auth/*, /sign-in, /setup (first-run claim), /invite/:id and /welcome.
 * Role and scope checks live in core/guards.ts and only read what `loadAuth` set.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

export const loadAuth: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};

export const authApp = new Hono<AppEnv>();

authApp.get('/sign-in', (c) => c.text('Sign-in is not built yet.', 501));
