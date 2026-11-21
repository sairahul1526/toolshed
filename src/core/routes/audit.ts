/**
 * /api/v1/audit
 *   GET /                  entries, newest first (filters and a cursor)
 *   GET /export.csv        the same filters as a CSV download
 *   GET /retention         how long entries are kept
 *   PUT /retention         change that (instance owner only)
 *
 * Workspace admins see their own workspace. The instance owner can add `scope=all` to see every
 * workspace and the install-wide entries.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import {
  auditFilters,
  AUDIT_RETENTION_CHOICES,
  exportAuditCsv,
  getAuditRetention,
  listAudit,
  setAuditRetention,
  type AuditQuery,
} from '../audit';
import { errors, parse, readJson } from '../errors';
import { needRole } from '../guards';

const text = z.string().trim().max(100).optional();
const time = z.coerce.number().int().min(0).optional();

const querySchema = z.object({
  actor: text,
  action: text,
  target: text,
  q: text,
  from: time,
  to: time,
  scope: z.enum(['workspace', 'all']).default('workspace'),
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const app = new Hono<AppEnv>();

function filters(c: Context<AppEnv>) {
  needRole(c, 'admin');
  const q = parse(querySchema, Object.fromEntries(new URL(c.req.url).searchParams));
  const org = c.get('org');
  if (q.scope === 'all' && !c.get('user')?.isInstanceOwner) {
    throw errors.forbidden('Only the owner of this install can see every workspace.');
  }
  const orgId = q.scope === 'all' ? null : (org?.id ?? null);
  const query: AuditQuery = {
    ...(orgId ? { orgId } : {}),
    ...(q.actor ? { actorId: q.actor } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.target ? { targetType: q.target } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.from !== undefined ? { from: q.from } : {}),
    ...(q.to !== undefined ? { to: q.to } : {}),
  };
  return { query, orgId, q };
}

app.get('/', async (c) => {
  const { query, orgId, q } = filters(c);
  const [page, menus] = await Promise.all([
    listAudit(c.env, { ...query, ...(q.before ? { before: q.before } : {}), limit: q.limit }),
    // The menus only load with the first page.
    q.before ? Promise.resolve(null) : auditFilters(c.env, orgId),
  ]);
  return c.json({ items: page.items, nextCursor: page.nextCursor, ...(menus ? { filters: menus } : {}) });
});

app.get('/export.csv', async (c) => {
  const { query } = filters(c);
  const body = await exportAuditCsv(c.env, query);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
});

function needOwner(c: Context<AppEnv>): void {
  if (!c.get('user')?.isInstanceOwner) throw errors.forbidden('Only the owner of this install can change that.');
}

app.get('/retention', async (c) => {
  needRole(c, 'admin');
  return c.json({ retention: await getAuditRetention(c.env), choices: AUDIT_RETENTION_CHOICES });
});

app.put('/retention', async (c) => {
  needOwner(c);
  const body = await readJson(c);
  const user = c.get('user');
  const retention = await setAuditRetention(c.env, body.retention, { id: user?.id ?? null, email: user?.email ?? null });
  return c.json({ retention });
});

export default { api: app };
