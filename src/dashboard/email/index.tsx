/**
 * Email, the delivery screen (/app/email).
 *
 * Install-wide things (sender, test email, blocked addresses) belong to the person who runs the
 * install, so every one of those actions checks that on the server. Workspace admins who are not
 * the instance owner see the status and their own workspace's delivery log, nothing else.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { sendTestEmail, setSender, unsuppressAddress, type EmailResult } from '../../core/email';
import { AppError, errors } from '../../core/errors';
import { roleAtLeast, type AppEnv } from '../../env';
import { renderPage, setFlash } from '../../ui';
import { readBlockedAddress, readSender, readTestTo } from './actions';
import { loadEmailPage, readQuery, type Viewer } from './data';
import { EmailView, type SenderForm, type TestForm } from './view';

const screen = new Hono<AppEnv>();

const OWNER_ONLY = 'Only the person who runs this install can change email settings.';

/** Instance owners and workspace admins open this screen. Members and viewers do not. */
screen.use('*', async (c, next) => {
  const isOwner = c.get('user')?.isInstanceOwner === true;
  const org = c.get('org');
  if (!isOwner && !(org && roleAtLeast(org.role, 'admin'))) {
    throw errors.forbidden('Only workspace admins can open Email. Ask an admin for access.');
  }
  await next();
});

function viewerOf(c: Context<AppEnv>): Viewer {
  return { isOwner: c.get('user')?.isInstanceOwner === true, orgId: c.get('org')?.id ?? '' };
}

/** Install-wide changes: the check lives here, in the handler, not only in what the page shows. */
function needOwner(c: Context<AppEnv>): void {
  if (!viewerOf(c).isOwner) throw errors.forbidden(OWNER_ONLY);
}

async function render(c: Context<AppEnv>, extra: { sender?: SenderForm; test?: TestForm; status?: ContentfulStatusCode } = {}) {
  const viewer = viewerOf(c);
  const query = readQuery(new URL(c.req.url));
  // A re-rendered form always belongs on the setup tab, whatever the address bar said.
  const shown = extra.sender || extra.test ? { ...query, tab: 'setup' as const } : query;
  const page = await loadEmailPage(c.env, viewer, shown);
  return renderPage(
    c,
    { title: 'Email', crumbs: [{ label: 'Email' }], ...(extra.status ? { status: extra.status } : {}) },
    <EmailView
      page={page}
      viewer={viewer}
      query={shown}
      userEmail={c.get('user')?.email ?? ''}
      hasBinding={Boolean(c.env.EMAIL)}
      {...(extra.sender ? { sender: extra.sender } : {})}
      {...(extra.test ? { test: extra.test } : {})}
    />,
  );
}

screen.get('/', (c) => render(c));

screen.post('/sender', async (c) => {
  needOwner(c);
  const body = await c.req.parseBody();
  let values = { fromName: '', fromAddress: '', replyTo: '' };
  try {
    values = readSender(body);
    const user = c.get('user');
    await setSender(c.env, values, { id: user?.id ?? null, email: user?.email ?? null });
  } catch (err) {
    if (err instanceof AppError && err.code === 'validation_failed') {
      return render(c, { sender: { values, errors: err.fields ?? {} }, status: 422 });
    }
    throw err;
  }
  setFlash(c, { kind: 'ok', message: values.fromAddress.trim() ? 'Sender saved.' : 'Sender cleared. Email sending is off until you add an address.' });
  return c.redirect('/app/email?tab=setup', 303);
});

/** What each failure of a test means for the person looking at the page. */
function testFailure(err: AppError): TestForm | null {
  if (err.code === 'needs_setup') return { to: '', failure: 'Set up email first, then send a test.' };
  if (err.code === 'rate_limited') return { to: '', failure: err.message };
  return null;
}

screen.post('/test', async (c) => {
  needOwner(c);
  const body = await c.req.parseBody();
  const to = readTestTo(body);
  const user = c.get('user');
  try {
    const result: EmailResult = await sendTestEmail(c.env, to, { id: user?.id ?? null, email: user?.email ?? null });
    return render(c, { test: { to, result } });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'validation_failed') {
      return render(c, { test: { to, fieldError: err.fields?.to ?? err.message }, status: 422 });
    }
    const failure = testFailure(err);
    if (!failure) throw err;
    return render(c, { test: { ...failure, to }, status: err.status as ContentfulStatusCode });
  }
});

screen.post('/blocked/allow', async (c) => {
  needOwner(c);
  const body = await c.req.parseBody();
  const address = readBlockedAddress(body);
  const user = c.get('user');
  const removed = await unsuppressAddress(c.env, address, { id: user?.id ?? null, email: user?.email ?? null });
  setFlash(
    c,
    removed
      ? { kind: 'ok', message: `${address} can receive email again.` }
      : { kind: 'info', message: `${address} was not on the blocked list. Nothing changed.` },
  );
  return c.redirect('/app/email?tab=blocked', 303);
});

export default screen;
