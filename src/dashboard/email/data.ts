/** Everything the Email screen reads, in one place so each tab loads with a handful of queries. */
import { z } from 'zod';
import {
  EMAIL_STATUSES,
  emailStatus,
  getEmailCaps,
  getSender,
  listEmailLog,
  listSuppressions,
  type EmailCaps,
  type EmailLogPage,
  type EmailSetup,
  type SenderSettings,
} from '../../core/email';
import { EMAIL_LANGUAGES, renderEmail, TEMPLATE_NAMES, type RenderedEmail, type TemplateName } from '../../core/email-templates';
import { decodeCursor } from '../../core/audit';
import { parse } from '../../core/errors';
import type { Env } from '../../env';
import { SAMPLE_DATA } from './samples';

export const TABS = ['setup', 'templates', 'log', 'blocked'] as const;
export type Tab = (typeof TABS)[number];

/** Rows per page of the delivery log. Each row also carries a detail dialog, so keep it modest. */
export const LOG_PAGE_SIZE = 25;
/** Blocked addresses shown at once. */
export const BLOCKED_LIMIT = 200;

const querySchema = z.object({
  tab: z.enum(TABS).catch('setup'),
  status: z.enum(EMAIL_STATUSES as [string, ...string[]]).optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined),
  before: z.string().max(200).optional().catch(undefined),
  t: z.enum(TEMPLATE_NAMES as [TemplateName, ...TemplateName[]]).catch('sign-in-code'),
  lang: z.enum(EMAIL_LANGUAGES as [string, ...string[]]).catch('en'),
});

export type PageQuery = z.infer<typeof querySchema>;

/** Read the query string. Anything unknown falls back to a safe default instead of an error page. */
export function readQuery(url: URL): PageQuery {
  const get = (key: string) => url.searchParams.get(key) ?? undefined;
  return parse(querySchema, { tab: get('tab'), status: get('status') || undefined, q: get('q') || undefined, before: get('before') || undefined, t: get('t'), lang: get('lang') });
}

/** A page marker from an old or edited link is dropped, so the list starts again at the newest email. */
function usableCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    decodeCursor(cursor);
    return cursor;
  } catch {
    return undefined;
  }
}

export interface Viewer {
  isOwner: boolean;
  /** The workspace whose log an admin may read. */
  orgId: string;
}

export interface EmailPage {
  status: EmailSetup;
  tab: Tab;
  /** Install-wide values, loaded for the install owner only. */
  setup: { sender: SenderSettings; caps: EmailCaps } | null;
  log: EmailLogPage | null;
  blocked: { address: string; reason: string; at: number }[] | null;
  preview: { template: TemplateName; lang: string; mail: RenderedEmail } | null;
}

export async function loadEmailPage(env: Env, viewer: Viewer, query: PageQuery): Promise<EmailPage> {
  // Blocked addresses are install-wide, so only the owner gets that tab.
  const tab: Tab = query.tab === 'blocked' && !viewer.isOwner ? 'setup' : query.tab;
  const page: EmailPage = { status: await emailStatus(env), tab, setup: null, log: null, blocked: null, preview: null };

  if (tab === 'setup' && viewer.isOwner) {
    const [sender, caps] = await Promise.all([getSender(env), getEmailCaps(env)]);
    page.setup = { sender, caps };
  } else if (tab === 'log') {
    const before = usableCursor(query.before);
    page.log = await listEmailLog(env, {
      // Leaving orgId out reads the whole install, which only the owner may do.
      ...(viewer.isOwner ? {} : { orgId: viewer.orgId }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(before ? { before } : {}),
      limit: LOG_PAGE_SIZE,
    });
  } else if (tab === 'blocked') {
    page.blocked = await listSuppressions(env, BLOCKED_LIMIT);
  } else if (tab === 'templates') {
    // The data type depends on the template, which a table lookup cannot express; samples are typed per name.
    const mail = await renderEmail(env, { template: query.t, data: SAMPLE_DATA[query.t] as never, orgId: viewer.orgId, lang: query.lang });
    page.preview = { template: query.t, lang: query.lang, mail };
  }
  return page;
}
