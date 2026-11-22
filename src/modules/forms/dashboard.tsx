/** Dashboard screens at /app/forms. Each area lives in its own dash-*.tsx file. */
import { Hono } from 'hono';
import { needRole } from '../../core/guards';
import type { AppEnv } from '../../env';
import { BASE } from './dash-common';
import { editRoutes } from './dash-edit';
import { importRoutes } from './dash-import';
import { listRoutes } from './dash-list';
import { responseRoutes } from './dash-responses';
import { settingsRoutes } from './dash-settings';
import { shareRoutes } from './dash-share';
import { summaryRoutes } from './dash-summary';

export const dashboard = new Hono<AppEnv>();

// Viewers can look but not change anything.
dashboard.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') needRole(c, 'member');
  await next();
});

// Fixed paths first, so they are never read as a form id.
// Fixed paths such as /privacy must be registered before the list routes, whose /:id/* patterns would swallow them.
dashboard.route('/', importRoutes);
dashboard.route('/', listRoutes);
dashboard.route('/', editRoutes);
dashboard.route('/', responseRoutes);
dashboard.route('/', summaryRoutes);
dashboard.route('/', shareRoutes);
dashboard.route('/', settingsRoutes);
dashboard.get('/:id', (c) => c.redirect(`${BASE}/${c.req.param('id')}/responses`, 302));
