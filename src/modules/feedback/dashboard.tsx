import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { changelogAdmin } from './admin/changelog';
import { settings } from './admin/settings';
import { inbox } from './admin/inbox';

export const dashboard = new Hono<AppEnv>();
dashboard.route('/', changelogAdmin);
dashboard.route('/', settings);
dashboard.route('/', inbox);
