/**
 * Audit log (/app/audit-log): the entries, filters, CSV export and how long entries are kept.
 * Admins and owners see their own workspace. The owner of the install can also look at the whole
 * install, which adds the sign-ins and other entries that belong to no workspace.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  AUDIT_EXPORT_LIMIT,
  auditFilters,
  auditFromRequest,
  exportAuditCsv,
  getAuditRetention,
  listAudit,
  setAuditRetention,
} from '../../core/audit';
import { errors, parse, AppError } from '../../core/errors';
import { needRole } from '../../core/guards';
import type { AppEnv } from '../../env';
import { formatNumber, renderPage, setFlash } from '../../ui';
import { parseFilters } from './filters';
import { LogView, retentionText } from './view';

const PAGE_SIZE = 50;

const screen = new Hono<AppEnv>();

/** Who is asking and which entries they may read. Throws for anyone who may not open the screen. */
function access(c: Context<AppEnv>) {
  needRole(c, 'admin');
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  const isInstanceOwner = c.get('user')?.isInstanceOwner === true;
  return { org, isInstanceOwner };
}

async function showLog(c: Context<AppEnv>, opts: { retentionError?: string; status?: 422 } = {}): Promise<Response> {
  const { org, isInstanceOwner } = access(c);
  const { state, query, errors: filterErrors } = parseFilters(new URL(c.req.url).searchParams);
  if (state.scope === 'all' && !isInstanceOwner) throw errors.forbidden('Only the owner of this install can see every workspace.');
  const orgId = state.scope === 'all' ? null : org.id;
  const invalid = Object.keys(filterErrors).length > 0;

  const [page, menus, retention] = await Promise.all([
    invalid ? null : listAudit(c.env, { ...query, ...(orgId ? { orgId } : {}), ...(state.before ? { before: state.before } : {}), limit: PAGE_SIZE }),
    auditFilters(c.env, orgId),
    getAuditRetention(c.env),
  ]);

  return renderPage(
    c,
    { title: 'Audit log', crumbs: [{ label: 'Audit log' }], ...(invalid || opts.status ? { status: 422 as const } : {}) },
    <LogView
      now={Date.now()}
      state={state}
      errors={filterErrors}
      items={page?.items ?? null}
      nextCursor={page?.nextCursor ?? null}
      menus={menus}
      exportLimit={AUDIT_EXPORT_LIMIT}
      retention={retention}
      {...(opts.retentionError ? { retentionError: opts.retentionError } : {})}
      canChangeRetention={isInstanceOwner}
      isInstanceOwner={isInstanceOwner}
    />,
  );
}

screen.get('/', (c) => showLog(c));

/** Counts rows by their leading timestamp. Only used to tell the person when the file was cut. */
const rowCount = (csv: string) => (csv.match(/\r\n(?=\d{4}-\d{2}-\d{2}T)/g) ?? []).length;

screen.get('/export.csv', async (c) => {
  const { org, isInstanceOwner } = access(c);
  const { state, query, errors: filterErrors } = parseFilters(new URL(c.req.url).searchParams);
  const problem = Object.values(filterErrors)[0];
  if (problem) throw errors.validation_failed(problem, filterErrors);
  if (state.scope === 'all' && !isInstanceOwner) throw errors.forbidden('Only the owner of this install can see every workspace.');

  const body = await exportAuditCsv(c.env, { ...query, ...(state.scope === 'all' ? {} : { orgId: org.id }) });
  const count = rowCount(body);
  // After the file is built, so an export never lists itself.
  await auditFromRequest(c, { action: 'audit.exported', summary: `Exported ${count === 1 ? '1 audit log entry' : `${formatNumber(count)} audit log entries`} as CSV` });
  if (count >= AUDIT_EXPORT_LIMIT) {
    setFlash(c, {
      kind: 'info',
      message: `The export stopped at ${formatNumber(AUDIT_EXPORT_LIMIT)} entries, the newest ones. Narrow the dates to save older entries.`,
    });
  }
  return c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    'cache-control': 'no-store',
  });
});

const retentionSchema = z.object({
  retention: z.enum(['30', '90', '180', '365', 'forever'], { message: 'Choose how long to keep entries.' }),
});

screen.post('/retention', async (c) => {
  const { isInstanceOwner } = access(c);
  if (!isInstanceOwner) throw errors.forbidden('Only the owner of this install can change that.');
  let choice: string;
  try {
    choice = parse(retentionSchema, await c.req.parseBody()).retention;
  } catch (err) {
    if (err instanceof AppError && err.fields?.retention) return showLog(c, { retentionError: err.fields.retention, status: 422 });
    throw err;
  }
  const user = c.get('user');
  const saved = await setAuditRetention(c.env, choice === 'forever' ? choice : Number(choice), { id: user?.id ?? null, email: user?.email ?? null });
  setFlash(c, {
    kind: 'ok',
    message: saved === 'forever' ? 'Entries are kept forever.' : `Entries older than ${retentionText(saved)} are deleted each night.`,
  });
  return c.redirect('/app/audit-log', 303);
});

export default screen;
