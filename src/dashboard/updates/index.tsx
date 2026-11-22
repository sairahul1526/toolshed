/**
 * Updates (/app/updates): what this install is running and how to update it. Only the person who
 * claimed the install can open it, and every action re-checks that on the server.
 *
 * The Worker cannot redeploy itself or look for new releases (a page never calls other sites), so
 * the update itself happens in the owner's terminal. This screen shows the steps and the result.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { AppError, errors, parse } from '../../core/errors';
import { retryJobFailure } from '../../core/jobs';
import type { AppEnv } from '../../env';
import { renderPage, setFlash } from '../../ui';
import { loadUpdatesPage, readBefore } from './data';
import { UpdatesView } from './view';

const screen = new Hono<AppEnv>();

screen.use('*', async (c, next) => {
  if (!c.get('user')?.isInstanceOwner) throw errors.forbidden('Only the owner of this install can open Updates.');
  await next();
});

screen.get('/', async (c) => {
  const before = readBefore(c.req.query('before'));
  const page = await loadUpdatesPage(c.env, { before });
  return renderPage(c, { title: 'Updates', crumbs: [{ label: 'Updates' }] }, <UpdatesView page={page} before={before ?? null} />);
});

const retryForm = z.object({ before: z.string().max(20).optional() });

screen.post('/jobs/:id/retry', async (c) => {
  const id = parse(z.string().regex(/^jf_[0-9a-z]{10,40}$/, 'That failed job id is not valid.'), c.req.param('id'));
  const form = parse(retryForm, await c.req.parseBody());
  const back = readBefore(form.before);
  const to = back ? `/app/updates?before=${back}#failed-jobs` : '/app/updates#failed-jobs';
  try {
    await retryJobFailure(c.env, id);
  } catch (err) {
    // A job that is gone or was too private to keep is a normal answer, not a crash.
    if (err instanceof AppError && (err.code === 'not_found' || err.code === 'conflict')) {
      setFlash(c, { kind: 'error', message: err.message });
      return c.redirect(to, 303);
    }
    throw err;
  }
  await auditFromRequest(c, {
    orgId: null,
    action: 'updates.job_retried',
    targetType: 'job_failure',
    targetId: id,
    summary: 'Put a failed background job back on the queue',
  });
  setFlash(c, { kind: 'ok', message: 'The job is back on the queue. It will run again within a minute or so.' });
  return c.redirect(to, 303);
});

export default screen;
