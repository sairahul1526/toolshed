/** The frame around the three tabs, and the pieces every tab shares. */
import type { Child } from 'hono/jsx';
import { Button, Callout, PageHeader, Tabs } from '../../ui';
import type { Loaded, Tab } from './data';
import type { Kept, Problem, Section } from './problem';

export const BASE = '/app/account';

export interface View {
  data: Loaded;
  tab: Tab;
  /** The refusal to show after a failed post, next to the field it belongs to. */
  problem: Problem | null;
  kept: Kept;
}

/** The message for one field, when the last refusal belongs to exactly that field. */
export function fieldError(v: View, section: Section, field: string): string | undefined {
  return v.problem?.section === section && v.problem.field === field ? v.problem.message : undefined;
}

/** "Sign in again" is a sign-out: the sign-in page that follows is the fresh sign-in the service asks for. */
function SignInAgain() {
  return (
    <form method="post" action="/api/auth/sign-out">
      <Button type="submit" size="sm">
        Sign in again
      </Button>
    </form>
  );
}

/**
 * A refusal with no field of its own (or one this section did not draw), shown at the top of the section.
 * `shown` lists the fields the section does draw, so nothing is ever swallowed.
 */
export function Notice({ v, section, shown = [] }: { v: View; section: Section; shown?: string[] }) {
  const p = v.problem;
  if (!p || p.section !== section || (p.field && shown.includes(p.field))) return null;
  return (
    <Callout tone="bad" title={p.signIn ? 'Sign in again first' : 'That did not work'} actions={p.signIn ? <SignInAgain /> : undefined}>
      {p.message}
    </Callout>
  );
}

function Banner({ mode }: { mode: Loaded['mode'] }) {
  if (mode === 'stale') {
    return (
      <Callout tone="warn" title="Sign in again to change sign-in settings" actions={<SignInAgain />}>
        You signed in a while ago. For safety, email, password, two-step, passkeys and account deletion need a recent sign-in.
      </Callout>
    );
  }
  if (mode === 'impersonating') {
    return (
      <Callout tone="info" title="You are viewing this account as its owner">
        Nothing here can be changed while you are signed in as someone else.
      </Callout>
    );
  }
  return null;
}

const TAB_ITEMS = [
  { id: 'account', label: 'Account', href: BASE },
  { id: 'security', label: 'Security', href: `${BASE}?tab=security` },
  { id: 'sessions', label: 'Devices', href: `${BASE}?tab=sessions` },
];

export function Frame({ v, children }: { v: View; children?: Child }) {
  return (
    <>
      <PageHeader title="Your account" description={`Signed in as ${v.data.account.email}. Only you can see this.`} />
      <Tabs items={TAB_ITEMS} active={v.tab} label="Account sections" />
      <div class="stack">
        <Banner mode={v.data.mode} />
        {children}
      </div>
    </>
  );
}
