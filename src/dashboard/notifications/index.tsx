/**
 * Notifications (/app/notifications): everything addressed to the signed-in person, their role or
 * the whole workspace. Anyone signed in can open it; read marks belong to each person.
 *   GET  /               the list (?filter=unread, ?before=<cursor>)
 *   GET  /:id/open       marks one read, then goes to its link (a path on this site) or back to the list
 *   POST /:id/read       marks one read
 *   POST /read-all       marks everything read
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { errors, parse } from '../../core/errors';
import { markAllRead, markRead } from '../../core/notifications';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { renderPage, setFlash } from '../../ui';
import { decodeCursor, loadPage, storedHref, type Viewer } from './data';
import { returnTo, sitePath } from './links';
import { NotificationList } from './view';

const screen = new Hono<AppEnv>();

const querySchema = z.object({
  filter: z.enum(['all', 'unread']).catch('all'),
  before: z.string().optional(),
});

function viewer(c: Context<AppEnv>): Viewer {
  const user = c.get('user');
  const org = c.get('org');
  if (!user || c.get('auth').kind !== 'session') throw errors.forbidden('Notifications belong to a signed-in person.');
  if (!org) throw errors.unauthorized();
  return { orgId: org.id, userId: user.id, isAdmin: roleAtLeast(org.role, 'admin') };
}

screen.get('/', async (c) => {
  const who = viewer(c);
  const url = new URL(c.req.url);
  const q = parse(querySchema, Object.fromEntries(url.searchParams));
  const page = await loadPage(c.env, who, { filter: q.filter, cursor: decodeCursor(q.before) });
  return renderPage(
    c,
    { title: 'Notifications', crumbs: [{ label: 'Notifications' }] },
    <NotificationList rows={page.rows} filter={q.filter} unread={page.unread} next={page.next} later={q.before !== undefined} here={`${url.pathname}${url.search}`} />,
  );
});

screen.post('/read-all', async (c) => {
  await markAllRead(c.env, viewer(c));
  const body = await c.req.parseBody();
  setFlash(c, { kind: 'ok', message: 'All notifications marked as read.' });
  return c.redirect(returnTo(body.next), 303);
});

screen.post('/:id/read', async (c) => {
  await markRead(c.env, { ...viewer(c), id: c.req.param('id') });
  const body = await c.req.parseBody();
  setFlash(c, { kind: 'ok', message: 'Marked as read.' });
  return c.redirect(returnTo(body.next), 303);
});

screen.get('/:id/open', async (c) => {
  const who = viewer(c);
  const id = c.req.param('id');
  await markRead(c.env, { ...who, id });
  return c.redirect(sitePath(await storedHref(c.env, who, id)) ?? '/app/notifications', 303);
});

export default screen;
