import { Hono } from 'hono';
import type { AppEnv } from '../../env';

export const authApp = new Hono<AppEnv>();
