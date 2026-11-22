/** What every tab of the Settings screen shares: the heading and the tab bar. */
import type { Child } from 'hono/jsx';
import { PageHeader, Tabs } from '../../ui';

export const BASE = '/app/settings';

export type TabId = 'general' | 'webhooks' | 'data';

export const tabHref = (tab: TabId): string => (tab === 'general' ? BASE : `${BASE}?tab=${tab}`);

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'data', label: 'Data' },
];

/** The tab a `?tab=` value names. Anything else is the first tab. */
export function readTab(value: string | undefined): TabId {
  return TABS.find((t) => t.id === value)?.id ?? 'general';
}

export function Frame({ tab, orgName, children }: { tab: TabId; orgName: string; children?: Child }) {
  return (
    <>
      <PageHeader title="Settings" soft={orgName} description="The workspace’s name and address, the webhooks that tell other services what happens here, and your data." />
      <Tabs label="Settings sections" active={tab} items={TABS.map((t) => ({ ...t, href: tabHref(t.id) }))} />
      <div>{children}</div>
    </>
  );
}

/** A short note for people who can open a tab but not use it. */
export const ADMIN_ONLY = 'Only workspace admins and owners can use this. Ask one of them.';
