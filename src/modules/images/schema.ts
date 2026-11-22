/**
 * The shape of a template, checked on every save and again before a render.
 * A template is a canvas, a list of named fields, and layers drawn bottom to top. A layer property
 * can hold `{{field}}`, which is replaced by the field's value when the image is made.
 */
import { z } from 'zod';

export const MAX_CANVAS = 2400;
export const MIN_CANVAS = 16;
export const MAX_LAYERS = 40;
export const MAX_FIELDS = 20;
export const MAX_TEXT = 2000;
/** A stored template may not be larger than this, so one row never holds megabytes of JSON. */
export const MAX_DOC_BYTES = 64 * 1024;

/** URL parameters with a meaning of their own, so no field may take these names. */
export const RESERVED_PARAMS = ['sig', 'w', 'v', 'exp'];

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const REFERENCE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const HEX = '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})';
const PAINT = new RegExp(`^(?:${HEX}|\\{\\{\\s*[a-zA-Z][a-zA-Z0-9_]*\\s*\\}\\})$`);
const IMAGE_SRC = /^(?:asset:[a-z0-9_]{4,64}|https:\/\/[^\s"'<>]{4,580}|\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\})$/;

const paint = z.string().regex(PAINT, 'Use a hex colour such as #1d4ed8, or a field such as {{accent}}.');
const optionalPaint = z.union([z.literal(''), paint]).optional();
const coordinate = z.number().min(-2 * MAX_CANVAS).max(2 * MAX_CANVAS);
const extent = z.number().min(0).max(2 * MAX_CANVAS);

const base = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Layer ids use letters, numbers, dashes and underscores.'),
  name: z.string().max(60).optional(),
  x: coordinate,
  y: coordinate,
  w: extent,
  h: extent,
  opacity: z.number().min(0).max(1).optional(),
  rotate: z.number().min(-360).max(360).optional(),
  hidden: z.boolean().optional(),
};

const shape = {
  ...base,
  fill: optionalPaint,
  fill2: optionalPaint,
  angle: z.number().min(-360).max(360).optional(),
  stroke: optionalPaint,
  strokeWidth: z.number().min(0).max(200).optional(),
};

const rectLayer = z.object({ ...shape, type: z.literal('rect'), radius: z.number().min(0).max(MAX_CANVAS).optional() });
const ellipseLayer = z.object({ ...shape, type: z.literal('ellipse') });
const lineLayer = z.object({ ...base, type: z.literal('line'), stroke: paint, strokeWidth: z.number().min(0.5).max(200).optional() });

const textLayer = z.object({
  ...base,
  type: z.literal('text'),
  text: z.string().max(MAX_TEXT, `Keep text under ${MAX_TEXT} characters.`),
  font: z.string().max(80).optional(),
  weight: z.number().int().min(100).max(900).optional(),
  size: z.number().min(4).max(800),
  fit: z.enum(['none', 'shrink']).optional(),
  minSize: z.number().min(4).max(800).optional(),
  maxLines: z.number().int().min(0).max(50).optional(),
  lineHeight: z.number().min(0.6).max(3).optional(),
  letterSpacing: z.number().min(-0.2).max(1).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom']).optional(),
  color: paint,
  upper: z.boolean().optional(),
});

const imageLayer = z.object({
  ...base,
  type: z.literal('image'),
  src: z.union([z.literal(''), z.string().regex(IMAGE_SRC, 'Pick a picture from your assets, use an https:// address, or a field such as {{photo}}.')]),
  fit: z.enum(['cover', 'contain']).optional(),
  radius: z.number().min(0).max(MAX_CANVAS).optional(),
});

export const layerSchema = z.discriminatedUnion('type', [rectLayer, ellipseLayer, lineLayer, textLayer, imageLayer]);

export const fieldSchema = z.object({
  name: z
    .string()
    .regex(FIELD_NAME, 'Start with a letter, then letters, numbers or underscores (32 at most).')
    .refine((name) => !RESERVED_PARAMS.includes(name), 'That name is used by the image URL itself. Pick another.'),
  label: z.string().max(60).optional(),
  type: z.enum(['text', 'color', 'image']),
  default: z.string().max(MAX_TEXT),
  maxLength: z.number().int().min(1).max(MAX_TEXT).optional(),
});

function references(value: unknown): string[] {
  return typeof value === 'string' ? [...value.matchAll(REFERENCE)].map((m) => m[1]!) : [];
}

export const docSchema = z
  .object({
    v: z.literal(1),
    width: z.number().int().min(MIN_CANVAS, `The canvas must be at least ${MIN_CANVAS} px wide.`).max(MAX_CANVAS, `The canvas can be ${MAX_CANVAS} px wide at most.`),
    height: z.number().int().min(MIN_CANVAS, `The canvas must be at least ${MIN_CANVAS} px tall.`).max(MAX_CANVAS, `The canvas can be ${MAX_CANVAS} px tall at most.`),
    background: paint,
    background2: optionalPaint,
    backgroundAngle: z.number().min(-360).max(360).optional(),
    fields: z.array(fieldSchema).max(MAX_FIELDS, `A template can have ${MAX_FIELDS} fields at most.`),
    layers: z.array(layerSchema).max(MAX_LAYERS, `A template can have ${MAX_LAYERS} layers at most.`),
  })
  .superRefine((doc, ctx) => {
    const fields = new Map<string, string>();
    doc.fields.forEach((field, i) => {
      if (fields.has(field.name)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'name'], message: `Two fields are called "${field.name}". Rename one.` });
      fields.set(field.name, field.type);
      if (field.type === 'color' && !new RegExp(`^${HEX}$`).test(field.default)) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'default'], message: 'A colour field needs a hex colour as its default, such as #1d4ed8.' });
      }
    });
    const ids = new Set<string>();
    const check = (value: unknown, path: (string | number)[]) => {
      for (const name of references(value)) {
        if (!fields.has(name)) ctx.addIssue({ code: 'custom', path, message: `This uses {{${name}}}, but there is no field with that name. Add the field or remove it.` });
      }
    };
    check(doc.background, ['background']);
    check(doc.background2, ['background2']);
    doc.layers.forEach((layer, i) => {
      if (ids.has(layer.id)) ctx.addIssue({ code: 'custom', path: ['layers', i, 'id'], message: 'Two layers share this id.' });
      ids.add(layer.id);
      for (const [key, value] of Object.entries(layer)) check(value, ['layers', i, key]);
    });
  });

export type TemplateDoc = z.infer<typeof docSchema>;
export type TemplateLayer = z.infer<typeof layerSchema>;
export type TemplateField = z.infer<typeof fieldSchema>;

/** Sizes people ask for by name. `id` is stable: it is stored with starter templates and used in the API. */
export const PRESETS = [
  { id: 'og', name: 'Link preview', hint: 'Open Graph, 1200 × 630', width: 1200, height: 630 },
  { id: 'x', name: 'X card', hint: '1200 × 675', width: 1200, height: 675 },
  { id: 'linkedin', name: 'LinkedIn post', hint: '1200 × 627', width: 1200, height: 627 },
  { id: 'instagram-square', name: 'Instagram square', hint: '1080 × 1080', width: 1080, height: 1080 },
  { id: 'instagram-story', name: 'Instagram story', hint: '1080 × 1920', width: 1080, height: 1920 },
  { id: 'youtube', name: 'YouTube thumbnail', hint: '1280 × 720', width: 1280, height: 720 },
] as const;

/** An empty canvas with one text layer, so a new template is never a blank page. */
export function blankDoc(width: number, height: number): TemplateDoc {
  const pad = Math.round(Math.min(width, height) * 0.1);
  return {
    v: 1,
    width,
    height,
    background: '#ffffff',
    fields: [{ name: 'title', label: 'Title', type: 'text', default: 'Your title here', maxLength: 120 }],
    layers: [
      {
        id: 'title',
        name: 'Title',
        type: 'text',
        text: '{{title}}',
        x: pad,
        y: pad,
        w: width - pad * 2,
        h: height - pad * 2,
        size: Math.round(Math.min(width, height) * 0.12),
        weight: 800,
        fit: 'shrink',
        maxLines: 4,
        lineHeight: 1.1,
        valign: 'middle',
        color: '#0f172a',
      },
    ],
  };
}
