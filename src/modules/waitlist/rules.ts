/** Pure rules: email normalisation, referral codes, the disposable list and the fraud thresholds. */
import type { FraudLevel, Waitlist } from './types';

/** Domains that hand out throwaway inboxes. Owners can replace this list per waitlist. */
export const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com',
  'throwawaymail.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.net', 'getnada.com',
  'nada.email', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'mohmal.com',
  'fakeinbox.com', 'emailondeck.com', 'spamgourmet.com', 'tempinbox.com', 'burnermail.io', 'mailcatch.com',
  'moakt.com', 'inboxkitten.com', 'discard.email', 'dropmail.me', 'emailfake.com', 'fakemail.net',
  'mytemp.email', 'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'spambox.us', 'trbvm.com', 'harakirimail.com',
  'jetable.org', 'anonbox.net', 'mailtemp.info', 'luxusmail.org', 'tempail.com', 'wegwerfmail.de',
  'einrot.com', 'cuvox.de', 'armyspy.com', 'dayrep.com', 'rhyta.com', 'teleworm.us', 'superrito.com',
];

export const FRAUD_REASONS = {
  disposable_email: 'The email address is from a throwaway inbox service.',
  many_from_visitor: 'Many signups came from the same browser and address in a short time.',
  duplicate_address: 'The email is another form of an address already on the list (a plus tag or dots).',
  self_referral: 'The email is the referrer’s own address, written another way.',
  same_visitor: 'The signup came from the same browser and address as the referrer.',
  referrer_burst: 'The referrer got many signups within a few minutes.',
} as const;
export type FraudReason = keyof typeof FRAUD_REASONS;

/** A signup-level reason holds the person out of the queue; a referral-level one only holds the credit. */
export const SIGNUP_LEVEL: readonly FraudReason[] = ['disposable_email', 'many_from_visitor', 'duplicate_address'];

export interface Thresholds {
  disposable: boolean;
  self: boolean;
  duplicate: boolean;
  sameVisitor: boolean;
  /** Earlier signups from one visitor in the last day that trigger a hold (0 = never). */
  visitorCap: number;
  /** Referrals within ten minutes that trigger a hold (0 = never). */
  burst: number;
}

export function thresholds(level: FraudLevel): Thresholds {
  switch (level) {
    case 'off':
      return { disposable: false, self: false, duplicate: false, sameVisitor: false, visitorCap: 0, burst: 0 };
    case 'relaxed':
      return { disposable: true, self: true, duplicate: false, sameVisitor: false, visitorCap: 0, burst: 0 };
    case 'strict':
      return { disposable: true, self: true, duplicate: true, sameVisitor: true, visitorCap: 1, burst: 4 };
    default:
      return { disposable: true, self: true, duplicate: true, sameVisitor: true, visitorCap: 3, burst: 10 };
  }
}

export const BURST_WINDOW_MS = 10 * 60_000;
export const VISITOR_WINDOW_MS = 24 * 3_600_000;

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Trimmed, lower-cased address, or null when it is not an email. */
export function cleanEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

/** The address with plus tags removed everywhere, and dots removed at Gmail, so aliases collapse into one. */
export function canonicalEmail(email: string): string {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A short referral code that is easy to read aloud and type. */
export function newReferralCode(length = 7): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function cleanCode(input: unknown): string {
  return typeof input === 'string' ? input.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) : '';
}

/** One domain per line (or comma), lower-cased and without leading "@". */
export function parseDomainList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.includes('.'));
}

export function domainMatches(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function isDisposable(domain: string, wl: Pick<Waitlist, 'disposable_domains'>): boolean {
  const own = parseDomainList(wl.disposable_domains);
  return domainMatches(domain, own.length ? own : DISPOSABLE_DOMAINS);
}

/** Why this address may not join at all (the owner's block and allow lists), or null. */
export function domainRefusal(domain: string, wl: Pick<Waitlist, 'blocked_domains' | 'allowed_domains'>): 'blocked' | 'not_allowed' | null {
  if (domainMatches(domain, parseDomainList(wl.blocked_domains))) return 'blocked';
  const allowed = parseDomainList(wl.allowed_domains);
  if (allowed.length && !domainMatches(domain, allowed)) return 'not_allowed';
  return null;
}

export interface ReferrerView {
  id: string;
  email_key: string;
  visitor: string;
}


/** Checks that need no database: a throwaway domain, and the referrer's own address in another form. */
export function staticFlags(
  level: FraudLevel,
  wl: Pick<Waitlist, 'disposable_domains'>,
  me: { email: string; canonical: string },
  referrer: ReferrerView | null,
): FraudReason[] {
  const t = thresholds(level);
  const out: FraudReason[] = [];
  if (t.disposable && isDisposable(domainOf(me.email), wl)) out.push('disposable_email');
  if (t.self && referrer && referrer.email_key === me.canonical) out.push('self_referral');
  return out;
}

export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug.length >= 3 ? slug : `${slug}-list`.replace(/^-/, '');
}

/** Words that would clash with the module's own public paths. */
export const RESERVED_SLUGS = ['unsubscribe', 'assets', 'embed', 'api', 'new', 'static'];
