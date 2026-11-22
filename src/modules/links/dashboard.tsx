/** The dashboard app, mounted at /app/links. Fixed paths first, so `/:id` only catches real link ids. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { bioScreen } from './dash-bio';
import { editor } from './dash-editor';
import { importScreen } from './dash-import';
import { links } from './dash-links';
import { settingsScreen } from './dash-settings';
import { statsScreen } from './dash-stats';

export const dashboard = new Hono<AppEnv>();
dashboard.route('/', statsScreen);
dashboard.route('/', bioScreen);
dashboard.route('/', importScreen);
dashboard.route('/', settingsScreen);
dashboard.route('/', links);
dashboard.route('/', editor);
