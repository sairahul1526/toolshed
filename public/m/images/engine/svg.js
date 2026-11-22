/**
 * Turns a template and its values into one self-contained SVG.
 * Text is drawn as outlines and pictures are embedded, so the file needs nothing else to look right:
 * no fonts, no network. The Worker, the editor and the PNG renderer all use this same output.
 */
import { decodeRanges, inRanges } from './font.js';
import { cleanText, codePoints, layoutText } from './layout.js';

export const FIELD_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HARD_TEXT_LIMIT = 2000;
const ELLIPSIS = 0x2026;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** Two decimals, no trailing zeros: short output that is the same on every machine. */
function f(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function num(value, fallback) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isColor(value) {
  return typeof value === 'string' && COLOR.test(value.trim());
}

/** A colour as #rrggbb plus its opacity, because 8-digit hex is not valid in every SVG reader. */
function color(value, fallback) {
  let hex = isColor(value) ? value.trim().slice(1).toLowerCase() : isColor(fallback) ? fallback.slice(1).toLowerCase() : '000000';
  if (hex.length <= 4) hex = hex.replace(/./g, '$&$&');
  const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
  return { hex: `#${hex.slice(0, 6)}`, alpha };
}

function paint(attribute, value, fallback) {
  const c = color(value, fallback);
  return ` ${attribute}="${c.hex}"${c.alpha < 1 ? ` ${attribute}-opacity="${f(c.alpha)}"` : ''}`;
}

function fieldMap(doc) {
  const map = new Map();
  for (const field of doc.fields || []) map.set(field.name, field);
  return map;
}

/** The value of one field: what was passed, else its default. Text is capped, colours are checked. */
export function fieldValue(doc, values, name, fields = fieldMap(doc)) {
  const field = fields.get(name);
  if (!field) return '';
  const given = values ? values[name] : undefined;
  let value = given === undefined || given === null ? field.default ?? '' : String(given);
  if (field.type === 'color') return isColor(value) ? value.trim() : isColor(field.default) ? field.default : '#000000';
  const cap = Math.min(HARD_TEXT_LIMIT, field.maxLength > 0 ? field.maxLength : 500);
  if (value.length > cap) value = Array.from(value).slice(0, cap).join('');
  return value;
}

/** Replaces every {{name}} in a layer property with the field's value. */
export function fill(doc, values, text, fields = fieldMap(doc)) {
  return String(text ?? '').replace(FIELD_PATTERN, (_, name) => fieldValue(doc, values, name, fields));
}

/** Names of the fields a template really uses, in the order they first appear. */
export function usedFields(doc) {
  const seen = new Set();
  for (const layer of doc.layers || []) {
    for (const key of ['text', 'color', 'fill', 'fill2', 'stroke', 'src']) {
      if (typeof layer[key] !== 'string') continue;
      for (const match of layer[key].matchAll(FIELD_PATTERN)) seen.add(match[1]);
    }
  }
  for (const key of ['background', 'background2']) {
    if (typeof doc[key] === 'string') for (const match of doc[key].matchAll(FIELD_PATTERN)) seen.add(match[1]);
  }
  return [...seen];
}

const rangeCache = new WeakMap();
function covers(file, cp) {
  let ranges = rangeCache.get(file);
  if (!ranges) {
    ranges = decodeRanges(file.ranges);
    rangeCache.set(file, ranges);
  }
  return inRanges(ranges, cp);
}

/** The face of a family closest to a weight; ties go to the heavier one, as browsers do for bold. */
export function pickFace(catalog, familyId, weight) {
  const family = catalog.families.find((x) => x.id === familyId) || catalog.families.find((x) => x.id === catalog.fallback) || catalog.families[0];
  if (!family || !family.faces.length) return null;
  const wanted = num(weight, 400);
  let best = family.faces[0];
  for (const face of family.faces) {
    const gap = Math.abs(face.weight - wanted);
    const bestGap = Math.abs(best.weight - wanted);
    if (gap < bestGap || (gap === bestGap && face.weight > best.weight)) best = face;
  }
  return best;
}

/**
 * The font files one text needs, most wanted first: the layer's own family, then the default
 * family for characters it lacks, then emoji.
 */
function fontStack(catalog, layer, text) {
  const own = pickFace(catalog, layer.font, layer.weight);
  const spare = pickFace(catalog, catalog.fallback, layer.weight);
  const ownFiles = own ? own.files : [];
  const spareFiles = spare && spare !== own ? spare.files : [];
  const used = new Set();
  const points = codePoints(text);
  points.push(0x20, ELLIPSIS);
  for (const cp of points) {
    const file = ownFiles.find((x) => covers(x, cp)) || spareFiles.find((x) => covers(x, cp)) || (catalog.emoji && covers(catalog.emoji, cp) ? catalog.emoji : null);
    if (file) used.add(file);
  }
  // The first file of the layer's own face always comes along: it gives the line its metrics.
  if (ownFiles[0]) used.add(ownFiles[0]);
  const ordered = [...ownFiles, ...spareFiles, ...(catalog.emoji ? [catalog.emoji] : [])].filter((x) => used.has(x));
  return ordered.map((x) => x.key);
}

function textOf(doc, values, layer, fields) {
  return cleanText(fill(doc, values, layer.text, fields), Boolean(layer.upper));
}

function visibleLayers(doc) {
  return (doc.layers || []).filter((layer) => layer && !layer.hidden);
}

/** What a render needs loaded before it can run: font files and pictures. */
export function plan(doc, values, catalog) {
  const fields = fieldMap(doc);
  const fonts = new Set();
  const images = new Set();
  for (const layer of visibleLayers(doc)) {
    if (layer.type === 'text') for (const key of fontStack(catalog, layer, textOf(doc, values, layer, fields))) fonts.add(key);
    if (layer.type === 'image') {
      const src = fill(doc, values, layer.src, fields).trim();
      if (src) images.add(src);
    }
  }
  return { fonts: [...fonts], images: [...images] };
}

function gradient(defs, id, from, to, angle) {
  const radians = ((num(angle, 90) - 90) * Math.PI) / 180;
  const dx = Math.cos(radians) / 2;
  const dy = Math.sin(radians) / 2;
  const a = color(from);
  const b = color(to);
  defs.push(
    `<linearGradient id="${id}" x1="${f(0.5 - dx)}" y1="${f(0.5 - dy)}" x2="${f(0.5 + dx)}" y2="${f(0.5 + dy)}">` +
      `<stop offset="0" stop-color="${a.hex}"${a.alpha < 1 ? ` stop-opacity="${f(a.alpha)}"` : ''}/>` +
      `<stop offset="1" stop-color="${b.hex}"${b.alpha < 1 ? ` stop-opacity="${f(b.alpha)}"` : ''}/></linearGradient>`,
  );
  return ` fill="url(#${id})"`;
}

function common(layer) {
  let out = '';
  const opacity = num(layer.opacity, 1);
  if (opacity < 1) out += ` opacity="${f(Math.max(0, opacity))}"`;
  const rotate = num(layer.rotate, 0);
  if (rotate) out += ` transform="rotate(${f(rotate)} ${f(num(layer.x, 0) + num(layer.w, 0) / 2)} ${f(num(layer.y, 0) + num(layer.h, 0) / 2)})"`;
  return out;
}

/**
 * @param {object} doc the template
 * @param {Record<string, string>} values field values by name
 * @param {{ catalog: object, fonts: Map<string, object>, images: Map<string, string>, width?: number }} resources
 * @returns {{ svg: string, warnings: { layer: string, code: string, detail?: string }[], sizes: Record<string, number> }}
 */
export function render(doc, values, resources) {
  const width = Math.max(1, num(doc.width, 1200));
  const height = Math.max(1, num(doc.height, 630));
  const fields = fieldMap(doc);
  const resolve = (text) => fill(doc, values, text, fields).trim();
  const defs = [];
  const glyphs = new Map();
  const fontIds = new Map();
  const warnings = [];
  const sizes = {};
  let body = '';
  let serial = 0;

  const background = resolve(doc.background) || '#ffffff';
  if (doc.background2) body += `<rect width="${f(width)}" height="${f(height)}"${gradient(defs, `d${serial++}`, background, resolve(doc.background2), doc.backgroundAngle)}/>`;
  else body += `<rect width="${f(width)}" height="${f(height)}"${paint('fill', background, '#ffffff')}/>`;

  function shapePaint(layer) {
    let out = '';
    const fillValue = resolve(layer.fill);
    if (layer.fill2 && fillValue) out += gradient(defs, `d${serial++}`, fillValue, resolve(layer.fill2), layer.angle);
    else if (fillValue) out += paint('fill', fillValue);
    else out += ' fill="none"';
    const stroke = resolve(layer.stroke);
    const strokeWidth = num(layer.strokeWidth, 0);
    if (stroke && strokeWidth > 0) out += `${paint('stroke', stroke)} stroke-width="${f(strokeWidth)}"`;
    return out;
  }

  function glyphRef(font, glyph) {
    let fontId = fontIds.get(font);
    if (fontId === undefined) {
      fontId = fontIds.size;
      fontIds.set(font, fontId);
    }
    const id = `g${fontId}_${glyph}`;
    if (!glyphs.has(id)) glyphs.set(id, font.path(glyph));
    return id;
  }

  for (const layer of visibleLayers(doc)) {
    const x = num(layer.x, 0);
    const y = num(layer.y, 0);
    const w = Math.max(0, num(layer.w, 0));
    const h = Math.max(0, num(layer.h, 0));

    if (layer.type === 'rect') {
      const radius = Math.min(Math.max(0, num(layer.radius, 0)), w / 2, h / 2);
      body += `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${radius ? ` rx="${f(radius)}"` : ''}${shapePaint(layer)}${common(layer)}/>`;
    } else if (layer.type === 'ellipse') {
      body += `<ellipse cx="${f(x + w / 2)}" cy="${f(y + h / 2)}" rx="${f(w / 2)}" ry="${f(h / 2)}"${shapePaint(layer)}${common(layer)}/>`;
    } else if (layer.type === 'line') {
      const strokeWidth = Math.max(0.5, num(layer.strokeWidth, 2));
      body += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x + w)}" y2="${f(y + h)}"${paint('stroke', resolve(layer.stroke), '#000000')} stroke-width="${f(strokeWidth)}" stroke-linecap="round"${common(layer)}/>`;
    } else if (layer.type === 'image') {
      const src = resolve(layer.src);
      const data = src ? resources.images.get(src) : undefined;
      const radius = Math.min(Math.max(0, num(layer.radius, 0)), w / 2, h / 2);
      if (!data) {
        // A grey box with a cross says "picture missing" in the image itself, not only in a log.
        if (src) warnings.push({ layer: layer.id, code: 'image_missing', detail: src.slice(0, 200) });
        body += `<g${common(layer)}><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${radius ? ` rx="${f(radius)}"` : ''} fill="#d4d4d8"/><path d="M${f(x)} ${f(y)}L${f(x + w)} ${f(y + h)}M${f(x + w)} ${f(y)}L${f(x)} ${f(y + h)}" stroke="#a1a1aa" stroke-width="2"/></g>`;
        continue;
      }
      let clip = '';
      if (radius || layer.fit !== 'contain') {
        const id = `c${serial++}`;
        defs.push(`<clipPath id="${id}"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${radius ? ` rx="${f(radius)}"` : ''}/></clipPath>`);
        clip = ` clip-path="url(#${id})"`;
      }
      body += `<g${clip}${common(layer)}><image x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" preserveAspectRatio="xMidYMid ${layer.fit === 'contain' ? 'meet' : 'slice'}" href="${esc(data)}"/></g>`;
    } else if (layer.type === 'text') {
      const text = textOf(doc, values, layer, fields);
      if (!text.trim()) continue;
      const stack = fontStack(resources.catalog, layer, text)
        .map((key) => resources.fonts.get(key))
        .filter(Boolean);
      // A family that is not there (an uploaded font that was deleted, say) is drawn in the default
      // family, and the caller is told, so the swap never goes unnoticed.
      const known = !layer.font || resources.catalog.families.some((family) => family.id === layer.font);
      if (!stack.length || !known) warnings.push({ layer: layer.id, code: 'font_missing', detail: String(layer.font || '') });
      if (!stack.length) continue;
      const laid = layoutText(
        text,
        {
          x,
          y,
          w,
          h,
          size: num(layer.size, 48),
          minSize: num(layer.minSize, 0),
          fit: layer.fit,
          maxLines: num(layer.maxLines, 0),
          lineHeight: num(layer.lineHeight, 1.2),
          letterSpacing: num(layer.letterSpacing, 0),
          align: layer.align,
          valign: layer.valign,
        },
        stack,
      );
      sizes[layer.id] = laid.size;
      if (laid.missing.length) warnings.push({ layer: layer.id, code: 'missing_glyphs', detail: String.fromCodePoint(...laid.missing.slice(0, 40)) });
      if (laid.complex) warnings.push({ layer: layer.id, code: 'complex_script' });
      if (laid.cut) warnings.push({ layer: layer.id, code: 'text_cut' });
      let group = '';
      for (const line of laid.lines) {
        for (const run of line.runs) {
          const font = stack[run.font];
          const scale = laid.size / font.unitsPerEm;
          let uses = '';
          for (let i = 0; i < run.glyphs.length; i++) {
            const d = font.path(run.glyphs[i]);
            if (!d) continue;
            uses += `<use href="#${glyphRef(font, run.glyphs[i])}"${run.offsets[i] ? ` x="${f(run.offsets[i])}"` : ''}/>`;
          }
          if (uses) group += `<g transform="translate(${f(run.x)} ${f(line.baseline)}) scale(${String(Math.round(scale * 1e5) / 1e5)})">${uses}</g>`;
        }
      }
      if (group) body += `<g${paint('fill', resolve(layer.color), '#000000')}${common(layer)}>${group}</g>`;
    }
  }

  for (const [id, d] of glyphs) defs.push(`<path id="${id}" d="${d}"/>`);
  const outWidth = resources.width > 0 ? resources.width : width;
  const outHeight = (outWidth * height) / width;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(outWidth)}" height="${f(outHeight)}" viewBox="0 0 ${f(width)} ${f(height)}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body +
    '</svg>';
  return { svg, warnings, sizes };
}
