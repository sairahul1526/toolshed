/** What each tab needs from the account services, loaded together in one go. */
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import {
  accountDeletionBlockers,
  getAccount,
  listPasskeys,
  listSessions,
  pendingEmailChange,
  type AccountSummary,
} from '../../auth/service';

export const TABS = ['account', 'security', 'sessions'] as const;
export type Tab = (typeof TABS)[number];

/** An unknown or missing `?tab=` is the first tab, never an error. */
export function parseTab(value: string | undefined): Tab {
  return TABS.find((t) => t === value) ?? 'account';
}

/**
 * ok: everything works. stale: signed in too long ago for sensitive changes. impersonating: an owner is
 * looking at this account, so nothing may change.
 */
export type Mode = 'ok' | 'stale' | 'impersonating';

export interface Loaded {
  account: AccountSummary;
  mode: Mode;
  now: number;
  pending: Awaited<ReturnType<typeof pendingEmailChange>>;
  blockers: Awaited<ReturnType<typeof accountDeletionBlockers>>;
  passkeys: Awaited<ReturnType<typeof listPasskeys>>;
  sessions: Awaited<ReturnType<typeof listSessions>>;
}

function modeOf(account: AccountSummary): Mode {
  if (account.impersonatedBy) return 'impersonating';
  return account.fresh ? 'ok' : 'stale';
}

/** Only the lists the open tab shows are read; the others stay empty. */
export async function load(c: Context<AppEnv>, tab: Tab): Promise<Loaded> {
  const now = Date.now();
  const [account, pending, blockers, passkeys, sessions] = await Promise.all([
    getAccount(c),
    tab === 'account' ? pendingEmailChange(c, now) : null,
    tab === 'account' ? accountDeletionBlockers(c) : [],
    tab === 'security' ? listPasskeys(c) : [],
    tab === 'sessions' ? listSessions(c, now) : [],
  ]);
  return { account, mode: modeOf(account), now, pending, blockers, passkeys, sessions };
}
