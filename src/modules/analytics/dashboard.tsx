/** The dashboard app, mounted at /app/analytics. Fixed paths come first, so `/sites/:id` only catches site ids. */
import { Hono } from 'hono';
import { needRole } from '../../core/guards';
import type { AppEnv } from '../../env';
import { manage } from './screens/manage';
import { report } from './screens/report';
import { sites } from './screens/sites';

export const dashboard = new Hono<AppEnv>();

// Viewers read everything and change nothing: every post needs a member, whatever the screen showed.
dashboard.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') needRole(c, 'member');
  await next();
});

dashboard.route('/', sites);
dashboard.route('/', manage);
dashboard.route('/', report);
