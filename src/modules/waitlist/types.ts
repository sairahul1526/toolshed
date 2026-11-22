import type { Row } from '../../core/db';

export const WAITLIST_STATUSES = ['draft', 'live', 'paused', 'archived'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const FRAUD_LEVELS = ['off', 'relaxed', 'balanced', 'strict'] as const;
export type FraudLevel = (typeof FRAUD_LEVELS)[number];

export const QUESTION_TYPES = ['text', 'longtext', 'select', 'checkbox'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface Question {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options: string[];
}

export interface Waitlist {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  status: WaitlistStatus;
  headline: string;
  description: string;
  button_text: string;
  success_message: string;
  image_url: string | null;
  show_count: number;
  launch_at: number | null;
  questions: string;
  double_optin: number;
  fraud_level: FraudLevel;
  blocked_domains: string;
  allowed_domains: string;
  disposable_domains: string;
  skip_per_referral: number;
  head_start: number;
  leaderboard_on: number;
  leaderboard_size: number;
  invite_url: string | null;
  anon_count: number;
  is_sample: number;
  created_at: number;
  updated_at: number;
}

export const SIGNUP_STATUSES = ['pending', 'active', 'flagged', 'invited', 'accepted', 'removed'] as const;
export type SignupStatus = (typeof SIGNUP_STATUSES)[number];

export const REFERRAL_STATUSES = ['none', 'pending', 'credited', 'held', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export interface Signup extends Row {
  id: string;
  org_id: string;
  waitlist_id: string;
  email: string;
  email_key: string;
  name: string;
  answers: string;
  tags: string;
  source: string;
  medium: string;
  campaign: string;
  visitor: string;
  code: string;
  token: string;
  seq: number;
  adj: number;
  score: number;
  manual_offset: number;
  referral_count: number;
  referred_by: string | null;
  referral_status: ReferralStatus;
  status: SignupStatus;
  email_verified: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  is_test: number;
  flag_reason: string | null;
  flag_detail: string | null;
  flagged_at: number | null;
  invite_code: string | null;
  invited_at: number | null;
  wave_id: string | null;
  invite_email_at: number | null;
  accepted_at: number | null;
  processed_at: number | null;
  created_at: number;
}

export interface Tier {
  id: string;
  org_id: string;
  waitlist_id: string;
  referrals_required: number;
  name: string;
  reward_text: string;
  created_at: number;
}

export interface Wave {
  id: string;
  org_id: string;
  waitlist_id: string;
  name: string;
  segment: string;
  size: number;
  subject: string;
  body: string;
  status: 'draft' | 'scheduled' | 'sending' | 'done' | 'cancelled';
  scheduled_at: number | null;
  base: string;
  sent: number;
  accepted: number;
  lease_until: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Broadcast {
  id: string;
  org_id: string;
  waitlist_id: string;
  subject: string;
  body: string;
  segment: string;
  status: 'draft' | 'sending' | 'done' | 'cancelled';
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  cursor: string;
  base: string;
  test_hash: string | null;
  lease_until: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Which people a list, a wave or a broadcast covers. Every field narrows the set. */
export interface Segment {
  status?: SignupStatus;
  tag?: string;
  source?: string;
  minReferrals?: number;
  tier?: string;
  q?: string;
  verified?: boolean;
}

export const EVENT_NAMES = [
  'signup.created',
  'signup.confirmed',
  'signup.referred',
  'signup.milestone',
  'signup.invited',
  'signup.accepted',
  'signup.flagged',
  'signup.removed',
] as const;
