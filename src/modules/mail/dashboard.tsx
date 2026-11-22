import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { sendScreens } from './dash-send';
import { peopleScreens } from './dash-people';
import { moreScreens } from './dash-more';

/** Fixed paths come before `/b/:id` style routes inside each screen file; the screens use distinct prefixes. */
export const dashboard = new Hono<AppEnv>();
dashboard.route('/', peopleScreens);
dashboard.route('/', moreScreens);
dashboard.route('/', sendScreens);
