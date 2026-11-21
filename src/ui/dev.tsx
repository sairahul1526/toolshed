/**
 * /dev/ui: every UI kit component on one page, dev only.
 * PLACEHOLDER; the UI kit fills it in.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';

export const devUi = new Hono<AppEnv>();

devUi.get('/', (c) => c.text('The UI kit page is not built yet.'));
