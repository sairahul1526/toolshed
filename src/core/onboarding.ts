/**
 * The "Finish setting up" steps of a new workspace. The Get started screen (/app/welcome) shows them
 * and the sidebar shows how many are done. A step is ticked only when the thing is really there:
 * nothing is stored per step.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { roleAtLeast } from '../env';
import { emailStatus } from './email';
import { getSetting } from './settings';

/** True once an admin hid Get started from the sidebar. The key predates this file, so it keeps its name. */
export const HIDDEN_SETTING = 'overview.checklistDismissed';
/** Whether modules started from Get started come with sample rows. On until someone turns it off. */
export const SAMPLE_SETTING = 'onboarding.sample';

export type SetupStepId = 'claim' | 'workspace' | 'email' | 'teammate' | 'module' | 'passkey';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  /** The line under the title: why to do it, or what is there once it is done. */
  body: string;
  done: boolean;
  href: string;
  /** The button's words. */
  action: string;
  /** A rough guess at how long the step takes, for "about N minutes left". */
  minutes: number;
}

export interface SetupProgress {
  steps: SetupStep[];
  done: number;
  total: number;
  /** 0 to 100, whole number. */
  percent: number;
  minutesLeft: number;
  /** An admin hid the sidebar entry. The screen itself still opens. */
  hidden: boolean;
}

export interface SetupFacts {
  /** The person looking is the one who claimed this install. */
  instanceOwner: boolean;
  workspaceName: string;
  /** Email is ready to go out. `dev` means it is only saved to the local outbox. */
  email: 'live' | 'dev' | 'off';
  members: number;
  modulesOn: number;
  passkeys: number;
}

export function buildSetupSteps(f: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [];
  if (f.instanceOwner) {
    steps.push({ id: 'claim', title: 'Claim this Toolshed', body: 'You’re the owner.', done: true, href: '/app/users', action: 'Open', minutes: 0 });
  }
  steps.push(
    { id: 'workspace', title: 'Name your workspace', body: f.workspaceName, done: true, href: '/app/settings', action: 'Rename', minutes: 0 },
    {
      id: 'email',
      title: 'Verify a sending domain',
      body:
        f.email === 'live'
          ? 'Sign-in codes and invites go out from your own address.'
          : f.email === 'dev'
            ? 'Dev mode: emails are saved to the outbox instead of being sent.'
            : 'So sign-in codes and invites come from your own address.',
      done: f.email !== 'off',
      href: '/app/email',
      action: 'Set up',
      minutes: 3,
    },
    {
      id: 'teammate',
      title: 'Invite a teammate',
      body: f.members > 1 ? `${f.members} people are in this workspace.` : 'They get a link by email.',
      done: f.members > 1,
      href: '/app/members#invite',
      action: 'Invite',
      minutes: 1,
    },
    {
      id: 'module',
      title: 'Turn on a module',
      body: f.modulesOn > 0 ? (f.modulesOn === 1 ? '1 module is on.' : `${f.modulesOn} modules are on.`) : 'Pick one from the cards above.',
      done: f.modulesOn > 0,
      href: '/app/modules',
      action: 'Browse',
      minutes: 1,
    },
    {
      id: 'passkey',
      title: 'Add a passkey',
      body: f.passkeys > 0 ? 'You can sign in with your fingerprint or face.' : 'Sign in with your fingerprint or face. No code to wait for.',
      done: f.passkeys > 0,
      href: '/app/account?tab=security',
      action: 'Add',
      minutes: 1,
    },
  );
  return steps;
}

export function summarise(steps: SetupStep[], hidden: boolean): SetupProgress {
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  return {
    steps,
    done,
    total,
    percent: total === 0 ? 100 : Math.round((done / total) * 100),
    minutesLeft: steps.reduce((sum, s) => sum + (s.done ? 0 : s.minutes), 0),
    hidden,
  };
}

/** "2 of 6 done. About 5 minutes left." */
export function progressLine(p: SetupProgress): string {
  if (p.done >= p.total) return `All ${p.total} done. Nothing left to set up.`;
  const time = p.minutesLeft <= 1 ? 'About a minute left.' : `About ${p.minutesLeft} minutes left.`;
  return `${p.done} of ${p.total} done. ${time}`;
}

/** Was Get started hidden from the sidebar? Admins only read this; for everyone else it is hidden. */
export function setupHidden(c: Context<AppEnv>): Promise<boolean> {
  const org = c.get('org');
  if (!org || !roleAtLeast(org.role, 'admin')) return Promise.resolve(true);
  return getSetting<boolean>(c.env, org.id, HIDDEN_SETTING, false);
}

/**
 * Reads what is really set up: three small queries. Null for people who are not admins, since the
 * steps are an admin's to finish.
 */
export async function loadSetupProgress(c: Context<AppEnv>, opts: { modulesOn: number; hidden: boolean }): Promise<SetupProgress | null> {
  const user = c.get('user');
  const org = c.get('org');
  if (!user || !org || !roleAtLeast(org.role, 'admin')) return null;
  const [email, counts] = await Promise.all([
    emailStatus(c.env),
    c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM "member" WHERE "organizationId" = ?1) AS members, (SELECT COUNT(*) FROM "passkey" WHERE "userId" = ?2) AS passkeys')
      .bind(org.id, user.id)
      .first<{ members: number; passkeys: number }>(),
  ]);
  const steps = buildSetupSteps({
    instanceOwner: user.isInstanceOwner,
    workspaceName: org.name,
    email: email.mode,
    members: counts?.members ?? 1,
    modulesOn: opts.modulesOn,
    passkeys: counts?.passkeys ?? 0,
  });
  return summarise(steps, opts.hidden);
}
