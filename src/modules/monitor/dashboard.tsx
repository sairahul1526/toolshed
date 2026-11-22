/** The Monitor screens under /app/monitor. Changes need the Member role; settings need Admin. */
import { Hono } from 'hono';
import { needRole } from '../../core/guards';
import type { AppEnv } from '../../env';
import alerts from './dash/alerts';
import incidents from './dash/incidents';
import maintenance from './dash/maintenance';
import monitors from './dash/monitors';
import pages from './dash/pages';
import settings from './dash/settings';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') needRole(c, 'member');
  await next();
});

app.route('/', incidents);
app.route('/', alerts);
app.route('/', maintenance);
app.route('/', pages);
app.route('/', settings);
app.route('/', monitors);

export default app;
