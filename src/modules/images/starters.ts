/**
 * The starter pack: finished templates a new workspace can use in one click.
 * Each one is an ordinary template document, so everything about it can be changed in the editor.
 */
import type { TemplateDoc, TemplateField, TemplateLayer } from './schema';

export interface Starter {
  key: string;
  name: string;
  description: string;
  doc: TemplateDoc;
}

type TextLayer = Extract<TemplateLayer, { type: 'text' }>;

function text(id: string, name: string, box: [number, number, number, number], props: Omit<TextLayer, 'id' | 'name' | 'type' | 'x' | 'y' | 'w' | 'h'>): TemplateLayer {
  return { id, name, type: 'text', x: box[0], y: box[1], w: box[2], h: box[3], ...props };
}

function field(name: string, label: string, value: string, maxLength = 120): TemplateField {
  return { name, label, type: 'text', default: value, maxLength };
}

function colour(name: string, label: string, value: string): TemplateField {
  return { name, label, type: 'color', default: value };
}

const blog: Starter = {
  key: 'blog',
  name: 'Blog post',
  description: 'Title, site and author on a dark card. The title shrinks to fit.',
  doc: {
    v: 1,
    width: 1200,
    height: 630,
    background: '#0f172a',
    fields: [
      field('title', 'Title', 'How we cut our image bill to zero', 140),
      field('site', 'Site', 'example.com', 60),
      field('author', 'Author line', 'Ada Park · 6 min read', 80),
      colour('accent', 'Accent colour', '#22d3ee'),
    ],
    layers: [
      { id: 'bar', name: 'Accent bar', type: 'rect', x: 80, y: 84, w: 72, h: 10, radius: 5, fill: '{{accent}}' },
      text('site', 'Site', [176, 68, 900, 44], { text: '{{site}}', size: 30, weight: 600, color: '#94a3b8', valign: 'middle', maxLines: 1 }),
      text('title', 'Title', [80, 160, 1040, 300], { text: '{{title}}', size: 84, minSize: 46, weight: 800, fit: 'shrink', maxLines: 3, lineHeight: 1.1, valign: 'middle', color: '#ffffff' }),
      { id: 'rule', name: 'Line', type: 'line', x: 80, y: 500, w: 1040, h: 0, stroke: '#1e293b', strokeWidth: 2 },
      text('author', 'Author line', [80, 522, 1040, 44], { text: '{{author}}', size: 30, weight: 400, color: '#cbd5e1', valign: 'middle', maxLines: 1 }),
    ],
  },
};

const launch: Starter = {
  key: 'launch',
  name: 'Launch card',
  description: 'A centred headline on a gradient, with a small label on top.',
  doc: {
    v: 1,
    width: 1200,
    height: 630,
    background: '{{from}}',
    background2: '{{to}}',
    backgroundAngle: 135,
    fields: [
      field('label', 'Label', 'New', 24),
      field('title', 'Title', 'Templates you can change from a URL', 120),
      field('subtitle', 'Subtitle', 'One link in, one finished image out.', 140),
      colour('from', 'Gradient start', '#4f46e5'),
      colour('to', 'Gradient end', '#db2777'),
    ],
    layers: [
      { id: 'pill', name: 'Label background', type: 'rect', x: 500, y: 96, w: 200, h: 56, radius: 28, fill: '#ffffff33' },
      text('label', 'Label', [500, 96, 200, 56], { text: '{{label}}', size: 26, weight: 600, align: 'center', valign: 'middle', color: '#ffffff', upper: true, letterSpacing: 0.08, fit: 'shrink', maxLines: 1 }),
      text('title', 'Title', [110, 190, 980, 230], { text: '{{title}}', size: 80, minSize: 44, weight: 800, fit: 'shrink', maxLines: 3, lineHeight: 1.08, align: 'center', valign: 'middle', color: '#ffffff' }),
      text('subtitle', 'Subtitle', [160, 440, 880, 90], { text: '{{subtitle}}', size: 32, weight: 400, fit: 'shrink', maxLines: 2, lineHeight: 1.3, align: 'center', color: '#ffffffd9' }),
    ],
  },
};

const xCard: Starter = {
  key: 'x-card',
  name: 'X post card',
  description: 'A serif quote on a light card with a handle underneath.',
  doc: {
    v: 1,
    width: 1200,
    height: 675,
    background: '#f8fafc',
    fields: [field('quote', 'Text', 'Ship the small thing today. Fix it tomorrow.', 220), field('handle', 'Handle', '@example', 40), colour('ink', 'Text colour', '#0f172a')],
    layers: [
      { id: 'frame', name: 'Frame', type: 'rect', x: 40, y: 40, w: 1120, h: 595, radius: 28, fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 2 },
      text('quote', 'Text', [120, 110, 960, 380], { text: '{{quote}}', font: 'libre-baskerville', size: 68, minSize: 36, weight: 700, fit: 'shrink', maxLines: 5, lineHeight: 1.2, valign: 'middle', color: '{{ink}}' }),
      { id: 'dot', name: 'Dot', type: 'ellipse', x: 120, y: 541, w: 22, h: 22, fill: '#0ea5e9' },
      text('handle', 'Handle', [158, 530, 800, 44], { text: '{{handle}}', font: 'jetbrains-mono', size: 28, weight: 500, valign: 'middle', color: '#475569', maxLines: 1 }),
    ],
  },
};

const quote: Starter = {
  key: 'quote',
  name: 'Quote square',
  description: 'A centred quote for an Instagram post.',
  doc: {
    v: 1,
    width: 1080,
    height: 1080,
    background: '#111827',
    fields: [field('quote', 'Quote', 'Simple things should be simple.', 240), field('name', 'Name', 'Alan Kay', 60), colour('accent', 'Accent colour', '#f59e0b')],
    layers: [
      { id: 'ring', name: 'Circle', type: 'ellipse', x: 760, y: -180, w: 520, h: 520, fill: '{{accent}}', opacity: 0.18 },
      text('mark', 'Quote mark', [100, 120, 200, 200], { text: '“', font: 'libre-baskerville', size: 240, weight: 700, color: '{{accent}}', maxLines: 1 }),
      text('quote', 'Quote', [100, 300, 880, 500], { text: '{{quote}}', font: 'libre-baskerville', size: 76, minSize: 40, weight: 400, fit: 'shrink', maxLines: 6, lineHeight: 1.25, valign: 'middle', color: '#f9fafb' }),
      { id: 'rule', name: 'Line', type: 'rect', x: 100, y: 868, w: 80, h: 6, radius: 3, fill: '{{accent}}' },
      text('name', 'Name', [100, 900, 880, 56], { text: '{{name}}', size: 36, weight: 600, valign: 'middle', color: '#d1d5db', maxLines: 1 }),
    ],
  },
};

const story: Starter = {
  key: 'story',
  name: 'Story announcement',
  description: 'A tall card for Instagram stories: date, headline and a button.',
  doc: {
    v: 1,
    width: 1080,
    height: 1920,
    background: '#0f766e',
    background2: '#134e4a',
    backgroundAngle: 180,
    fields: [field('date', 'Date', 'Friday 12 June', 40), field('title', 'Headline', 'Doors open at seven', 100), field('detail', 'Detail', 'Live music, good coffee and room for everyone.', 160), field('button', 'Button', 'Save the date', 30)],
    layers: [
      text('date', 'Date', [100, 420, 880, 70], { text: '{{date}}', size: 44, weight: 600, upper: true, letterSpacing: 0.1, color: '#99f6e4', maxLines: 1, fit: 'shrink' }),
      text('title', 'Headline', [100, 520, 880, 620], { text: '{{title}}', size: 150, minSize: 80, weight: 800, fit: 'shrink', maxLines: 4, lineHeight: 1.02, color: '#ffffff' }),
      text('detail', 'Detail', [100, 1180, 880, 220], { text: '{{detail}}', size: 48, weight: 400, fit: 'shrink', maxLines: 4, lineHeight: 1.3, color: '#ccfbf1' }),
      { id: 'button-bg', name: 'Button background', type: 'rect', x: 100, y: 1500, w: 520, h: 120, radius: 60, fill: '#ffffff' },
      text('button', 'Button', [100, 1500, 520, 120], { text: '{{button}}', size: 44, weight: 800, align: 'center', valign: 'middle', color: '#134e4a', maxLines: 1, fit: 'shrink' }),
    ],
  },
};

const video: Starter = {
  key: 'video',
  name: 'Video thumbnail',
  description: 'A loud headline and a badge for a YouTube thumbnail.',
  doc: {
    v: 1,
    width: 1280,
    height: 720,
    background: '#facc15',
    fields: [field('title', 'Headline', 'I rebuilt it in a weekend', 60), field('badge', 'Badge', 'EP 12', 12), colour('ink', 'Text colour', '#111827')],
    layers: [
      { id: 'slab', name: 'Dark panel', type: 'rect', x: 860, y: 0, w: 420, h: 720, fill: '{{ink}}' },
      { id: 'badge-bg', name: 'Badge background', type: 'ellipse', x: 930, y: 220, w: 280, h: 280, fill: '#facc15' },
      text('badge', 'Badge', [950, 220, 240, 280], { text: '{{badge}}', size: 72, weight: 800, align: 'center', valign: 'middle', color: '{{ink}}', maxLines: 2, fit: 'shrink', upper: true }),
      text('title', 'Headline', [70, 70, 740, 580], { text: '{{title}}', size: 136, minSize: 70, weight: 800, fit: 'shrink', maxLines: 4, lineHeight: 0.98, valign: 'middle', color: '{{ink}}', upper: true }),
    ],
  },
};

const linkedin: Starter = {
  key: 'linkedin',
  name: 'LinkedIn post',
  description: 'A clean white card with a colour band and a company line.',
  doc: {
    v: 1,
    width: 1200,
    height: 627,
    background: '#ffffff',
    fields: [field('kicker', 'Small heading', 'Case study', 40), field('title', 'Title', 'What 1,000 support tickets taught us about onboarding', 140), field('company', 'Company', 'Example Co', 60), colour('brand', 'Brand colour', '#1d4ed8')],
    layers: [
      { id: 'band', name: 'Colour band', type: 'rect', x: 0, y: 0, w: 28, h: 627, fill: '{{brand}}' },
      text('kicker', 'Small heading', [100, 90, 1000, 40], { text: '{{kicker}}', size: 28, weight: 600, upper: true, letterSpacing: 0.1, color: '{{brand}}', maxLines: 1 }),
      text('title', 'Title', [100, 150, 1000, 310], { text: '{{title}}', size: 72, minSize: 40, weight: 800, fit: 'shrink', maxLines: 4, lineHeight: 1.12, color: '#0f172a' }),
      { id: 'mark', name: 'Company mark', type: 'rect', x: 100, y: 506, w: 44, h: 44, radius: 10, fill: '{{brand}}' },
      text('company', 'Company', [164, 506, 900, 44], { text: '{{company}}', size: 30, weight: 600, valign: 'middle', color: '#334155', maxLines: 1 }),
    ],
  },
};

const changelog: Starter = {
  key: 'changelog',
  name: 'Changelog card',
  description: 'A version number, what changed and the date.',
  doc: {
    v: 1,
    width: 1200,
    height: 630,
    background: '#09090b',
    fields: [field('version', 'Version', 'v2.4.0', 16), field('title', 'What changed', 'Dark mode, faster search and CSV export', 120), field('date', 'Date', '12 June 2026', 40), colour('accent', 'Accent colour', '#a3e635')],
    layers: [
      { id: 'pill', name: 'Version background', type: 'rect', x: 80, y: 90, w: 220, h: 64, radius: 14, fill: '#18181b', stroke: '{{accent}}', strokeWidth: 2 },
      text('version', 'Version', [80, 90, 220, 64], { text: '{{version}}', font: 'jetbrains-mono', size: 30, weight: 500, align: 'center', valign: 'middle', color: '{{accent}}', maxLines: 1, fit: 'shrink' }),
      text('title', 'What changed', [80, 200, 1040, 270], { text: '{{title}}', size: 78, minSize: 42, weight: 800, fit: 'shrink', maxLines: 3, lineHeight: 1.1, color: '#fafafa' }),
      text('date', 'Date', [80, 510, 1040, 40], { text: '{{date}}', font: 'jetbrains-mono', size: 26, weight: 500, color: '#a1a1aa', maxLines: 1 }),
    ],
  },
};

const product: Starter = {
  key: 'product',
  name: 'Product card',
  description: 'A picture on the left, name and price on the right.',
  doc: {
    v: 1,
    width: 1200,
    height: 630,
    background: '#fafaf9',
    fields: [
      { name: 'photo', label: 'Picture', type: 'image', default: '' },
      field('name', 'Product name', 'Field notebook, set of three', 80),
      field('price', 'Price', '$18', 16),
      field('note', 'Small print', 'Free shipping over $40', 60),
    ],
    layers: [
      { id: 'photo', name: 'Picture', type: 'image', x: 60, y: 60, w: 510, h: 510, src: '{{photo}}', fit: 'cover', radius: 24 },
      text('name', 'Product name', [630, 110, 510, 240], { text: '{{name}}', font: 'libre-baskerville', size: 58, minSize: 34, weight: 700, fit: 'shrink', maxLines: 4, lineHeight: 1.15, color: '#1c1917' }),
      text('price', 'Price', [630, 380, 510, 100], { text: '{{price}}', size: 84, weight: 800, valign: 'middle', color: '#b45309', maxLines: 1, fit: 'shrink' }),
      text('note', 'Small print', [630, 506, 510, 40], { text: '{{note}}', size: 26, weight: 400, color: '#78716c', maxLines: 1 }),
    ],
  },
};

export const STARTERS: Starter[] = [blog, launch, xCard, linkedin, changelog, product, quote, story, video];

export function starterByKey(key: string): Starter | undefined {
  return STARTERS.find((starter) => starter.key === key);
}
