/** Everything the account code serves: sign-in pages, the first-run claim, invites, passkeys. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { devAuthRoutes } from './dev';
import { inviteRoutes } from './invite';
import { passkeyRoutes } from './passkey';
import { setupRoutes } from './setup';
import { signInRoutes } from './sign-in';

export const authApp = new Hono<AppEnv>();

authApp.route('/', signInRoutes);
authApp.route('/', passkeyRoutes);
authApp.route('/', setupRoutes);
authApp.route('/', inviteRoutes);
// Answers 404 outside dev and test mode.
authApp.route('/', devAuthRoutes);
