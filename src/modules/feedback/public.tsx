/** Public side of Feedback: ideas, roadmap and changelog. None of these routes need a signed-in workspace user. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { changelogRoutes } from './pub/changelog';
import { feedbackRoutes } from './pub/feedback';

export const publicRoutes = new Hono<AppEnv>();
publicRoutes.route('/', feedbackRoutes);
publicRoutes.route('/', changelogRoutes);
