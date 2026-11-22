/**
 * Settings (/app/settings): rename the workspace and change its address, manage webhooks, export
 * everything, and delete the workspace.
 *
 * A thin front for the existing services. They check the role and the rules; the guards here only
 * keep people off pages and buttons they could not use. Webhooks and exports follow the same rules
 * as their REST routes: admins only, and nothing that outlives the session while an owner is
 * signed in as someone else, except a rename.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { renameWorkspace, deleteWorkspace } from '../../auth/service';
import { auditFromRequest } from '../../core/audit';
import { AppError, errors } from '../../core/errors';
import type { FieldErrors } from '../../core/errors';
import { listExports, requestExport } from '../../core/export';
import { needRole, refuseWhileImpersonating } from '../../core/guards';
import { enforceRateLimit } from '../../core/ratelimit';
import { createEndpoint, deleteEndpoint, eventCatalog, getEndpoint, listEndpoints, revealEndpointSecret, updateEndpoint } from '../../core/webhooks';
import type { Actor, WebhookEndpoint } from '../../core/webhooks';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { renderPage, setFlash } from '../../ui';
import { DataTab } from './data-tab';
import { failureOf, listField, textField } from './forms';
import type { Body } from './forms';
import { Frame, readTab } from './frame';
import type { TabId } from './frame';
import { GeneralTab } from './general-tab';
import { hookHref, HookPage, NewHookPage, SecretPage, WebhooksTab } from './webhooks-tab';
import type { HookValues } from './webhooks-tab';

const BASE = '/app/settings';
const CRUMBS = [{ label: 'Workspace' }, { label: 'Settings' }];

const screen = new Hono<AppEnv>();

/* ---------- Small helpers ---------- */

const impersonating = (c: Context<AppEnv>): boolean => Boolean(c.get('auth').impersonatedBy);

const IMPERSONATING_EXPORT = 'Stop signing in as someone else first. An export holds the whole workspace and can be downloaded for a day.';
const IMPERSONATING_DELETE = 'Stop signing in as someone else first. Deleting a workspace can’t be done from a session that is acting as another person.';

function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user');
  return { userId: user?.id ?? c.get('auth').keyId ?? '', label: user ? user.name || user.email : null };
}

const emptyHook = (): HookValues => ({ name: '', url: '', events: [] });

/** What the webhook forms posted, as the service wants it. */
function hookValues(body: Body): HookValues {
  return { name: textField(body, 'name'), url: textField(body, 'url'), events: listField(body, 'events') };
}

/* ---------- The three tabs ---------- */

interface TabInit {
  general?: { name: string; slug: string; errors?: FieldErrors; message?: string | null };
  data?: { errors?: FieldErrors; deleteBlock?: string | null };
  status?: 409 | 422;
}

async function renderTab(c: Context<AppEnv>, tab: TabId, init: TabInit = {}): Promise<Response> {
  const org = c.get('org')!;
  const admin = roleAtLeast(org.role, 'admin');
  const now = Date.now();
  const host = new URL(c.req.url).host;
  let body;
  if (tab === 'webhooks') {
    body = <WebhooksTab endpoints={admin ? await listEndpoints(c.env, org.id) : []} canManage={admin} now={now} />;
  } else if (tab === 'data') {
    const exports = admin ? await listExports(c.env, org.id, 20, now) : [];
    const blocked = impersonating(c);
    body = (
      <DataTab
        exports={exports}
        canExport={admin}
        exportBlock={blocked ? IMPERSONATING_EXPORT : null}
        isOwner={org.role === 'owner'}
        orgName={org.name}
        orgSlug={org.slug}
        deleteBlock={init.data?.deleteBlock ?? (blocked ? IMPERSONATING_DELETE : null)}
        errors={init.data?.errors}
      />
    );
  } else {
    const g = init.general;
    body = <GeneralTab values={{ name: g?.name ?? org.name, slug: g?.slug ?? org.slug }} orgName={org.name} host={host} errors={g?.errors} message={g?.message} canEdit={admin} />;
  }
  return renderPage(c, { title: 'Settings', crumbs: CRUMBS, status: init.status }, <Frame tab={tab} orgName={org.name}>{body}</Frame>);
}

screen.get('/', (c) => renderTab(c, readTab(c.req.query('tab'))));

/* ---------- General ---------- */

screen.post('/general', async (c) => {
  needRole(c, 'admin');
  const body = (await c.req.parseBody()) as Body;
  const name = textField(body, 'name');
  const slug = textField(body, 'slug');
  try {
    const before = c.get('org')!;
    const after = await renameWorkspace(c, { name, slug });
    const changed = after.name !== before.name || after.slug !== before.slug;
    setFlash(c, { kind: 'ok', message: changed ? 'Workspace saved.' : 'Nothing changed, so nothing was saved.' });
    return c.redirect(BASE, 303);
  } catch (err) {
    const failure = failureOf(err);
    if (!failure) throw err;
    return renderTab(c, 'general', { general: { name, slug, errors: failure.fields, message: failure.message }, status: failure.status });
  }
});

/* ---------- Data ---------- */

screen.post('/export', async (c) => {
  needRole(c, 'admin');
  const user = c.get('user');
  const auth = c.get('auth');
  if (auth.impersonatedBy) {
    setFlash(c, { kind: 'error', message: IMPERSONATING_EXPORT });
    return c.redirect(`${BASE}?tab=data`, 303);
  }
  const baseUrl = c.env.APP_URL?.trim() || new URL(c.req.url).origin;
  try {
    const item = await requestExport(c.env, { orgId: c.get('org')!.id, userId: user?.id ?? '', email: user?.email ?? null, baseUrl });
    await auditFromRequest(c, { action: 'export.requested', targetType: 'export', targetId: item.id, summary: 'Asked for a workspace export' });
    setFlash(c, { kind: 'ok', message: 'Export started. It usually takes a minute or two. We’ll email you when it’s ready.' });
  } catch (err) {
    if (!(err instanceof AppError) || (err.status !== 409 && err.status !== 429)) throw err;
    setFlash(c, { kind: 'error', message: err.message });
  }
  return c.redirect(`${BASE}?tab=data`, 303);
});

screen.post('/delete', async (c) => {
  needRole(c, 'owner');
  if (impersonating(c)) {
    setFlash(c, { kind: 'error', message: IMPERSONATING_DELETE });
    return c.redirect(`${BASE}?tab=data`, 303);
  }
  const confirm = textField((await c.req.parseBody()) as Body, 'confirm');
  try {
    await deleteWorkspace(c, { confirm });
  } catch (err) {
    if (err instanceof AppError && err.code === 'auth.sign_in_again') {
      return renderTab(c, 'data', { data: { deleteBlock: err.message }, status: 409 });
    }
    const failure = failureOf(err);
    if (!failure) throw err;
    return renderTab(c, 'data', { data: { errors: failure.fields }, status: 422 });
  }
  setFlash(c, { kind: 'ok', message: 'The workspace was deleted.' });
  return c.redirect('/app', 303);
});

/* ---------- Webhooks ---------- */

screen.use('/webhooks/*', async (c, next) => {
  needRole(c, 'admin');
  await next();
});
screen.use('/webhooks', async (c, next) => {
  needRole(c, 'admin');
  await next();
});

const hookTab = `${BASE}?tab=webhooks`;
screen.get('/webhooks', (c) => c.redirect(hookTab, 303));

async function renderNewHook(c: Context<AppEnv>, init: { values: HookValues; errors?: FieldErrors; message?: string | null; status?: 409 | 422 }) {
  return renderPage(
    c,
    { title: 'Add a webhook', crumbs: [...CRUMBS, { label: 'Add a webhook' }], status: init.status },
    <NewHookPage values={init.values} errors={init.errors ?? {}} message={init.message ?? null} catalog={eventCatalog()} />,
  );
}

screen.get('/webhooks/new', (c) => renderNewHook(c, { values: emptyHook() }));

/**
 * The one place a new signing secret leaves the server: the response to this post. It is never put in
 * a redirect, a cookie or a later page. renderPage sends no-store.
 */
screen.post('/webhooks', async (c) => {
  refuseWhileImpersonating(c.get('auth').impersonatedBy);
  const org = c.get('org')!;
  const values = hookValues((await c.req.parseBody({ all: true })) as Body);
  try {
    await enforceRateLimit(c.env, `webhooks.create:${org.id}`, { limit: 20, windowSec: 3600 });
    const { endpoint, secret } = await createEndpoint(c.env, org.id, actorOf(c), values);
    await auditFromRequest(c, {
      action: 'webhook.created',
      targetType: 'webhook_endpoint',
      targetId: endpoint.id,
      summary: `Added the webhook endpoint “${endpoint.name}”`,
      meta: { events: endpoint.events },
    });
    return renderPage(c, { title: 'Webhook added', crumbs: [...CRUMBS, { label: 'Webhook added' }] }, <SecretPage endpoint={endpoint} secret={secret} fresh />);
  } catch (err) {
    const failure = failureOf(err);
    if (failure) return renderNewHook(c, { values, errors: failure.fields, message: failure.message, status: failure.status === 409 ? 409 : 422 });
    if (err instanceof AppError && (err.code === 'webhooks.too_many' || err.status === 429)) return renderNewHook(c, { values, message: err.message, status: 409 });
    throw err;
  }
});

async function renderHook(c: Context<AppEnv>, id: string, init: { values?: HookValues; errors?: FieldErrors; message?: string | null; status?: 409 | 422 } = {}) {
  const endpoint = await getEndpoint(c.env, c.get('org')!.id, id);
  const values = init.values ?? { name: endpoint.name, url: endpoint.url, events: endpoint.events };
  return renderPage(
    c,
    { title: endpoint.name, crumbs: [...CRUMBS, { label: endpoint.name }], status: init.status },
    <HookPage endpoint={endpoint} values={values} errors={init.errors ?? {}} message={init.message ?? null} catalog={eventCatalog()} nameOnly={impersonating(c)} />,
  );
}

screen.get('/webhooks/:id', (c) => renderHook(c, c.req.param('id')));

screen.post('/webhooks/:id', async (c) => {
  const org = c.get('org')!;
  const id = c.req.param('id');
  const body = (await c.req.parseBody({ all: true })) as Body;
  const values = hookValues(body);
  // A rename is harmless. A new address or event list would keep sending after a "sign in as" hour ends.
  const input = impersonating(c) ? { name: values.name } : { name: values.name, url: values.url, events: values.events };
  try {
    const { endpoint, changed } = await updateEndpoint(c.env, org.id, id, input);
    if (changed.length > 0) {
      await auditFromRequest(c, {
        action: 'webhook.updated',
        targetType: 'webhook_endpoint',
        targetId: endpoint.id,
        summary: `Changed the webhook endpoint “${endpoint.name}”`,
        meta: { fields: changed },
      });
    }
    setFlash(c, { kind: 'ok', message: changed.length > 0 ? `Saved ${endpoint.name}.` : 'Nothing changed, so nothing was saved.' });
    return c.redirect(hookHref(id), 303);
  } catch (err) {
    const failure = failureOf(err);
    if (!failure) throw err;
    return renderHook(c, id, { values, errors: failure.fields, message: failure.message, status: 422 });
  }
});

screen.post('/webhooks/:id/status', async (c) => {
  refuseWhileImpersonating(c.get('auth').impersonatedBy);
  const id = c.req.param('id');
  const wanted = textField((await c.req.parseBody()) as Body, 'status') === 'paused' ? 'paused' : 'active';
  const { endpoint } = await updateEndpoint(c.env, c.get('org')!.id, id, { status: wanted });
  await auditFromRequest(c, {
    action: 'webhook.updated',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    summary: `${wanted === 'paused' ? 'Paused' : 'Turned on'} the webhook endpoint “${endpoint.name}”`,
    meta: { fields: ['status'] },
  });
  setFlash(c, { kind: 'ok', message: wanted === 'paused' ? `Paused ${endpoint.name}. Nothing is sent until you turn it on.` : `${endpoint.name} is on.` });
  return c.redirect(hookHref(id), 303);
});

/** Show the signing secret again. A post, so it is never in a link, and a signed-in person only. */
screen.post('/webhooks/:id/secret', async (c) => {
  if (c.get('auth').kind !== 'session') throw errors.forbidden('Only a signed-in person can see a signing secret.');
  refuseWhileImpersonating(c.get('auth').impersonatedBy);
  const org = c.get('org')!;
  const endpoint = await getEndpoint(c.env, org.id, c.req.param('id'));
  const { secret } = await revealEndpointSecret(c.env, org.id, endpoint.id);
  await auditFromRequest(c, {
    action: 'webhook.secret_viewed',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    summary: `Viewed the signing secret of “${endpoint.name}”`,
  });
  return renderPage(c, { title: 'Signing secret', crumbs: [...CRUMBS, { label: endpoint.name, href: hookHref(endpoint.id) }, { label: 'Signing secret' }] }, <SecretPage endpoint={endpoint} secret={secret} fresh={false} />);
});

screen.post('/webhooks/:id/delete', async (c) => {
  refuseWhileImpersonating(c.get('auth').impersonatedBy);
  const org = c.get('org')!;
  const endpoint: WebhookEndpoint = await getEndpoint(c.env, org.id, c.req.param('id'));
  await deleteEndpoint(c.env, org.id, endpoint.id);
  await auditFromRequest(c, {
    action: 'webhook.deleted',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    summary: `Deleted the webhook endpoint “${endpoint.name}”`,
  });
  setFlash(c, { kind: 'ok', message: `Deleted ${endpoint.name}.` });
  return c.redirect(hookTab, 303);
});

export default screen;
