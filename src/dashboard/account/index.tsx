/**
 * Your account (/app/account): the signed-in person's own name, email, password, two-step sign-in,
 * passkeys and devices. Open to every role, because it is about the person, not a workspace.
 *
 * The auth services check who is asking, how recently they signed in and every value, and they write
 * the audit entries themselves. This file only reads forms, calls them and shows a refusal next to
 * the field it belongs to. A secret (a two-step key, recovery codes) is sent in the response to the
 * post that made it, with `no-store`, and is never put in a redirect, flash message or log.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../env';
import { AppError } from '../../core/errors';
import { renderPage, setFlash, plural } from '../../ui';
import {
  cancelEmailChange,
  changeName,
  confirmEmailChange,
  confirmTwoStep,
  deleteAccount,
  regenerateRecoveryCodes,
  removePasskey,
  removePassword,
  renamePasskey,
  revokeOtherSessions,
  revokeSession,
  setPassword,
  setUsername,
  startEmailChange,
  startTwoStep,
  turnOffTwoStep,
} from '../../auth/service';
import { AccountTab } from './account-tab';
import { load, parseTab, type Tab } from './data';
import { toProblem, type Kept, type Problem, type Section } from './problem';
import { NewCodesPage, RetryPage, SetupPage } from './secret-pages';
import { SecurityTab } from './security-tab';
import { SessionsTab } from './sessions-tab';
import { BASE, Frame, type View } from './view';

const screen = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

const TAB_OF: Record<Section, Tab> = { name: 'account', username: 'account', email: 'account', delete: 'account', password: 'security', 'two-step': 'security', passkeys: 'security', sessions: 'sessions' };
const OPTIONS = { title: 'Account', crumbs: [{ label: 'Account' }] };

const tabUrl = (tab: Tab) => (tab === 'account' ? BASE : `${BASE}?tab=${tab}`);

async function show(c: Ctx, tab: Tab, problem: Problem | null = null, kept: Kept = {}, status: number = 200): Promise<Response> {
  const v: View = { data: await load(c, tab), tab, problem, kept };
  const body = tab === 'security' ? <SecurityTab v={v} /> : tab === 'sessions' ? <SessionsTab v={v} /> : <AccountTab v={v} />;
  return renderPage(c, { ...OPTIONS, status: status as ContentfulStatusCode }, <Frame v={v}>{body}</Frame>);
}

/** A page that carries a secret: never cached, never a redirect. */
function secretPage(c: Ctx, body: Parameters<typeof renderPage>[2], status: ContentfulStatusCode = 200) {
  return renderPage(c, { ...OPTIONS, status }, body);
}

type Form = Record<string, string | File | (string | File)[]>;
const text = (body: Form, name: string): string => (typeof body[name] === 'string' ? (body[name] as string) : '');

/**
 * Runs one change. A message back means success: show it after a redirect. A Response is sent as is.
 * A refusal the services are known to give is shown on the page the form is on.
 */
async function attempt(c: Ctx, section: Section, kept: Kept, work: () => Promise<string | Response>, onProblem?: (p: Problem) => Response | Promise<Response> | null): Promise<Response> {
  const tab = TAB_OF[section];
  try {
    const out = await work();
    if (typeof out !== 'string') return out;
    setFlash(c, { kind: 'ok', message: out });
    return c.redirect(tabUrl(tab), 303);
  } catch (err) {
    const problem = toProblem(section, err);
    if (!problem) throw err;
    return (await onProblem?.(problem)) ?? show(c, tab, problem, kept, problem.status);
  }
}

const passwordOf = (body: Form) => (text(body, 'current') ? { password: text(body, 'current') } : {});

screen.get('/', (c) => show(c, parseTab(c.req.query('tab'))));

/* ---------- Account tab ---------- */

screen.post('/name', async (c) => {
  const name = text(await c.req.parseBody(), 'name');
  return attempt(c, 'name', { name }, async () => {
    await changeName(c, { name });
    return 'Name saved.';
  });
});

screen.post('/username', async (c) => {
  const username = text(await c.req.parseBody(), 'username').trim();
  return attempt(c, 'username', { username }, async () => {
    await setUsername(c, { username: username || null });
    return username ? 'Username saved.' : 'Username removed.';
  });
});

screen.post('/email/start', async (c) => {
  const email = text(await c.req.parseBody(), 'email');
  return attempt(c, 'email', { email }, async () => {
    await startEmailChange(c, { email });
    return 'Check the inbox of that address for a 6-digit code.';
  });
});

screen.post('/email/confirm', async (c) =>
  attempt(c, 'email', {}, async () => `Your email is now ${(await confirmEmailChange(c, { code: text(await c.req.parseBody(), 'code') })).email}.`),
);

screen.post('/email/cancel', (c) =>
  attempt(c, 'email', {}, async () => {
    await cancelEmailChange(c);
    return 'The email change was cancelled.';
  }),
);

screen.post('/delete', async (c) => {
  const confirm = text(await c.req.parseBody(), 'confirm');
  return attempt(c, 'delete', { confirm }, async () => {
    await deleteAccount(c, { confirm });
    setFlash(c, { kind: 'info', message: 'Your account was deleted.' });
    return c.redirect('/sign-in', 303);
  });
});

/* ---------- Security tab ---------- */

screen.post('/password', async (c) =>
  attempt(c, 'password', {}, async () => {
    await setPassword(c, { password: text(await c.req.parseBody(), 'password') });
    return 'Password saved. Your other devices were signed out.';
  }),
);

screen.post('/password/remove', (c) =>
  attempt(c, 'password', {}, async () => {
    await removePassword(c);
    return 'Password removed.';
  }),
);

screen.post('/two-step/start', async (c) => {
  const body = await c.req.parseBody();
  return attempt(c, 'two-step', {}, async () => secretPage(c, <SetupPage {...(await startTwoStep(c, passwordOf(body)))} />));
});

screen.post('/two-step/confirm', async (c) => {
  const code = text(await c.req.parseBody(), 'code');
  return attempt(
    c,
    'two-step',
    {},
    async () => {
      await confirmTwoStep(c, { code });
      return 'Two-step sign-in is on.';
    },
    (p) => (p.field === 'code' ? secretPage(c, <RetryPage error={p.message} />, p.status as ContentfulStatusCode) : null),
  );
});

screen.post('/two-step/off', async (c) => {
  const body = await c.req.parseBody();
  return attempt(c, 'two-step', {}, async () => {
    await turnOffTwoStep(c, passwordOf(body));
    return 'Two-step sign-in is off.';
  });
});

screen.post('/two-step/codes', async (c) => {
  const body = await c.req.parseBody();
  return attempt(c, 'two-step', {}, async () => secretPage(c, <NewCodesPage codes={await regenerateRecoveryCodes(c, passwordOf(body))} />));
});

screen.post('/passkeys/:id/rename', async (c) => {
  const name = text(await c.req.parseBody(), 'name');
  return attempt(c, 'passkeys', {}, async () => {
    await renamePasskey(c, c.req.param('id'), { name });
    return 'Passkey renamed.';
  });
});

screen.post('/passkeys/:id/remove', (c) =>
  attempt(c, 'passkeys', {}, async () => {
    await removePasskey(c, c.req.param('id'));
    return 'Passkey removed.';
  }),
);

/* ---------- Devices tab ---------- */

screen.post('/sessions/revoke-others', (c) =>
  attempt(c, 'sessions', {}, async () => {
    const { count } = await revokeOtherSessions(c);
    return count ? `Signed out ${plural(count, 'other device')}.` : 'There were no other devices to sign out.';
  }),
);

screen.post('/sessions/:id/revoke', (c) =>
  attempt(c, 'sessions', {}, async () => {
    try {
      const { current } = await revokeSession(c, c.req.param('id'));
      return current ? c.redirect('/sign-in', 303) : 'That device was signed out.';
    } catch (err) {
      // Signed out from another tab a moment ago: the list was stale, the goal is already met.
      if (err instanceof AppError && err.code === 'auth.session_not_found') return 'That device was already signed out.';
      throw err;
    }
  }),
);

export default screen;
