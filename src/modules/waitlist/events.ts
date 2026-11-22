import { emit } from '../../core/events';
import type { Env } from '../../env';
import type { Signup, Waitlist } from './types';

/** The data every `signup.*` event carries. Test signups never emit, so stats stay clean. */
export function signupPayload(wl: Waitlist, s: Signup, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    waitlistId: wl.id,
    waitlistSlug: wl.slug,
    signupId: s.id,
    email: s.email,
    name: s.name,
    code: s.code,
    status: s.status,
    verified: s.email_verified === 1,
    referredBy: s.referred_by,
    referralCount: s.referral_count,
    source: s.source,
    medium: s.medium,
    campaign: s.campaign,
    flagReason: s.flag_reason,
    createdAt: s.created_at,
    ...extra,
  };
}

export async function fire(env: Env, wl: Waitlist, name: string, s: Signup, extra: Record<string, unknown> = {}): Promise<void> {
  if (s.is_test === 1) return;
  await emit(env, { orgId: wl.org_id, module: 'waitlist', name, subject: s.id, data: signupPayload(wl, s, extra) });
}
