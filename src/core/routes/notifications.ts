/**
 * /api/v1/notifications  (the bell)
 *   GET  /            { unread, items: [{ id, title, body?, href?, at, read }] }   ?limit=20
 *   POST /read-all    mark everything read
 *   POST /:id/read    mark one read
 *
 * Notifications belong to a signed-in person, so API keys are turned away.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { errors, parse } from '../errors';
import { listNotifications, markAllRead, markRead } from '../notifications';

const app = new Hono<AppEnv>();

function who(c: Context<AppEnv>) {
  const user = c.get('user');
  const org = c.get('org');
  if (!user || c.get('auth').kind !== 'session') throw errors.forbidden('Notifications belong to a signed-in person.');
  if (!org) throw errors.unauthorized();
  return { orgId: org.id, userId: user.id, isAdmin: roleAtLeast(org.role, 'admin') };
}

app.get('/', async (c) => {
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listNotifications(c.env, { ...who(c), limit: q.limit }));
});

app.post('/read-all', async (c) => {
  await markAllRead(c.env, who(c));
  return c.json({ ok: true });
});

app.post('/:id/read', async (c) => {
  await markRead(c.env, { ...who(c), id: c.req.param('id') });
  return c.json({ ok: true });
});

export default { api: app };
