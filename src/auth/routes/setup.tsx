/**
 * First-run setup. A new install has no owner. The person whose address is in `OWNER_EMAIL`
 * proves it with an emailed code, names the first workspace and picks what to do first. Nobody
 * else can claim: the address is never typed in, it only ever comes from the deploy's own settings.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../../core/audit';
import { sendEmail } from '../../core/email';
import { renderEmail } from '../../core/email-templates';
import { AppError, errors } from '../../core/errors';
import { sameOrigin } from '../../core/guards';
import { SAMPLE_SETTING } from '../../core/onboarding';
import { allModules, moduleContext, setModuleEnabled, setModuleSample } from '../../core/registry';
import { setSetting } from '../../core/settings';
import type { AppEnv, Env } from '../../env';
import { renderAuthPage } from '../../ui';
import { getAuth } from '../auth';
import { callAuth } from '../bridge';
import { issueCode, redeemCode } from '../codes';
import { CODE_TTL_MS, LIMITS } from '../config';
import { authErrors } from '../errors';
import { clearFlow, clientIp, hit, readFlow, setFlow, waitText } from '../http';
import { safeNext } from '../next';
import {
  AlreadyClaimed,
  ClaimCodeStep,
  ClaimPaused,
  ClaimStep,
  FirstStep,
  NotClaimable,
  setupFooter,
  WorkspaceStep,
  type FirstCard,
  type WorkspaceStepProps,
} from '../pages/setup';
import { changeName, personNameSchema } from '../service/account';
import { auditBy } from '../service/actor';
import { createWorkspace, slugSchema, workspaceNameSchema, workspacesOf } from '../service/workspaces';
import { finishSignIn } from '../signin';
import { emailSchema, findUserByEmail, instanceClaimed, type UserRow } from '../users';

type C = Context<AppEnv>;
type Body = Parameters<typeof renderAuthPage>[2];

export const setupRoutes = new Hono<AppEnv>();

setupRoutes.use('/setup', sameOrigin);
setupRoutes.use('/setup/*', sameOrigin);

/** How long the "what first" step stays open after the claim. */
const SETUP_TTL_SEC = 60 * 60;
/** Where the owner lands when setup ends without a module picked: the Get started screen. */
const AFTER_SETUP = '/app/welcome';
/** The workspace setting that holds its time zone. */
export const TIMEZONE_KEY = 'timezone';

const page = (c: C, title: string, body: Body, opts: { status?: 400 | 409 | 422 | 429 | 502; wide?: boolean } = {}) =>
  renderAuthPage(c, { title, footer: setupFooter, ...(opts.status ? { status: opts.status } : {}), ...(opts.wide ? { wide: true } : {}) }, body);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The one address that may claim this install, or null when `OWNER_EMAIL` is missing or is not an
 * email address. With no address nobody can claim, in any environment: an open claim would hand
 * the install to whoever found its URL first.
 */
export function ownerEmail(env: Env): string | null {
  const parsed = emailSchema.safeParse(env.OWNER_EMAIL ?? '');
  return parsed.success ? parsed.data : null;
}

let zones: string[] | undefined;

/** Every time zone this runtime knows, with UTC always there. */
function timezones(): string[] {
  if (!zones) {
    const known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    zones = known.includes('UTC') ? known : ['UTC', ...known];
  }
  return zones;
}

/** The cards of the "what first" step: every module that offers one. */
function firstCards(): FirstCard[] {
  return allModules().flatMap((m) => (m.onboarding ? [{ id: m.id, title: m.onboarding.title, body: m.onboarding.body, icon: m.icon, hasSample: !!m.sampleData }] : []));
}

/* ---- Step 1: claim ---- */

setupRoutes.get('/setup', async (c) => {
  const user = c.get('user');
  if (await instanceClaimed(c.env)) {
    // The owner who closed the tab before naming a workspace picks up where they stopped.
    if (user?.isInstanceOwner && (await workspacesOf(c.env, user.id)).length === 0) return c.redirect('/setup/workspace');
    return page(c, 'Already claimed', <AlreadyClaimed signedIn={!!user} />);
  }
  const owner = ownerEmail(c.env);
  if (!owner) return page(c, 'Set an owner email', <NotClaimable />);
  return page(c, 'Claim this Toolshed', <ClaimStep ownerEmail={owner} />);
});

/** Send a claim code to the owner address. Also what "send a new code" posts to. */
setupRoutes.post('/setup', async (c) => {
  const owner = ownerEmail(c.env);
  if (!owner || (await instanceClaimed(c.env))) return c.redirect('/setup', 303);

  // One count for the whole install: there is one owner address, whoever is asking.
  const wait = (await hit(c.env, 'claim', 'install')) || (await hit(c.env, 'codePerIp', clientIp(c)));
  if (wait) return page(c, 'Too many tries', <ClaimPaused wait={waitText(wait)} />, { status: 429 });

  const issued = await issueCode(c.env, { purpose: 'claim', email: owner, ip: clientIp(c), userAgent: c.req.header('user-agent') });
  const mail = await renderEmail(c.env, { template: 'claim-code', data: { code: issued.code, minutes: CODE_TTL_MS / 60_000 } });
  const sent = await sendEmail(c.env, { to: owner, template: 'claim-code', tag: 'auth', lane: 'sign-in', ...mail });

  let logged = false;
  if (sent.status === 'not_configured') {
    // A new install that cannot send email yet would otherwise have no way in. Whoever can read
    // the Worker's log already runs the install. The line holds the code and nothing else.
    console.log(`Toolshed claim code: ${issued.code}`);
    logged = true;
  } else if (sent.status !== 'sent' && sent.status !== 'dev' && sent.status !== 'retrying') {
    const error = 'We couldn’t send the email. Check the Worker’s logs and its email setup, then try again.';
    return page(c, 'Claim this Toolshed', <ClaimStep ownerEmail={owner} error={error} />, { status: 502 });
  }
  await setFlow(c, 'claim', { codeId: issued.id, ...(logged ? { ref: 'logged' } : {}) });
  return c.redirect('/setup/code', 303);
});

setupRoutes.get('/setup/code', async (c) => {
  const owner = ownerEmail(c.env);
  const flow = await readFlow(c, 'claim');
  if (!owner || !flow?.codeId || (await instanceClaimed(c.env))) return c.redirect('/setup');
  return page(c, 'Enter your code', <ClaimCodeStep ownerEmail={owner} logged={flow.ref === 'logged'} />);
});

setupRoutes.post('/setup/code', async (c) => {
  const owner = ownerEmail(c.env);
  const flow = await readFlow(c, 'claim');
  if (!owner || !flow?.codeId) return c.redirect('/setup', 303);
  if (await instanceClaimed(c.env)) {
    clearFlow(c, 'claim');
    return c.redirect('/setup', 303);
  }
  const logged = flow.ref === 'logged';
  const wait = await hit(c.env, 'checkPerIp', clientIp(c));
  if (wait) return page(c, 'Too many tries', <ClaimPaused wait={waitText(wait)} />, { status: 429 });

  const form = await c.req.parseBody();
  const result = await redeemCode(c.env, { id: flow.codeId, purpose: 'claim', code: text(form.code) });
  if (!result.ok) {
    if (result.reason === 'limited') {
      return page(c, 'Too many tries', <ClaimPaused wait={waitText(result.retryAfter || LIMITS.wrongPerEmail.windowSec)} />, { status: 429 });
    }
    if (result.reason === 'wrong') {
      const left = `${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left.`;
      return page(c, 'Enter your code', <ClaimCodeStep ownerEmail={owner} logged={logged} error={`That code isn’t right. ${left}`} />, { status: 400 });
    }
    const message = result.reason === 'used' ? authErrors.code_used().message : authErrors.code_expired().message;
    return page(c, 'Enter your code', <ClaimCodeStep ownerEmail={owner} logged={logged} error={message} dead />, { status: 400 });
  }
  // `OWNER_EMAIL` may have changed since the code was sent. Only the address set now counts.
  if (result.email !== owner) {
    return page(c, 'Enter your code', <ClaimCodeStep ownerEmail={owner} logged={logged} error={authErrors.code_expired().message} dead />, { status: 400 });
  }

  const { user, created } = await makeOwner(c, owner);
  // A brand-new account has no second step to ask for. One that was there before keeps its own.
  const done = await finishSignIn(c, user, 'claim', { twoStep: !created });
  await audit(c.env, {
    orgId: null,
    actorId: user.id,
    actorLabel: user.email,
    action: 'install.claimed',
    targetType: 'user',
    targetId: user.id,
    summary: 'Claimed this Toolshed',
    ip: clientIp(c),
  });
  clearFlow(c, 'claim');
  if (done.state === 'two-step') {
    await setFlow(c, 'two-step', { email: user.email, next: '/app' });
    return c.redirect('/sign-in/two-step', 303);
  }
  if (done.state === 'banned') return c.redirect('/setup', 303);
  await setFlow(c, 'setup', {}, SETUP_TTL_SEC);
  return c.redirect('/setup/workspace', 303);
});

/**
 * Make the owner's account, or hand the install to the account that already has the owner
 * address. The second case only happens when an install lost its owner (a row removed by hand):
 * whoever controls `OWNER_EMAIL` and its inbox runs the install, so they also get past a suspension.
 */
async function makeOwner(c: C, owner: string): Promise<{ user: UserRow; created: boolean }> {
  let user = await findUserByEmail(c.env, owner);
  let created = false;
  if (!user) {
    const auth = await getAuth(c.env, c.req.url);
    try {
      const reply = await callAuth<{ id: string }>(() =>
        auth.api.createAccount({ body: { email: owner, name: owner.slice(0, owner.lastIndexOf('@')), instanceOwner: true }, asResponse: true }),
      );
      created = reply.ok;
    } catch (err) {
      // Two valid codes used at the same moment: the second finds the account the first one made.
      console.error('[auth] could not create the owner account', err);
    }
    user = await findUserByEmail(c.env, owner);
    if (!user) throw errors.internal();
  }
  if (user.role !== 'admin' || user.banned) {
    await c.env.DB.prepare(`UPDATE "user" SET "role" = 'admin', "emailVerified" = 1, "banned" = 0, "banReason" = NULL, "banExpires" = NULL, "updatedAt" = ?1 WHERE "id" = ?2`)
      .bind(new Date().toISOString(), user.id)
      .run();
    user = { ...user, role: 'admin', banned: 0, banReason: null, banExpires: null };
  }
  return { user, created };
}

/* ---- Step 2: name the workspace ---- */

/** The owner who has no workspace yet, or the redirect for everyone else. */
async function ownerWithoutWorkspace(c: C): Promise<{ id: string; name: string } | Response> {
  const user = c.get('user');
  if (!user) return c.redirect('/setup', 303);
  if (!user.isInstanceOwner) return c.redirect('/app', 303);
  if ((await workspacesOf(c.env, user.id)).length > 0) return c.redirect((await readFlow(c, 'setup')) && firstCards().length > 0 ? '/setup/first' : '/app', 303);
  return user;
}

setupRoutes.get('/setup/workspace', async (c) => {
  const user = await ownerWithoutWorkspace(c);
  if (user instanceof Response) return user;
  return page(c, 'Name your workspace', <WorkspaceStep values={{ name: '', slug: '', yourName: user.name, timezone: 'UTC' }} timezones={timezones()} detectZone />);
});

const workspaceForm = z.object({
  name: workspaceNameSchema,
  slug: z.union([z.literal(''), slugSchema]),
  yourName: personNameSchema,
  timezone: z.string().refine((zone) => timezones().includes(zone), 'Pick a time zone from the list.'),
});

setupRoutes.post('/setup/workspace', async (c) => {
  const user = await ownerWithoutWorkspace(c);
  if (user instanceof Response) return user;

  const form = await c.req.parseBody();
  const values = {
    name: text(form.name).slice(0, 200),
    slug: text(form.slug).trim().slice(0, 200),
    yourName: text(form.yourName).slice(0, 200),
    timezone: text(form.timezone).slice(0, 100),
  };
  const again = (errs: WorkspaceStepProps['errors'], status: 409 | 422) =>
    page(c, 'Name your workspace', <WorkspaceStep values={values} timezones={timezones()} errors={errs} />, { status });

  const parsed = workspaceForm.safeParse(values);
  if (!parsed.success) {
    const errs: NonNullable<WorkspaceStepProps['errors']> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === 'name' || field === 'slug' || field === 'yourName' || field === 'timezone') && !errs[field]) errs[field] = issue.message;
    }
    return again(errs, 422);
  }

  let workspace;
  try {
    workspace = await createWorkspace(c, { name: parsed.data.name, slug: parsed.data.slug || null });
  } catch (err) {
    if (err instanceof AppError && err.code === 'auth.slug_taken') return again({ slug: err.message }, 409);
    throw err;
  }
  await changeName(c, { name: parsed.data.yourName });
  await setSetting(c.env, workspace.id, TIMEZONE_KEY, parsed.data.timezone);

  if (firstCards().length === 0) {
    clearFlow(c, 'setup');
    return c.redirect(AFTER_SETUP, 303);
  }
  // The step is offered once, right after the first workspace is named.
  await setFlow(c, 'setup', {}, SETUP_TTL_SEC);
  return c.redirect('/setup/first', 303);
});

/* ---- Step 3: what first ---- */

/** The owner of the workspace that was just made, while the step is still open. */
async function pickingFirst(c: C): Promise<{ cards: FirstCard[]; org: { id: string; name: string; slug: string } } | null> {
  const org = c.get('org');
  const cards = firstCards();
  if (!c.get('user') || !org || org.role !== 'owner' || cards.length === 0 || !(await readFlow(c, 'setup'))) return null;
  return { cards, org };
}

setupRoutes.get('/setup/first', async (c) => {
  const step = await pickingFirst(c);
  if (!step) return c.redirect(AFTER_SETUP);
  return page(c, 'What first?', <FirstStep cards={step.cards} />, { wide: true });
});

setupRoutes.post('/setup/first', async (c) => {
  const step = await pickingFirst(c);
  if (!step) return c.redirect(AFTER_SETUP, 303);

  const form = await c.req.parseBody();
  const picked = allModules().find((m) => m.onboarding && m.id === text(form.module));
  if (!picked?.onboarding) return page(c, 'What first?', <FirstStep cards={step.cards} error="Pick one, or skip this step." />, { status: 422, wide: true });

  await setModuleEnabled(c.env, step.org.id, picked.id, true);
  // The choice carries over to the Get started screen, where later modules follow it.
  await setSetting(c.env, step.org.id, SAMPLE_SETTING, form.sample === 'yes');
  let sample = false;
  if (form.sample === 'yes' && picked.sampleData) {
    try {
      await picked.sampleData(await moduleContext(c.env, step.org));
      await setModuleSample(c.env, step.org.id, picked.id, true);
      sample = true;
    } catch (err) {
      // Sample rows are a nicety. A module that fails to make them must not block the way in.
      console.error(`[auth] sample data for ${picked.id} failed`, err);
    }
  }
  const user = c.get('user')!;
  await auditBy(c.env, { id: user.id, email: user.email, name: user.name, ip: clientIp(c) }, {
    orgId: step.org.id,
    action: 'module.enabled',
    targetType: 'module',
    targetId: picked.id,
    summary: `Turned on ${picked.name}`,
    meta: { sample, from: 'setup' },
  });
  clearFlow(c, 'setup');
  return c.redirect(safeNext(picked.onboarding.href ?? `/app/${picked.id}`), 303);
});
