/** Everything the account code serves: sign-in pages, the first-run claim, invites, passkeys. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { passkeyRoutes } from './passkey';
import { signInRoutes } from './sign-in';

export const authApp = new Hono<AppEnv>();

authApp.route('/', signInRoutes);
authApp.route('/', passkeyRoutes);
