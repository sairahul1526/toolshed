/** The dashboard for the waitlist module, mounted at /app/waitlist. */
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import { data } from './data';
import { editor } from './editor';
import { launch } from './launch';
import { lists } from './lists';
import { people } from './people';
import { review } from './review';
import { stats } from './stats';

export const dashboard = new Hono<AppEnv>();

for (const screen of [lists, editor, people, review, launch, stats, data]) dashboard.route('/', screen);
