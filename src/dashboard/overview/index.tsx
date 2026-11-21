/**
 * Overview, the first screen after sign-in (/app).
 * PLACEHOLDER until the real screen lands.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';

const screen = new Hono<AppEnv>();

screen.get('/', (c) => c.text(`Overview for ${c.get('org')?.name ?? 'your workspace'}`));

export default screen;
