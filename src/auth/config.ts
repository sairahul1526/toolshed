/** The numbers the account code agrees on. Times are milliseconds unless the name says otherwise. */
import type { RateLimitRule } from '../core/ratelimit';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A session ends after this long without use. */
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
/** How often a session in use is pushed forward (and its "last seen" time written). */
export const SESSION_REFRESH_SEC = 60 * 60;
/** "Sign in as" sessions end on their own after this long. */
export const IMPERSONATION_TTL_SEC = 60 * 60;

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * MINUTE;
/** Wrong guesses allowed on one code before it stops working. */
export const CODE_MAX_ATTEMPTS = 5;
export const INVITE_TTL_MS = 7 * DAY;

export const MIN_PASSWORD_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 10;
export const TRUST_DEVICE_SEC = 30 * 24 * 60 * 60;

/** Ban lengths the Users screen offers. `null` means until lifted. */
export const BAN_DAYS = [null, 7, 30] as const;

/**
 * Rate limits for everything a stranger can repeat. Per-address limits stop one inbox being
 * flooded, per-IP limits stop one machine working through many addresses.
 */
export const LIMITS = {
  /** Codes sent to one address. */
  codePerEmail: { limit: 5, windowSec: 15 * 60 },
  /** Codes one IP can ask for, across all addresses. */
  codePerIp: { limit: 60, windowSec: 60 * 60 },
  /** Wrong codes for one address before sign-in for it pauses. */
  wrongPerEmail: { limit: CODE_MAX_ATTEMPTS, windowSec: 15 * 60 },
  /** Code, password and two-step checks from one IP. */
  checkPerIp: { limit: 120, windowSec: 15 * 60 },
  /** Wrong passwords for one account. */
  passwordPerAccount: { limit: 10, windowSec: 15 * 60 },
  /** Claim codes for the whole install. */
  claim: { limit: 5, windowSec: 15 * 60 },
  /** Invites one person can send. */
  invitePerUser: { limit: 50, windowSec: 60 * 60 },
  /** Passkey sign-in attempts from one IP. */
  passkeyPerIp: { limit: 60, windowSec: 15 * 60 },
} as const satisfies Record<string, RateLimitRule>;
