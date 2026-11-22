/**
 * A small TrueType reader: metrics, the character map and glyph outlines.
 * It reads just enough to measure text and draw it as SVG paths, so an image looks the same
 * in the Worker, in a browser and in the PNG renderer without any of them loading a font.
 *
 * Not read: hinting, kerning and substitution tables (no ligatures, no shaping), variation data
 * (a variable font is drawn at its default instance) and CFF outlines (most .otf files).
 */

export class FontError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'FontError';
    this.code = code;
  }
}

const MAX_COMPONENT_DEPTH = 8;

function tagAt(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** One decimal at most: quadratic midpoints land on halves, everything else is whole font units. */
function n(value) {
  return String(Math.round(value * 10) / 10);
}

function readTables(view) {
  if (view.byteLength < 12) throw new FontError('font_unreadable', 'This file is too short to be a font.');
  const signature = tagAt(view, 0);
  if (signature === 'wOFF' || signature === 'wOF2') {
    throw new FontError('font_is_woff', 'This is a web font (WOFF). Upload the TrueType (.ttf) file instead.');
  }
  if (signature === 'ttcf') {
    throw new FontError('font_is_collection', 'This file holds several fonts (.ttc). Upload a single .ttf file.');
  }
  const version = view.getUint32(0);
  if (signature !== 'OTTO' && signature !== 'true' && version !== 0x00010000) {
    throw new FontError('font_unreadable', 'This file is not a TrueType or OpenType font.');
  }
  const count = view.getUint16(4);
  if (12 + count * 16 > view.byteLength) throw new FontError('font_unreadable', 'This font file is cut short.');
  /** @type {Record<string, { offset: number, length: number }>} */
  const tables = {};
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > view.byteLength) throw new FontError('font_unreadable', 'This font file is cut short.');
    tables[tagAt(view, at)] = { offset, length };
  }
  return tables;
}

/** Picks the Unicode character map: full range (format 12) first, then the 16-bit one (format 4). */
function readCmap(view, table) {
  const count = view.getUint16(table.offset + 2);
  let best = null;
  let bestScore = 0;
  for (let i = 0; i < count; i++) {
    const at = table.offset + 4 + i * 8;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const offset = table.offset + view.getUint32(at + 4);
    if (offset + 4 > view.byteLength) continue;
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const score = format === 12 ? 2 : format === 4 ? 1 : 0;
    if (score > bestScore) {
      best = { format, offset };
      bestScore = score;
    }
  }
  if (!best) throw new FontError('font_no_unicode', 'This font has no Unicode character map, so text cannot be matched to its glyphs.');

  /** @type {number[]} start, end, glyph-or-delta, rangeOffsetPosition (format 4 only) */
  const groups = [];
  if (best.format === 12) {
    const total = view.getUint32(best.offset + 12);
    for (let i = 0; i < total; i++) {
      const at = best.offset + 16 + i * 12;
      groups.push(view.getUint32(at), view.getUint32(at + 4), view.getUint32(at + 8));
    }
    return {
      size: 3,
      groups,
      /** @param {number} i @param {number} cp */
      glyph: (i, cp) => groups[i + 2] + (cp - groups[i]),
    };
  }
  const segments = view.getUint16(best.offset + 6) / 2;
  const ends = best.offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  for (let i = 0; i < segments; i++) {
    const start = view.getUint16(starts + i * 2);
    const end = view.getUint16(ends + i * 2);
    if (start === 0xffff) continue;
    groups.push(start, end, i);
  }
  return {
    size: 3,
    groups,
    glyph: (i, cp) => {
      const segment = groups[i + 2];
      const delta = view.getInt16(deltas + segment * 2);
      const rangeOffset = view.getUint16(offsets + segment * 2);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const at = offsets + segment * 2 + rangeOffset + (cp - groups[i]) * 2;
      if (at + 2 > view.byteLength) return 0;
      const glyph = view.getUint16(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    },
  };
}

function readName(view, table, wanted) {
  if (!table) return '';
  const count = view.getUint16(table.offset + 2);
  const strings = table.offset + view.getUint16(table.offset + 4);
  let fallback = '';
  for (let i = 0; i < count; i++) {
    const at = table.offset + 6 + i * 12;
    if (view.getUint16(at + 6) !== wanted) continue;
    const platform = view.getUint16(at);
    const length = view.getUint16(at + 8);
    const offset = strings + view.getUint16(at + 10);
    if (offset + length > view.byteLength) continue;
    let text = '';
    if (platform === 3 || platform === 0) {
      for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(offset + j));
      if (text) return text;
    } else if (!fallback) {
      for (let j = 0; j < length; j++) text += String.fromCharCode(view.getUint8(offset + j));
      fallback = text;
    }
  }
  return fallback;
}

/**
 * @param {ArrayBuffer | Uint8Array} source
 */
export function parseFont(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = readTables(view);

  if (!tables.glyf || !tables.loca) {
    if (tables['CFF '] || tables.CFF2) {
      throw new FontError('font_cff_outlines', 'This font stores its shapes as CFF outlines (most .otf files). Upload the TrueType (.ttf) version of the same font.');
    }
    throw new FontError('font_no_outlines', 'This font has no outlines to draw (bitmap and colour-only fonts are not supported).');
  }
  for (const needed of ['head', 'hhea', 'maxp', 'hmtx', 'cmap']) {
    if (!tables[needed]) throw new FontError('font_unreadable', `This font is missing its "${needed}" table.`);
  }

  const unitsPerEm = view.getUint16(tables.head.offset + 18) || 1000;
  const longLoca = view.getInt16(tables.head.offset + 50) === 1;
  const numGlyphs = view.getUint16(tables.maxp.offset + 4);
  const metricCount = view.getUint16(tables.hhea.offset + 34);
  let ascender = view.getInt16(tables.hhea.offset + 4);
  let descender = view.getInt16(tables.hhea.offset + 6);
  let capHeight = 0;
  let weight = 400;
  const os2 = tables['OS/2'];
  if (os2) {
    weight = view.getUint16(os2.offset + 4) || 400;
    if (os2.length >= 90 && view.getUint16(os2.offset) >= 2) capHeight = view.getInt16(os2.offset + 88);
    // Some fonts leave the hhea values empty and only fill the typographic ones.
    if (ascender === 0 && descender === 0 && os2.length >= 72) {
      ascender = view.getInt16(os2.offset + 68);
      descender = view.getInt16(os2.offset + 70);
    }
  }
  if (ascender === 0 && descender === 0) {
    ascender = Math.round(unitsPerEm * 0.8);
    descender = -Math.round(unitsPerEm * 0.2);
  }
  if (!capHeight) capHeight = Math.round(ascender * 0.75);

  const cmap = readCmap(view, tables.cmap);
  const groups = cmap.groups;
  /** @type {Map<number, number>} */
  const glyphCache = new Map();
  /** @type {Map<number, string>} */
  const pathCache = new Map();

  function glyphIndex(cp) {
    const cached = glyphCache.get(cp);
    if (cached !== undefined) return cached;
    let low = 0;
    let high = groups.length / 3 - 1;
    let glyph = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const at = mid * 3;
      if (cp < groups[at]) high = mid - 1;
      else if (cp > groups[at + 1]) low = mid + 1;
      else {
        glyph = cmap.glyph(at, cp);
        break;
      }
    }
    if (glyph >= numGlyphs) glyph = 0;
    glyphCache.set(cp, glyph);
    return glyph;
  }

  function advance(glyph) {
    if (metricCount === 0) return unitsPerEm / 2;
    const index = Math.min(glyph, metricCount - 1);
    return view.getUint16(tables.hmtx.offset + index * 4);
  }

  function glyphRange(glyph) {
    if (glyph < 0 || glyph >= numGlyphs) return null;
    const at = tables.loca.offset + glyph * (longLoca ? 4 : 2);
    const start = longLoca ? view.getUint32(at) : view.getUint16(at) * 2;
    const end = longLoca ? view.getUint32(at + 4) : view.getUint16(at + 2) * 2;
    if (end <= start || end > tables.glyf.length) return null;
    return { start: tables.glyf.offset + start, end: tables.glyf.offset + end };
  }

  /**
   * Contours of one glyph as flat point lists [x, y, onCurve, ...], already moved by `m`
   * (a b c d e f, the usual 2x3 matrix). Composite glyphs gather the contours of their parts.
   */
  function contours(glyph, m, depth, out) {
    const range = glyphRange(glyph);
    if (!range) return;
    const count = view.getInt16(range.start);
    let at = range.start + 10;
    if (count >= 0) {
      const ends = [];
      for (let i = 0; i < count; i++) ends.push(view.getUint16(at + i * 2));
      const points = count ? ends[count - 1] + 1 : 0;
      at += count * 2;
      at += 2 + view.getUint16(at);
      const flags = new Uint8Array(points);
      for (let i = 0; i < points; i++) {
        const flag = view.getUint8(at++);
        flags[i] = flag;
        if (flag & 8) {
          let repeat = view.getUint8(at++);
          while (repeat-- > 0 && i + 1 < points) flags[++i] = flag;
        }
      }
      const xs = new Float64Array(points);
      const ys = new Float64Array(points);
      let value = 0;
      for (let i = 0; i < points; i++) {
        const flag = flags[i];
        if (flag & 2) {
          const d = view.getUint8(at++);
          value += flag & 16 ? d : -d;
        } else if (!(flag & 16)) {
          value += view.getInt16(at);
          at += 2;
        }
        xs[i] = value;
      }
      value = 0;
      for (let i = 0; i < points; i++) {
        const flag = flags[i];
        if (flag & 4) {
          const d = view.getUint8(at++);
          value += flag & 32 ? d : -d;
        } else if (!(flag & 32)) {
          value += view.getInt16(at);
          at += 2;
        }
        ys[i] = value;
      }
      let first = 0;
      for (const end of ends) {
        const contour = [];
        for (let i = first; i <= end && i < points; i++) {
          contour.push(m[0] * xs[i] + m[2] * ys[i] + m[4], m[1] * xs[i] + m[3] * ys[i] + m[5], flags[i] & 1);
        }
        if (contour.length >= 6) out.push(contour);
        first = end + 1;
      }
      return;
    }
    if (depth >= MAX_COMPONENT_DEPTH) return;
    for (;;) {
      if (at + 4 > range.end) return;
      const flags = view.getUint16(at);
      const component = view.getUint16(at + 2);
      at += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 1) {
        if (flags & 2) {
          dx = view.getInt16(at);
          dy = view.getInt16(at + 2);
        }
        at += 4;
      } else {
        if (flags & 2) {
          dx = view.getInt8(at);
          dy = view.getInt8(at + 1);
        }
        at += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & 8) {
        a = d = view.getInt16(at) / 16384;
        at += 2;
      } else if (flags & 0x40) {
        a = view.getInt16(at) / 16384;
        d = view.getInt16(at + 2) / 16384;
        at += 4;
      } else if (flags & 0x80) {
        a = view.getInt16(at) / 16384;
        b = view.getInt16(at + 2) / 16384;
        c = view.getInt16(at + 4) / 16384;
        d = view.getInt16(at + 6) / 16384;
        at += 8;
      }
      contours(
        component,
        [
          m[0] * a + m[2] * b,
          m[1] * a + m[3] * b,
          m[0] * c + m[2] * d,
          m[1] * c + m[3] * d,
          m[0] * dx + m[2] * dy + m[4],
          m[1] * dx + m[3] * dy + m[5],
        ],
        depth + 1,
        out,
      );
      if (!(flags & 0x20)) return;
    }
  }

  /** SVG path data for a glyph in font units, y pointing down (ready to scale, no flip needed). */
  function path(glyph) {
    const cached = pathCache.get(glyph);
    if (cached !== undefined) return cached;
    const list = [];
    try {
      contours(glyph, [1, 0, 0, 1, 0, 0], 0, list);
    } catch {
      // A damaged glyph draws as nothing rather than failing the whole image.
      list.length = 0;
    }
    let d = '';
    for (const contour of list) {
      const total = contour.length / 3;
      const x = (i) => contour[(i % total) * 3];
      const y = (i) => -contour[(i % total) * 3 + 1];
      const on = (i) => contour[(i % total) * 3 + 2] === 1;
      // Start on a point that lies on the curve; when none does, start halfway between two control points.
      let start = 0;
      while (start < total && !on(start)) start++;
      let sx;
      let sy;
      if (start === total) {
        start = 0;
        sx = (x(0) + x(total - 1)) / 2;
        sy = (y(0) + y(total - 1)) / 2;
        d += `M${n(sx)} ${n(sy)}`;
        start = -1;
      } else {
        sx = x(start);
        sy = y(start);
        d += `M${n(sx)} ${n(sy)}`;
      }
      for (let step = 1; step <= total; step++) {
        const i = start + step;
        if (on(i)) {
          d += `L${n(x(i))} ${n(y(i))}`;
          continue;
        }
        const next = i + 1;
        let ex;
        let ey;
        if (step === total) {
          ex = sx;
          ey = sy;
        } else if (on(next)) {
          ex = x(next);
          ey = y(next);
          step++;
        } else {
          ex = (x(i) + x(next)) / 2;
          ey = (y(i) + y(next)) / 2;
        }
        d += `Q${n(x(i))} ${n(y(i))} ${n(ex)} ${n(ey)}`;
      }
      d += 'Z';
    }
    pathCache.set(glyph, d);
    return d;
  }

  /** Every code point the font can draw, as [start, end] pairs. Used to plan which files a text needs. */
  function coverage() {
    /** @type {[number, number][]} */
    const ranges = [];
    for (let i = 0; i < groups.length; i += 3) {
      let open = -1;
      for (let cp = groups[i]; cp <= groups[i + 1]; cp++) {
        const has = cmap.glyph(i, cp) !== 0;
        if (has && open < 0) open = cp;
        if (!has && open >= 0) {
          ranges.push([open, cp - 1]);
          open = -1;
        }
      }
      if (open >= 0) ranges.push([open, groups[i + 1]]);
    }
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return merged;
  }

  return {
    family: readName(view, tables.name, 16) || readName(view, tables.name, 1) || 'Font',
    style: readName(view, tables.name, 17) || readName(view, tables.name, 2) || 'Regular',
    weight,
    variable: Boolean(tables.fvar),
    unitsPerEm,
    ascender,
    descender,
    capHeight,
    numGlyphs,
    glyphIndex,
    advance,
    path,
    coverage,
  };
}

/** "20-7e,a0-ff": the compact form coverage is stored in. */
export function encodeRanges(ranges) {
  return ranges.map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`)).join(',');
}

/** @param {string} text @returns {Int32Array} flat start, end pairs, sorted */
export function decodeRanges(text) {
  if (!text) return new Int32Array(0);
  const parts = text.split(',');
  const out = new Int32Array(parts.length * 2);
  parts.forEach((part, i) => {
    const dash = part.indexOf('-');
    const start = parseInt(dash < 0 ? part : part.slice(0, dash), 16);
    out[i * 2] = start;
    out[i * 2 + 1] = dash < 0 ? start : parseInt(part.slice(dash + 1), 16);
  });
  return out;
}

/** @param {Int32Array} ranges @param {number} cp */
export function inRanges(ranges, cp) {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < ranges[mid * 2]) high = mid - 1;
    else if (cp > ranges[mid * 2 + 1]) low = mid + 1;
    else return true;
  }
  return false;
}
