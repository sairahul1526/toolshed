/** The JSON shapes the API returns. The private status token never leaves the database. */
import { parseJson } from '../../core/db';
import { referralLink } from './emails';
import { questionsOf } from './waitlists';
import type { Broadcast, Signup, Tier, Wave, Waitlist } from './types';

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export function waitlistJson(wl: Waitlist, base: string) {
  return {
    id: wl.id,
    name: wl.name,
    slug: wl.slug,
    status: wl.status,
    url: `${base}/w/${wl.slug}`,
    headline: wl.headline,
    description: wl.description,
    buttonText: wl.button_text,
    successMessage: wl.success_message,
    imageUrl: wl.image_url,
    showCount: wl.show_count === 1,
    launchAt: iso(wl.launch_at),
    questions: questionsOf(wl),
    doubleOptIn: wl.double_optin === 1,
    fraudLevel: wl.fraud_level,
    skipPerReferral: wl.skip_per_referral,
    headStart: wl.head_start,
    leaderboard: wl.leaderboard_on === 1,
    inviteUrl: wl.invite_url,
    createdAt: iso(wl.created_at),
  };
}

export function signupJson(wl: Waitlist, s: Signup, base: string, position: number | null = null) {
  return {
    id: s.id,
    email: s.email,
    name: s.name,
    status: s.status,
    position,
    verified: s.email_verified === 1,
    referralCode: s.code,
    referralLink: referralLink(base, wl, s),
    referrals: s.referral_count,
    referralStatus: s.referral_status,
    referredBy: s.referred_by,
    source: s.source,
    medium: s.medium,
    campaign: s.campaign,
    tags: s.tags.split(',').filter(Boolean),
    answers: parseJson<Record<string, string>>(s.answers, {}),
    flagReason: s.flag_reason,
    inviteCode: s.invite_code,
    invitedAt: iso(s.invited_at),
    acceptedAt: iso(s.accepted_at),
    unsubscribed: s.unsubscribed_at !== null,
    createdAt: iso(s.created_at),
  };
}

export const tierJson = (t: Tier) => ({ id: t.id, referralsRequired: t.referrals_required, name: t.name, reward: t.reward_text });

export const waveJson = (w: Wave) => ({
  id: w.id,
  name: w.name,
  status: w.status,
  size: w.size,
  sent: w.sent,
  accepted: w.accepted,
  subject: w.subject,
  segment: parseJson(w.segment, {}),
  scheduledAt: iso(w.scheduled_at),
  startedAt: iso(w.started_at),
  finishedAt: iso(w.finished_at),
});

export const broadcastJson = (b: Broadcast) => ({
  id: b.id,
  status: b.status,
  subject: b.subject,
  segment: parseJson(b.segment, {}),
  total: b.total,
  sent: b.sent,
  failed: b.failed,
  skipped: b.skipped,
  tested: b.test_hash !== null,
  startedAt: iso(b.started_at),
  finishedAt: iso(b.finished_at),
});
