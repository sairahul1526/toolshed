/** Everything the account code serves: sign-in pages, the first-run claim, invites, passkeys. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { devAuthRoutes } from './dev';
import { inviteRoutes } from './invite';
import { passkeyRoutes } from './passkey';
import { setupRoutes } from './setup';
import { signInRoutes } from './sign-in';

export const authApp = new Hono<AppEnv>();

/**
 * Pages where someone types a code or a password, claims the install or accepts an invite never
 * load inside another site's frame, so nobody can lay their own page over the buttons. The first
 * header is today's rule; the second is for browsers that only know the old one.
 */
for (const path of ['/sign-in', '/sign-in/*', '/setup', '/setup/*', '/invite/*', '/welcome', '/welcome/*']) {
  authApp.use(path, async (c, next) => {
    await next();
    c.header('content-security-policy', "frame-ancestors 'none'");
    c.header('x-frame-options', 'DENY');
  });
}

authApp.route('/', signInRoutes);
authApp.route('/', passkeyRoutes);
authApp.route('/', setupRoutes);
authApp.route('/', inviteRoutes);
// Answers 404 outside dev and test mode.
authApp.route('/', devAuthRoutes);
