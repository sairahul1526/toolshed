import type { ModuleContext } from '../../core/module';
import { orgDb } from '../../core/db';
import type { Env } from '../../env';

export type Ctx = ModuleContext;

/** A context for code that only has a workspace id (jobs, schedules, public pages). */
export function ctxOf(env: Env, orgId: string): Ctx {
  return { env, org: { id: orgId, name: '', slug: '' }, db: orgDb(env.DB, orgId) };
}

export interface List {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string;
  double_opt_in: number;
  reply_to: string;
  thanks_text: string;
  archive_public: number;
  is_sample: number;
  created_at: number;
  updated_at: number;
}

export interface Subscriber {
  id: string;
  org_id: string;
  email: string;
  name: string;
  fields: string;
  source: string;
  consent_note: string;
  consent_at: number | null;
  opens: number;
  clicks: number;
  is_sample: number;
  created_at: number;
  updated_at: number;
}

export type MembershipStatus = 'pending' | 'active' | 'unsubscribed';

export interface Membership {
  org_id: string;
  list_id: string;
  subscriber_id: string;
  status: MembershipStatus;
  joined_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  confirm_sent_at: number | null;
}

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'failed';

export interface Broadcast {
  id: string;
  org_id: string;
  list_id: string;
  subject: string;
  preheader: string;
  format: 'markdown' | 'html';
  body: string;
  filter: string;
  status: BroadcastStatus;
  scheduled_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
  next_run_at: number | null;
  lock_until: number | null;
  total: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  track_opens: number;
  track_clicks: number;
  in_archive: number;
  archive_slug: string;
  last_test_at: number | null;
  last_error: string;
  source: string;
  is_sample: number;
  created_at: number;
  updated_at: number;
}

export interface Delivery {
  id: string;
  org_id: string;
  broadcast_id: string;
  subscriber_id: string;
  email: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
  reason: string;
  claimed_at: number | null;
  attempts: number;
  sent_at: number | null;
  opened_at: number | null;
  open_count: number;
  clicked_at: number | null;
  click_count: number;
  created_at: number;
}

export const SUPPRESSION_REASONS = ['unsubscribed', 'bounced', 'complaint', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];
