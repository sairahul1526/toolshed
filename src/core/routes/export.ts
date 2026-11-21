/**
 * /api/v1/export  (workspace admins only)
 *   POST /               start an export        -> 202 { export }
 *   GET  /               recent exports         -> { items }
 *   GET  /:id            one export             -> { export }  (progress while it runs)
 *   GET  /:id/download   the ZIP, while ready (24 hours)
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../audit';
import { errors } from '../errors';
import { getExport, listExports, openExportFile, requestExport } from '../export';
import { needRole } from '../guards';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  needRole(c, 'admin');
  await next();
});

app.post('/', async (c) => {
  const org = c.get('org')!;
  const user = c.get('user');
  const auth = c.get('auth');
  const baseUrl = c.env.APP_URL?.trim() || new URL(c.req.url).origin;
  const item = await requestExport(c.env, {
    orgId: org.id,
    userId: user?.id ?? auth.keyId ?? 'api',
    email: auth.kind === 'session' ? (user?.email ?? null) : null,
    baseUrl,
  });
  await auditFromRequest(c, { action: 'export.requested', targetType: 'export', targetId: item.id, summary: 'Asked for a workspace export' });
  return c.json({ export: item }, 202);
});

app.get('/', async (c) => c.json({ items: await listExports(c.env, c.get('org')!.id) }));

app.get('/:id', async (c) => {
  const item = await getExport(c.env, c.get('org')!.id, c.req.param('id'));
  if (!item) throw errors.not_found('We couldn’t find that export.');
  return c.json({ export: item });
});

app.get('/:id/download', async (c) => {
  const org = c.get('org')!;
  const { item, body, size } = await openExportFile(c.env, org.id, c.req.param('id'));
  await auditFromRequest(c, { action: 'export.downloaded', targetType: 'export', targetId: item.id, summary: 'Downloaded a workspace export' });
  const day = new Date(item.completedAt ?? item.createdAt).toISOString().slice(0, 10);
  const slug = (org.slug || 'workspace').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'workspace';
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${slug}-export-${day}.zip"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

export default { api: app };
