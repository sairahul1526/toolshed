/** Everything the Get started screen (/app/welcome) shows. */
import type { Context } from 'hono';
import type { ModuleDef } from '../../core/module';
import { SAMPLE_SETTING, loadSetupProgress, setupHidden, type SetupProgress } from '../../core/onboarding';
import { allModules, moduleStates } from '../../core/registry';
import { getSetting } from '../../core/settings';
import { shellData, type ShellData } from '../../core/shell-data';
import type { AppEnv, Env } from '../../env';
import { runningVersion } from '../updates/data';

export const BASE = '/app/welcome';

export interface StartCard {
  id: string;
  /** The module's name, for the words a screen reader hears. */
  name: string;
  title: string;
  body: string;
  icon: string;
  /** Already on: the card is then a plain link to the module. */
  on: boolean;
  href: string;
}

export interface InstallFacts {
  version: string;
  /** The host this install answers on, for example toolshed.example.com. */
  address: string;
  /** Size of the database in bytes, or null when the platform does not say. */
  databaseBytes: number | null;
}

export interface WelcomeData {
  shell: ShellData;
  cards: StartCard[];
  /** How many modules exist, for the "See all N modules" card. */
  moduleCount: number;
  /** Null when the steps could not be read. The rest of the page still shows. */
  progress: SetupProgress | null;
  sample: {
    /** The switch: modules started from here get sample rows. */
    on: boolean;
    /** Names of turned-on modules that show sample rows right now. */
    showing: string[];
  };
  install: InstallFacts;
}

/** Sample rows can be added and taken away again. A module with only one half is left alone. */
export function hasSample(def: ModuleDef): boolean {
  return Boolean(def.sampleData && def.clearSampleData);
}

/** D1 reports the database size with every query. Local test databases may not. */
async function databaseBytes(env: Env): Promise<number | null> {
  try {
    const res = await env.DB.prepare('SELECT 1').all();
    const size = (res.meta as { size_after?: unknown } | undefined)?.size_after;
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

export async function loadWelcome(c: Context<AppEnv>): Promise<WelcomeData> {
  const org = c.get('org');
  if (!org) throw new Error('loadWelcome needs an active workspace');
  const [shell, states, sampleOn, bytes] = await Promise.all([
    shellData(c),
    moduleStates(c.env, org.id),
    getSetting<boolean>(c.env, org.id, SAMPLE_SETTING, true),
    databaseBytes(c.env),
  ]);

  // The shell leaves the steps out once Get started is hidden; this page shows them anyway.
  let progress = shell.setup ?? null;
  if (!progress) {
    try {
      progress = await loadSetupProgress(c, { modulesOn: shell.modules.length, hidden: await setupHidden(c) });
    } catch (err) {
      // The cards, the switch and the install facts are still worth showing without the steps.
      console.error('[welcome] setup steps failed', err);
      progress = null;
    }
  }

  const all = allModules();
  const cards = all.flatMap((m): StartCard[] => {
    if (!m.onboarding) return [];
    const on = states.get(m.id)?.enabled === true;
    return [{ id: m.id, name: m.name, title: m.onboarding.title, body: m.onboarding.body, icon: m.icon, on, href: m.dashboard ? `/app/${m.id}` : `/app/modules/${m.id}` }];
  });
  const showing = all.filter((m) => states.get(m.id)?.enabled && states.get(m.id)?.sample).map((m) => m.name);

  return {
    shell,
    cards,
    moduleCount: all.length,
    progress,
    sample: { on: sampleOn === true, showing },
    install: { version: runningVersion(), address: new URL(c.req.url).host, databaseBytes: bytes },
  };
}
