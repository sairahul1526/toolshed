/** The dashboard, mounted at /app/images. Each screen is its own small app; fixed paths come before `/t/:id`. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { assets } from './screens/assets';
import { batch } from './screens/batch';
import { editor } from './screens/editor';
import { settings } from './screens/settings';
import { detail } from './screens/template';
import { templates } from './screens/templates';
import { usage } from './screens/usage';

const dashboard = new Hono<AppEnv>();

dashboard.route('/', templates);
dashboard.route('/', assets);
dashboard.route('/', batch);
dashboard.route('/', usage);
dashboard.route('/', settings);
dashboard.route('/', editor);
dashboard.route('/', detail);

export { dashboard };
