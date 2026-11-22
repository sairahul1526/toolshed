/**
 * What the dashboard shell (sidebar, top bar, account menu) needs on every page.
 * The UI kit's <AppShell> calls this; screens do not need to.
 */
import type { Context } from 'hono';
import type { ActiveOrg, AppEnv, Env, SessionUser } from '../env';
import { roleAtLeast } from '../env';
import { currentImpersonation } from '../auth/service';
import { listNotifications, type NotificationItem } from './notifications';
import type { NavItem } from './module';
import { allModules, moduleContext, moduleStates } from './registry';
import { getSetting } from './settings';

export interface ShellModule {
  id: string;
  name: string;
  icon: string;
  href: string;
  /** Number shown next to the name, or null for none. */
  count: number | null;
  nav: NavItem[];
}

/** What the bell in the top bar shows. */
export interface ShellNotifications {
  /** How many the person has not read. */
  unread: number;
  /** The newest few, for the bell's menu. */
  latest: NotificationItem[];
  /** The list could not be loaded. The bell then shows no count and the page still opens. */
  failed: boolean;
}

export interface ShellData {
  user: SessionUser;
  org: ActiveOrg;
  /** Modules this workspace has turned on, in sidebar order. */
  modules: ShellModule[];
  /** How many modules exist but are off (drives the "Add a module" row). */
  modulesOff: number;
  /** Saved appearance choices for the workspace (theme preset and so on). Empty means defaults. */
  appearance: Record<string, string>;
  /** Left out by previews that have no database (/dev/ui); the bell then shows nothing new. */
  notifications?: ShellNotifications;
  /** Set while the install owner is signed in as this person. The shell then shows a strip with Stop. */
  impersonation?: ShellImpersonation | null;
}

export interface ShellImpersonation {
  /** Name (or email) of the person the browser is signed in as. */
  name: string;
  /** When the session ends by itself, ms. */
  expiresAt: number;
}

/** A failed lookup must not take the page down; the strip is then left out. */
async function loadImpersonation(c: Context<AppEnv>): Promise<ShellImpersonation | null> {
  try {
    const session = await currentImpersonation(c);
    return session ? { name: session.user.name || session.user.email, expiresAt: session.expiresAt } : null;
  } catch (err) {
    console.error('[shell] impersonation lookup failed', err);
    return null;
  }
}

const BELL_ITEMS = 5;

/** The bell must never take a page down, so a failed lookup becomes an empty bell. */
async function loadBell(env: Env, org: ActiveOrg, user: SessionUser): Promise<ShellNotifications> {
  try {
    const { unread, items } = await listNotifications(env, { orgId: org.id, userId: user.id, isAdmin: roleAtLeast(org.role, 'admin'), limit: BELL_ITEMS });
    return { unread, latest: items, failed: false };
  } catch (err) {
    console.error('[shell] notifications failed', err);
    return { unread: 0, latest: [], failed: true };
  }
}

export async function shellData(c: Context<AppEnv>): Promise<ShellData> {
  const user = c.get('user');
  const org = c.get('org');
  if (!user || !org) throw new Error('shellData needs a signed-in user and an active workspace');

  const [states, appearance, ctx, notifications, impersonation] = await Promise.all([
    moduleStates(c.env, org.id),
    getSetting<Record<string, string>>(c.env, org.id, 'appearance', {}),
    moduleContext(c.env, org),
    loadBell(c.env, org, user),
    loadImpersonation(c),
  ]);

  const on = allModules().filter((m) => states.get(m.id)?.enabled && m.dashboard);
  const modules = await Promise.all(
    on.map(async (m): Promise<ShellModule> => {
      let count: number | null = null;
      try {
        count = m.count ? await m.count(ctx) : null;
      } catch {
        count = null;
      }
      return { id: m.id, name: m.name, icon: m.icon, href: `/app/${m.id}`, count, nav: m.nav ?? [] };
    }),
  );

  return { user, org, modules, modulesOff: allModules().length - on.length, appearance, notifications, impersonation };
}
