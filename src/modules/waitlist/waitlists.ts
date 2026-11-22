/** Waitlists and their reward tiers: validation, create, change, delete, and the counts shown in lists. */
import { z } from 'zod';
import { newId, parseJson, type OrgDb } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { wlErrors } from './errors';
import { RESERVED_SLUGS, slugify } from './rules';
import { FRAUD_LEVELS, QUESTION_TYPES, WAITLIST_STATUSES, type Question, type Tier, type Waitlist } from './types';

const bool = z.preprocess((v) => (v === 'on' || v === 'true' || v === '1' || v === 1 || v === true ? 1 : v === undefined ? undefined : 0), z.union([z.literal(0), z.literal(1)]));
const int = (min: number, max: number) => z.preprocess((v) => (v === '' || v === null ? undefined : typeof v === 'string' ? Number(v) : v), z.number().int().min(min).max(max));
const url = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(500).refine((u) => /^https?:\/\/[^\s]+$/i.test(u), 'Use a full address starting with http:// or https://').nullable(),
);
const when = z.preprocess((v) => {
  if (v === '' || v === null || v === undefined) return v === undefined ? undefined : null;
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? v : t;
}, z.number().int().nullable());

const question = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
  label: z.string().trim().min(1).max(120),
  type: z.enum(QUESTION_TYPES),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
}).refine((q) => q.type !== 'select' || q.options.length > 0, {
  message: 'A select question needs its choices after a fourth bar, for example: Team size | select | required | 1-5, 6-20, 21+',
  path: ['options'],
});

export const waitlistSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'Use 3 to 40 letters, numbers or dashes'),
  status: z.enum(WAITLIST_STATUSES),
  headline: z.string().trim().max(120),
  description: z.string().trim().max(600),
  button_text: z.string().trim().min(1).max(40),
  success_message: z.string().trim().max(300),
  image_url: url,
  show_count: bool,
  launch_at: when,
  questions: z.array(question).max(5),
  double_optin: bool,
  fraud_level: z.enum(FRAUD_LEVELS),
  blocked_domains: z.string().max(2000),
  allowed_domains: z.string().max(2000),
  disposable_domains: z.string().max(4000),
  skip_per_referral: int(0, 1000),
  head_start: int(0, 1_000_000),
  leaderboard_on: bool,
  leaderboard_size: int(1, 50),
  invite_url: url,
});

export type WaitlistInput = z.infer<typeof waitlistSchema>;

/** Turns the text of a questions editor (`label | type | required | a, b`) into questions, one per line. */
export function questionsFromText(text: string): Question[] {
  const out: Question[] = [];
  for (const line of text.split('\n')) {
    const [label = '', type = 'text', required = '', options = ''] = line.split('|').map((p) => p.trim());
    if (!label) continue;
    out.push({
      id: `q${out.length + 1}`,
      label,
      type: (QUESTION_TYPES as readonly string[]).includes(type) ? (type as Question['type']) : 'text',
      required: required === 'required',
      options: options ? options.split(',').map((o) => o.trim()).filter(Boolean) : [],
    });
  }
  return out;
}

export function questionsToText(questions: Question[]): string {
  return questions.map((q) => [q.label, q.type, q.required ? 'required' : 'optional', q.options.join(', ')].join(' | ')).join('\n');
}

export function questionsOf(wl: Pick<Waitlist, 'questions'>): Question[] {
  return parseJson<Question[]>(wl.questions, []);
}

export const DEFAULTS: WaitlistInput = {
  name: 'My waitlist',
  slug: 'my-waitlist',
  status: 'live',
  headline: 'Be first in line',
  description: 'Join the waitlist and share your link to move up.',
  button_text: 'Join the waitlist',
  success_message: '',
  image_url: null,
  show_count: 1,
  launch_at: null,
  questions: [],
  double_optin: 1,
  fraud_level: 'balanced',
  blocked_domains: '',
  allowed_domains: '',
  disposable_domains: '',
  skip_per_referral: 5,
  head_start: 0,
  leaderboard_on: 1,
  leaderboard_size: 10,
  invite_url: null,
};

async function assertSlugFree(db: OrgDb, slug: string, exceptId?: string): Promise<void> {
  if (RESERVED_SLUGS.includes(slug)) throw wlErrors.slug_taken(undefined, { slug: 'That address is reserved. Pick another.' });
  const row = await db.d1.prepare('SELECT id FROM wl_waitlists WHERE slug = ?1').bind(slug).first<{ id: string }>();
  if (row && row.id !== exceptId) throw wlErrors.slug_taken(undefined, { slug: 'That address is taken. Pick another.' });
}

/** An address that is free, built from a name: `launch`, then `launch-2`, `launch-3`. */
export async function freeSlug(db: OrgDb, name: string): Promise<string> {
  const base = slugify(name);
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`.slice(0, 40);
    try {
      await assertSlugFree(db, slug);
      return slug;
    } catch {
      continue;
    }
  }
  return `${base}-${newId('x').slice(-6)}`.slice(0, 40);
}

export async function createWaitlist(db: OrgDb, input: Partial<WaitlistInput> & { name: string }, opts: { sample?: boolean; now?: number } = {}): Promise<Waitlist> {
  const now = opts.now ?? Date.now();
  const slug = input.slug ?? (await freeSlug(db, input.name));
  const data = parse(waitlistSchema, { ...DEFAULTS, ...input, slug });
  await assertSlugFree(db, data.slug);
  return db.insert<Waitlist>('wl_waitlists', {
    id: newId('wl', now),
    ...data,
    questions: JSON.stringify(data.questions),
    is_sample: opts.sample ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
}

/** Change some fields. Changing the referral bump rescored everyone in one statement. */
export async function updateWaitlist(db: OrgDb, id: string, patch: Record<string, unknown>, now = Date.now()): Promise<Waitlist> {
  const current = await getWaitlist(db, id);
  const merged = { ...current, ...patch, questions: patch.questions ?? questionsOf(current) };
  const data = parse(waitlistSchema, merged);
  if (data.slug !== current.slug) await assertSlugFree(db, data.slug, id);
  const saved = await db.update<Waitlist>('wl_waitlists', id, { ...data, questions: JSON.stringify(data.questions), updated_at: now });
  if (!saved) throw wlErrors.not_found();
  if (data.skip_per_referral !== current.skip_per_referral) {
    await db.run('UPDATE wl_signups SET adj = manual_offset - ? * referral_count WHERE org_id = :org AND waitlist_id = ?', data.skip_per_referral, id);
  }
  return saved;
}

export async function getWaitlist(db: OrgDb, id: string): Promise<Waitlist> {
  const wl = await db.get<Waitlist>('wl_waitlists', id);
  if (!wl) throw wlErrors.not_found();
  return wl;
}

export function listWaitlists(db: OrgDb): Promise<Waitlist[]> {
  return db.list<Waitlist>('wl_waitlists', { orderBy: 'created_at DESC', limit: 200 });
}

/** Delete a waitlist and every row that belongs to it. */
export async function deleteWaitlist(db: OrgDb, id: string): Promise<void> {
  await getWaitlist(db, id);
  for (const table of ['wl_reached', 'wl_signups', 'wl_tiers', 'wl_waves', 'wl_broadcasts', 'wl_daily']) {
    await db.run(`DELETE FROM ${table} WHERE org_id = :org AND waitlist_id = ?`, id);
  }
  await db.remove('wl_waitlists', id);
}

export interface Counts {
  total: number;
  pending: number;
  active: number;
  flagged: number;
  invited: number;
  accepted: number;
  removed: number;
}

/** People per status for each waitlist, test signups left out. */
export async function countsByWaitlist(db: OrgDb): Promise<Map<string, Counts>> {
  const rows = await db.all<{ waitlist_id: string; status: string; n: number }>(
    'SELECT waitlist_id, status, COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND is_test = 0 GROUP BY waitlist_id, status',
  );
  const out = new Map<string, Counts>();
  for (const r of rows) {
    const c = out.get(r.waitlist_id) ?? { total: 0, pending: 0, active: 0, flagged: 0, invited: 0, accepted: 0, removed: 0 };
    c[r.status as keyof Omit<Counts, 'total'>] = r.n;
    if (r.status !== 'removed') c.total += r.n;
    out.set(r.waitlist_id, c);
  }
  return out;
}

export function emptyCounts(): Counts {
  return { total: 0, pending: 0, active: 0, flagged: 0, invited: 0, accepted: 0, removed: 0 };
}

// ---- Reward tiers ----

export const tierSchema = z.object({
  referrals_required: int(1, 10_000),
  name: z.string().trim().min(1).max(60),
  reward_text: z.string().trim().max(300).default(''),
});

export function listTiers(db: OrgDb, waitlistId: string): Promise<Tier[]> {
  return db.list<Tier>('wl_tiers', { where: { waitlist_id: waitlistId }, orderBy: 'referrals_required ASC', limit: 50 });
}

export async function addTier(db: OrgDb, waitlistId: string, input: unknown, now = Date.now()): Promise<Tier> {
  await getWaitlist(db, waitlistId);
  const data = parse(tierSchema, input);
  if ((await db.count('wl_tiers', { waitlist_id: waitlistId })) >= 20) throw errors.validation_failed('A waitlist can have up to 20 reward tiers.');
  return db.insert<Tier>('wl_tiers', { id: newId('wlt', now), waitlist_id: waitlistId, ...data, created_at: now });
}

export async function removeTier(db: OrgDb, waitlistId: string, tierId: string): Promise<void> {
  const tier = await db.get<Tier>('wl_tiers', tierId);
  if (!tier || tier.waitlist_id !== waitlistId) throw wlErrors.not_found();
  await db.run('DELETE FROM wl_reached WHERE org_id = :org AND tier_id = ?', tierId);
  await db.remove('wl_tiers', tierId);
}
