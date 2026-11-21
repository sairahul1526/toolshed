/**
 * /api/v1/errors
 *   GET /   every error code the app can return: [{ code, status, message }]
 *
 * Public (no sign-in), because the codes are the same for everyone and clients need them.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { listErrorCodes } from '../errors';

const app = new Hono<AppEnv>();

app.get('/api/v1/errors', (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.json({ items: listErrorCodes() });
});

export default { public: app };
