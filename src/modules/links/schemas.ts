import { z } from 'zod';
import { linkErrors } from './errors';
import type { RuleDef } from './types';

const trimmed = (max: number) => z.string().trim().max(max);

export const DEVICES = ['mobile', 'tablet', 'desktop'] as const;
export const OSES = ['ios', 'android', 'windows', 'macos', 'linux', 'chromeos'] as const;

const dateInput = z.union([z.string(), z.number(), z.null()]);

/** Accepts an ISO time, a number of milliseconds, or a local `YYYY-MM-DDTHH:mm` (read as UTC). */
export function toMs(value: string | number | null | undefined, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Math.trunc(value);
  } else {
    const s = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(value) ? `${value}Z` : value;
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return ms;
  }
  throw linkErrors.url_invalid('Enter a valid date and time.', { [field]: 'Enter a valid date and time.' });
}

const ruleSchema = z.object({
  kind: z.enum(['country', 'device', 'os']),
  values: z.array(trimmed(40)).min(1).max(30),
  url: trimmed(2048),
});

/** Make rule values comparable: countries in capitals, devices and systems in lowercase words. */
export function normalizeRule(r: z.infer<typeof ruleSchema>): RuleDef {
  const values = [...new Set(r.values.map((v) => v.trim()).filter(Boolean))].map((v) => {
    if (r.kind === 'country') return v.toUpperCase();
    const lower = v.toLowerCase();
    if (r.kind === 'os') return lower === 'ipados' || lower === 'iphone' || lower === 'ipad' ? 'ios' : lower === 'mac' || lower === 'macos' || lower === 'os x' ? 'macos' : lower;
    return lower;
  });
  return { kind: r.kind, values, url: r.url };
}

export function ruleValuesValid(rule: RuleDef): boolean {
  if (!rule.values.length) return false;
  if (rule.kind === 'country') return rule.values.every((v) => /^[A-Z]{2}$/.test(v));
  if (rule.kind === 'device') return rule.values.every((v) => (DEVICES as readonly string[]).includes(v));
  return rule.values.every((v) => (OSES as readonly string[]).includes(v));
}

const utmSchema = z.object({
  source: trimmed(100).optional(),
  medium: trimmed(100).optional(),
  campaign: trimmed(100).optional(),
  term: trimmed(100).optional(),
  content: trimmed(100).optional(),
});

const tagSchema = z.string().trim().toLowerCase().min(1).max(32).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Tags use letters, numbers, spaces, dashes and underscores.');

const fields = {
  url: trimmed(4096),
  code: trimmed(64).optional(),
  title: trimmed(200),
  notes: trimmed(2000),
  redirectType: z.union([z.literal(301), z.literal(302), z.literal(307)]),
  folderId: z.string().max(64).nullable(),
  tags: z.array(tagSchema).max(20),
  startsAt: dateInput,
  expiresAt: dateInput,
  clickCap: z.number().int().min(1).max(1_000_000_000).nullable(),
  /** A new password. `null` removes the password. Leave it out to keep what is there. */
  password: z.string().min(4, 'Use at least 4 characters.').max(128).nullable(),
  expiredUrl: trimmed(2048).nullable(),
  forwardQuery: z.boolean(),
  rules: z.array(ruleSchema).max(20),
  preview: z.object({ title: trimmed(120).optional(), description: trimmed(300).optional(), image: trimmed(2048).optional() }),
  utm: utmSchema,
  status: z.enum(['active', 'archived']),
};

export const createLinkSchema = z.object({
  url: fields.url,
  code: fields.code,
  title: fields.title.optional(),
  notes: fields.notes.optional(),
  redirectType: fields.redirectType.optional(),
  folderId: fields.folderId.optional(),
  tags: fields.tags.optional(),
  startsAt: fields.startsAt.optional(),
  expiresAt: fields.expiresAt.optional(),
  clickCap: fields.clickCap.optional(),
  password: fields.password.optional(),
  expiredUrl: fields.expiredUrl.optional(),
  forwardQuery: fields.forwardQuery.optional(),
  rules: fields.rules.optional(),
  preview: fields.preview.optional(),
  utm: fields.utm.optional(),
});

export const updateLinkSchema = createLinkSchema.extend({ url: fields.url.optional(), status: fields.status.optional() });

export type CreateLinkInput = z.infer<typeof createLinkSchema>;
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().toLowerCase().max(32).optional(),
  folder: z.string().max(64).optional(),
  status: z.enum(['active', 'archived', 'disabled', 'all']).optional(),
  sort: z.enum(['newest', 'oldest', 'clicks', 'title', 'code']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const bulkCreateSchema = z.object({ links: z.array(createLinkSchema).min(1) });

export const bulkActionSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(200),
  action: z.enum(['archive', 'restore', 'delete', 'tag', 'untag', 'move']),
  tag: tagSchema.optional(),
  folderId: z.string().max(64).nullable().optional(),
});

export { tagSchema };
