/**
 * API keys (/app/api-keys): make, rename, rotate and revoke keys, manage service accounts and,
 * for the person who owns the install, replace the signing key.
 *
 * This is a thin front for `core/apikeys` and `core/jwt`. They check the role and write the audit
 * entry; the guard below only keeps everyone but signed-in admins and owners off the screen, so
 * nobody sees a page they could not use. A key or a token that somehow reaches it is refused.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createApiKey,
  createServiceAccount,
  deleteServiceAccount,
  getApiKey,
  getServiceAccount,
  listApiKeys,
  listServiceAccounts,
  renameApiKey,
  revokeApiKey,
  rotateApiKey,
  updateServiceAccount,
} from '../../core/apikeys';
import type { ApiKey } from '../../core/apikeys';
import { AppError, errors } from '../../core/errors';
import type { FieldErrors } from '../../core/errors';
import { needRole } from '../../core/guards';
import { getSigningKeyStatus, rotateSigningKey } from '../../core/jwt';
import type { AppEnv } from '../../env';
import { Callout, formatDateTime, renderPage, setFlash } from '../../ui';
import { AccountDetailPage, NewAccountPage } from './account-pages';
import { pageOfKeys, sessionActor } from './data';
import {
  allowedRoles,
  claimFormToken,
  emptyKeyValues,
  formFailure,
  newFormToken,
  readAccountValues,
  readKeyValues,
  scopeGroups,
  textField,
  toAccountInput,
  toCreateInput,
} from './forms';
import { GRACE_CHOICES, KeyDetailPage, NewKeyPage, SecretPage } from './key-pages';
import { ListPage } from './list-views';

const BASE = '/app/api-keys';
const CRUMB = { label: 'API keys', href: BASE };

/** Refusals about the key itself (already replaced, expired). Shown as a message on its page. */
const KEY_STATE_CODES = new Set(['keys.revoked', 'keys.expired', 'keys.already_rotated']);

const screen = new Hono<AppEnv>();

// Runs before every route, so a handler never has to remember the check.
screen.use('*', async (c, next) => {
  needRole(c, 'admin');
  sessionActor(c);
  await next();
});

function origin(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}

/* ---------- The list ---------- */

screen.get('/', async (c) => {
  const actor = sessionActor(c);
  const now = Date.now();
  const tab = c.req.query('tab') === 'accounts' ? 'accounts' : 'keys';
  const includeRevoked = c.req.query('revoked') === '1';
  const after = c.req.query('after') || null;
  const owner = c.get('user')?.isInstanceOwner === true;
  const [keys, accounts, signing] = await Promise.all([
    listApiKeys(c.env, actor, { includeRevoked }, now),
    listServiceAccounts(c.env, actor, now),
    owner ? getSigningKeyStatus(c.env) : Promise.resolve(undefined),
  ]);
  return renderPage(
    c,
    { title: 'API keys', crumbs: [{ label: 'API keys' }] },
    <ListPage
      tab={tab}
      page={pageOfKeys(keys, after)}
      paged={after !== null}
      includeRevoked={includeRevoked}
      workingKeys={keys.filter((k) => k.status === 'active').length}
      accounts={accounts}
      now={now}
      origin={origin(c)}
      signing={signing}
    />,
  );
});

/* ---------- Make a key ---------- */

async function renderNewKey(c: Context<AppEnv>, init: { values: ReturnType<typeof emptyKeyValues>; fields?: FieldErrors; message?: string | null; status?: 422 | 403 | 404 | 409 }) {
  const actor = sessionActor(c);
  const accounts = await listServiceAccounts(c.env, actor);
  return renderPage(
    c,
    { title: 'Make a key', crumbs: [CRUMB, { label: 'Make a key' }], status: init.status },
    <NewKeyPage values={init.values} fields={init.fields ?? {}} message={init.message ?? null} token={newFormToken()} accounts={accounts} roles={allowedRoles(actor)} groups={scopeGroups()} />,
  );
}

screen.get('/new', async (c) => {
  const actor = sessionActor(c);
  const wanted = c.req.query('account') ?? '';
  const accounts = await listServiceAccounts(c.env, actor);
  return renderNewKey(c, { values: emptyKeyValues(accounts.some((a) => a.id === wanted) ? wanted : '') });
});

/**
 * The one place a secret leaves the server: in the response to this post, never in a redirect,
 * a cookie or a later page. The service has no way to tell a repeat of the post from a new one,
 * so the form carries a token that works once. A refresh or a back-and-resubmit finds it spent.
 */
screen.post('/new', async (c) => {
  const actor = sessionActor(c);
  const body = await c.req.parseBody({ all: true });
  const values = readKeyValues(body);
  const claim = await claimFormToken(c.env, textField(body, 'form_token'));
  if (claim === 'spent') {
    setFlash(c, { kind: 'info', message: 'That form was already sent, so no second key was made. If your key is in the list but you didn’t copy it, revoke it and make a new one.' });
    return c.redirect(BASE, 303);
  }
  if (claim === 'invalid') return renderNewKey(c, { values, message: 'That form has expired. Check the details and make the key again.', status: 422 });
  try {
    const created = await createApiKey(c.env, actor, toCreateInput(values));
    return renderPage(
      c,
      { title: 'Your new key', crumbs: [CRUMB, { label: 'Your new key' }] },
      <SecretPage created={created.key} secret={created.secret} origin={origin(c)} />,
    );
  } catch (err) {
    const failure = formFailure(err);
    if (!failure) throw err;
    return renderNewKey(c, { values, fields: failure.fields, message: failure.message, status: statusOf(failure.status) });
  }
});

function statusOf(status: number): 422 | 403 | 404 | 409 {
  return status === 403 || status === 404 || status === 409 ? status : 422;
}

/* ---------- Signing key (instance owner only) ---------- */

screen.post('/signing-key/rotate', async (c) => {
  const user = c.get('user');
  // `rotateSigningKey` checks nobody, so this is the only check there is.
  if (!user?.isInstanceOwner) throw errors.forbidden('Only the person who owns this install can replace the signing key.');
  await rotateSigningKey(c.env, { actor: { userId: user.id, label: user.name || user.email, ip: c.req.header('cf-connecting-ip') ?? null } });
  setFlash(c, { kind: 'ok', message: 'The signing key was replaced. Tokens already issued keep working until they expire.' });
  return c.redirect(BASE, 303);
});

/* ---------- Service accounts ---------- */

screen.get('/accounts/new', (c) => {
  const actor = sessionActor(c);
  return renderPage(c, { title: 'Make a service account', crumbs: [CRUMB, { label: 'Make a service account' }] }, <NewAccountPage values={{ name: '', role: 'member' }} fields={{}} message={null} roles={allowedRoles(actor)} />);
});

screen.post('/accounts/new', async (c) => {
  const actor = sessionActor(c);
  const values = readAccountValues(await c.req.parseBody());
  try {
    const account = await createServiceAccount(c.env, actor, toAccountInput(values));
    setFlash(c, { kind: 'ok', message: `Made the service account ${account.name}. Make a key for it when an app needs one.` });
    return c.redirect(`${BASE}/accounts/${encodeURIComponent(account.id)}`, 303);
  } catch (err) {
    const failure = formFailure(err);
    if (!failure) throw err;
    return renderPage(
      c,
      { title: 'Make a service account', crumbs: [CRUMB, { label: 'Make a service account' }], status: statusOf(failure.status) },
      <NewAccountPage values={values} fields={failure.fields} message={failure.message} roles={allowedRoles(actor)} />,
    );
  }
});

async function renderAccount(c: Context<AppEnv>, id: string, init: { values?: { name: string; role: string }; fields?: FieldErrors; message?: string | null; status?: 422 | 403 | 404 | 409 } = {}) {
  const actor = sessionActor(c);
  const now = Date.now();
  const [account, keys] = await Promise.all([getServiceAccount(c.env, actor, id, now), listApiKeys(c.env, actor, {}, now)]);
  return renderPage(
    c,
    { title: account.name, crumbs: [CRUMB, { label: account.name }], status: init.status },
    <AccountDetailPage
      account={account}
      keys={keys.filter((k) => k.serviceAccountId === account.id && k.status === 'active')}
      now={now}
      values={init.values ?? { name: account.name, role: account.role }}
      fields={init.fields ?? {}}
      message={init.message ?? null}
      roles={allowedRoles(actor)}
    />,
  );
}

screen.get('/accounts/:id', (c) => renderAccount(c, c.req.param('id')));

screen.post('/accounts/:id', async (c) => {
  const actor = sessionActor(c);
  const id = c.req.param('id');
  const values = readAccountValues(await c.req.parseBody());
  try {
    const account = await updateServiceAccount(c.env, actor, id, toAccountInput(values));
    setFlash(c, { kind: 'ok', message: `Saved ${account.name}.` });
    return c.redirect(`${BASE}/accounts/${encodeURIComponent(id)}`, 303);
  } catch (err) {
    const failure = formFailure(err);
    if (!failure) throw err;
    return renderAccount(c, id, { values, fields: failure.fields, message: failure.message, status: statusOf(failure.status) });
  }
});

screen.post('/accounts/:id/delete', async (c) => {
  const actor = sessionActor(c);
  const id = c.req.param('id');
  const account = await getServiceAccount(c.env, actor, id);
  const { revokedKeys } = await deleteServiceAccount(c.env, actor, id);
  const keys = revokedKeys === 1 ? '1 key was revoked' : `${revokedKeys} keys were revoked`;
  setFlash(c, { kind: 'ok', message: `Deleted the service account ${account.name}. ${keys}.` });
  return c.redirect(`${BASE}?tab=accounts`, 303);
});

/* ---------- One key ---------- */

/** Why the person looking can't rotate this key, or null when they can. */
function rotateBlock(key: ApiKey, userId: string): string | null {
  if (key.kind === 'personal' && key.userId !== userId) return 'This is a personal key that belongs to someone else. Only they can rotate it. You can revoke it.';
  return null;
}

async function renderKey(c: Context<AppEnv>, id: string, init: { name?: string; nameError?: string; status?: 422 } = {}) {
  const actor = sessionActor(c);
  const now = Date.now();
  const key = await getApiKey(c.env, actor, id, now);
  return renderPage(
    c,
    { title: key.name, crumbs: [CRUMB, { label: key.name }], status: init.status },
    <KeyDetailPage apiKey={key} now={now} noRotate={rotateBlock(key, actor.userId)} name={init.name ?? key.name} nameError={init.nameError} />,
  );
}

screen.get('/:id', (c) => renderKey(c, c.req.param('id')));

screen.post('/:id/rename', async (c) => {
  const actor = sessionActor(c);
  const id = c.req.param('id');
  const name = textField(await c.req.parseBody(), 'name');
  try {
    const key = await renameApiKey(c.env, actor, id, name);
    setFlash(c, { kind: 'ok', message: `Renamed the key to ${key.name}.` });
    return c.redirect(`${BASE}/${encodeURIComponent(id)}`, 303);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'validation_failed') throw err;
    return renderKey(c, id, { name, nameError: err.fields?.name ?? err.message, status: 422 });
  }
});

screen.post('/:id/revoke', async (c) => {
  const key = await revokeApiKey(c.env, sessionActor(c), c.req.param('id'));
  setFlash(c, { kind: 'ok', message: `Revoked ${key.name}. Anything using it has stopped working.` });
  return c.redirect(BASE, 303);
});

screen.post('/:id/rotate', async (c) => {
  const actor = sessionActor(c);
  const id = c.req.param('id');
  const asked = textField(await c.req.parseBody(), 'grace');
  const grace = GRACE_CHOICES.find((g) => g.value === asked);
  if (!grace) {
    setFlash(c, { kind: 'error', message: 'Pick how long the old key keeps working.' });
    return c.redirect(`${BASE}/${encodeURIComponent(id)}`, 303);
  }
  try {
    const rotated = await rotateApiKey(c.env, actor, id, { graceSeconds: Number(grace.value) });
    const ends = rotated.previous.expiresAt;
    const old =
      Number(grace.value) > 0 && ends !== null
        ? `The old key keeps working until ${formatDateTime(ends)}, then stops.`
        : 'The old key stopped working as soon as you rotated it.';
    return renderPage(
      c,
      { title: 'Your new key', crumbs: [CRUMB, { label: 'Your new key' }] },
      <SecretPage created={rotated.key} secret={rotated.secret} origin={origin(c)} title="Copy your new key now" notice={<Callout title="The old key">{old}</Callout>} />,
    );
  } catch (err) {
    // A repeat of this post lands here: the key was already replaced, and no second one is made.
    if (!(err instanceof AppError) || !KEY_STATE_CODES.has(err.code)) throw err;
    setFlash(c, { kind: 'error', message: err.message });
    return c.redirect(`${BASE}/${encodeURIComponent(id)}`, 303);
  }
});

export default screen;
