/**
 * The form definition: one JSON document per version. It is checked with these schemas when the
 * editor saves and again when a response arrives, so a hand-made API call cannot sneak in a shape
 * the public page cannot draw.
 */
import { z } from 'zod';
import { newId } from '../../core/db';
import { formErrors } from './errors';

export const FIELD_TYPES = [
  'short_text', 'long_text', 'email', 'number', 'phone', 'url', 'date',
  'single_choice', 'multiple_choice', 'dropdown', 'yes_no', 'consent',
  'rating', 'nps', 'csat', 'ces', 'scale',
  'file_upload', 'hidden', 'statement', 'section',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Blocks that show something rather than collect an answer. */
export const DISPLAY_TYPES: readonly FieldType[] = ['statement', 'section'];
export const CHOICE_TYPES: readonly FieldType[] = ['single_choice', 'multiple_choice', 'dropdown'];
/** Types with a fixed number scale, tallied per value for the summary. */
export const SCALE_TYPES: readonly FieldType[] = ['rating', 'nps', 'csat', 'ces', 'scale'];

export const OPS = ['is', 'is_not', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty', 'any_of'] as const;
export type Op = (typeof OPS)[number];

export const MAX_FIELDS = 200;
export const MAX_PAGES = 30;
export const MAX_DEFINITION_BYTES = 200_000;

const text = (max: number) => z.string().max(max);
const idString = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'Ids use letters, digits, dashes and underscores.');

export const conditionSchema = z.object({
  /** A field id, or a calculation id. */
  field: idString,
  op: z.enum(OPS),
  value: z.union([z.string().max(500), z.number(), z.array(z.string().max(200)).max(50)]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export const groupSchema = z.object({
  mode: z.enum(['all', 'any']).default('all'),
  rules: z.array(conditionSchema).max(20),
});
export type Group = z.infer<typeof groupSchema>;

const optionSchema = z.object({
  id: idString,
  label: text(200).min(1, 'Give every choice a label.'),
  points: z.number().min(-1000).max(1000).optional(),
});

export const fieldSchema = z.object({
  id: idString,
  type: z.enum(FIELD_TYPES),
  label: text(500),
  description: text(1000).optional(),
  /** Frozen name used for piping, URL prefill and posts from a plain HTML form. */
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Keys use lower case letters, digits and underscores.'),
  required: z.boolean().default(false),
  placeholder: text(200).optional(),
  options: z.array(optionSchema).max(100).optional(),
  min: z.number().int().min(0).max(100).optional(),
  max: z.number().int().min(1).max(100).optional(),
  minLabel: text(60).optional(),
  maxLabel: text(60).optional(),
  accept: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(20).optional(),
  maxSizeMb: z.number().min(0.1).max(50).optional(),
  maxFiles: z.number().int().min(1).max(10).optional(),
  /** Hidden fields: the URL parameter that fills them. */
  param: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).optional(),
  showIf: groupSchema.nullish(),
});
export type Field = z.infer<typeof fieldSchema>;

export const jumpSchema = z.object({
  when: groupSchema,
  /** A page id, or `end:<endingId>`. */
  to: z.string().max(60),
});

export const pageSchema = z.object({
  id: idString,
  title: text(200).optional(),
  fields: z.array(fieldSchema).max(MAX_FIELDS),
  showIf: groupSchema.nullish(),
  jump: z.array(jumpSchema).max(10).optional(),
});
export type Page = z.infer<typeof pageSchema>;

export const endingSchema = z.object({
  id: idString,
  title: text(200),
  body: text(2000).default(''),
  /** After completion the browser goes here. `{{key}}` is filled from answers when passAnswers is on. */
  redirectUrl: z.string().max(1000).optional(),
  passAnswers: z.boolean().default(false),
  buttonLabel: text(60).optional(),
  buttonUrl: z.string().max(1000).optional(),
  /** The first ending whose rule matches is shown; an ending with no rule is the fallback. */
  when: groupSchema.nullish(),
});
export type Ending = z.infer<typeof endingSchema>;

export const calcSchema = z.object({
  id: idString,
  name: text(60).min(1),
  formula: text(500),
});
export type Calc = z.infer<typeof calcSchema>;

export const definitionSchema = z.object({
  v: z.literal(1).default(1),
  intro: z.object({ title: text(200), body: text(2000).default(''), buttonLabel: text(40).default('Start') }).nullish(),
  pages: z.array(pageSchema).min(1).max(MAX_PAGES),
  endings: z.array(endingSchema).min(1).max(10),
  calcs: z.array(calcSchema).max(20).default([]),
  submitLabel: text(40).default('Submit'),
  showProgress: z.boolean().default(true),
});
export type Definition = z.infer<typeof definitionSchema>;

export const settingsSchema = z.object({
  /** `password` needs `passwordHash`. */
  access: z.enum(['public', 'password']).default('public'),
  passwordHash: z.string().max(300).nullish(),
  opensAt: z.number().int().nullish(),
  closesAt: z.number().int().nullish(),
  cap: z.number().int().min(1).max(10_000_000).nullish(),
  closedMessage: text(500).default(''),
  /** Let plain HTML forms on other sites post without the page's timing token. Off by default. */
  allowDirectPosts: z.boolean().default(false),
  notify: z.object({ enabled: z.boolean().default(false), emails: z.array(z.string().max(200)).max(10).default([]) }).default({ enabled: false, emails: [] }),
  autoresponder: z
    .object({ enabled: z.boolean().default(false), fieldId: z.string().max(40).nullish(), subject: text(200).default('We got your response'), body: text(2000).default('Thanks. We received your response and will be in touch if needed.') })
    .default({ enabled: false, subject: 'We got your response', body: 'Thanks. We received your response and will be in touch if needed.' }),
  privacy: z
    .object({
      /** Off: no browser, device or referrer details are stored with a response. */
      collectMeta: z.boolean().default(true),
      /** Off by default. When on, answers are saved as people type and the form says so. */
      partial: z.boolean().default(false),
    })
    .default({ collectMeta: true, partial: false }),
  theme: z
    .object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
      background: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
      text: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
      logoKey: z.string().max(200).nullish(),
      coverKey: z.string().max(200).nullish(),
      /** Keep the workspace's public look, or pick one of its presets for this form only. */
      preset: z.enum(['workspace', 'paper', 'warm', 'cobalt', 'dusk']).default('workspace'),
    })
    .default({ preset: 'workspace' }),
});
export type FormSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: FormSettings = settingsSchema.parse({});

export function fieldId(): string {
  return `q_${newId('x').slice(-8)}`;
}

export function pageId(): string {
  return `p_${newId('x').slice(-6)}`;
}

export function endingId(): string {
  return `e_${newId('x').slice(-6)}`;
}

/** A blank field of a type, with sensible defaults. `key` is made unique by `uniqueKey`. */
export function blankField(type: FieldType, label = '', taken: Set<string> = new Set()): Field {
  const f: Field = { id: fieldId(), type, label, key: uniqueKey(label || type, taken), required: false };
  if (CHOICE_TYPES.includes(type)) f.options = ['Option 1', 'Option 2'].map((l, i) => ({ id: `o${i + 1}`, label: l }));
  if (type === 'rating') Object.assign(f, { min: 1, max: 5 });
  if (type === 'nps') Object.assign(f, { min: 0, max: 10, minLabel: 'Not likely', maxLabel: 'Very likely' });
  if (type === 'csat') Object.assign(f, { min: 1, max: 5, minLabel: 'Very unsatisfied', maxLabel: 'Very satisfied' });
  if (type === 'ces') Object.assign(f, { min: 1, max: 7, minLabel: 'Very difficult', maxLabel: 'Very easy' });
  if (type === 'scale') Object.assign(f, { min: 1, max: 10 });
  if (type === 'file_upload') Object.assign(f, { maxSizeMb: 10, maxFiles: 1, accept: ['pdf', 'png', 'jpg', 'jpeg'] });
  return f;
}

export function slugKey(text: string): string {
  const base = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return /^[a-z]/.test(base) ? base : `q_${base || 'field'}`.slice(0, 36);
}

export function uniqueKey(text: string, taken: Set<string>): string {
  const base = slugKey(text);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 36)}_${n}`;
  taken.add(key);
  return key;
}

export function allFields(def: Definition): Field[] {
  return def.pages.flatMap((p) => p.fields);
}

/** Blocks that take an answer, in page order. */
export function questions(def: Definition): Field[] {
  return allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type));
}

/** Cross-checks the schema cannot express: unique ids and keys, real jump targets, real references. */
export function checkDefinition(def: Definition): void {
  const problems: Record<string, string> = {};
  const ids = new Set<string>();
  const keys = new Set<string>();
  const pageIds = new Set(def.pages.map((p) => p.id));
  const endingIds = new Set(def.endings.map((e) => e.id));
  const refs = new Set<string>();
  for (const page of def.pages) {
    if (ids.has(page.id)) problems[page.id] = 'Two pages share an id.';
    ids.add(page.id);
    for (const f of page.fields) {
      if (ids.has(f.id)) problems[f.id] = 'Two blocks share an id.';
      ids.add(f.id);
      if (keys.has(f.key)) problems[`${f.id}.key`] = `The key “${f.key}” is used twice.`;
      keys.add(f.key);
      refs.add(f.id);
      if (CHOICE_TYPES.includes(f.type)) {
        if (!f.options || f.options.length < 1) problems[`${f.id}.options`] = 'Add at least one choice.';
        else if (new Set(f.options.map((o) => o.id)).size !== f.options.length) problems[`${f.id}.options`] = 'Two choices share an id.';
      }
      if ((f.min ?? 0) >= (f.max ?? 100)) problems[`${f.id}.max`] = 'The top of the scale must be above the bottom.';
    }
    for (const j of page.jump ?? []) {
      const ok = j.to.startsWith('end:') ? endingIds.has(j.to.slice(4)) : pageIds.has(j.to);
      if (!ok) problems[`${page.id}.jump`] = 'A jump goes to a page that no longer exists.';
    }
  }
  for (const c of def.calcs) {
    if (ids.has(c.id)) problems[c.id] = 'Two blocks share an id.';
    ids.add(c.id);
  }
  if (endingIds.size !== def.endings.length) problems.endings = 'Two endings share an id.';
  if (Object.keys(problems).length > 0) throw formErrors.invalid_definition(undefined, problems);
}

/** Parse and cross-check a stored or submitted definition. */
export function parseDefinition(raw: unknown): Definition {
  if (JSON.stringify(raw ?? null).length > MAX_DEFINITION_BYTES) throw formErrors.definition_too_large();
  const res = definitionSchema.safeParse(raw);
  if (!res.success) {
    const fields: Record<string, string> = {};
    for (const issue of res.error.issues) {
      const path = issue.path.filter((p) => typeof p === 'string' || typeof p === 'number');
      // Name the block, not the array index, so the editor can mark the right card.
      const key = path.length ? path.join('.') : '_';
      if (!(key in fields)) fields[key] = issue.message;
    }
    throw formErrors.invalid_definition(undefined, fields);
  }
  checkDefinition(res.data);
  return res.data;
}

export function emptyDefinition(): Definition {
  return {
    v: 1,
    pages: [{ id: pageId(), fields: [] }],
    endings: [{ id: endingId(), title: 'Thanks for your response', body: 'We got it.', passAnswers: false }],
    calcs: [],
    submitLabel: 'Submit',
    showProgress: true,
  };
}
