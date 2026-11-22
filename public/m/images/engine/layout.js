/**
 * Text layout: picks a font for every character, wraps to a width, cuts to a number of lines
 * with an ellipsis, and can shrink the size until the text fits its box.
 *
 * What it does not do: kerning, ligatures, right-to-left text and the shaping that Arabic and
 * Indic scripts need. Those are reported in `complex` so the caller can say so instead of
 * drawing something subtly wrong without a word.
 */

const ELLIPSIS = 0x2026;
const SPACE = 0x20;
const NEWLINE = 0x0a;

/** Characters that carry no shape of their own here: joiners, variation selectors, skin tones, tags. */
function invisible(cp) {
  return (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0xfeff ||
    cp === 0x00ad ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0000 && cp <= 0xe01ef) ||
    (cp < 0x20 && cp !== NEWLINE)
  );
}

/** Scripts that need shaping or right-to-left ordering, which this engine does not do. */
export function isComplexScript(cp) {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) ||
    (cp >= 0x0900 && cp <= 0x0dff) ||
    (cp >= 0x0e00 && cp <= 0x0eff) ||
    (cp >= 0x0f00 && cp <= 0x109f) ||
    (cp >= 0x1780 && cp <= 0x17ff) ||
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

/** Chinese, Japanese and full-width forms wrap between any two characters. */
function wrapsAnywhere(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x312f) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

function breaksAfter(cp) {
  return cp === 0x2d || cp === 0x2013 || cp === 0x2014 || cp === 0x2f;
}

/** Cleans a value for drawing: one Unicode form, plain spaces, no control characters. */
export function cleanText(raw, upper) {
  let text = String(raw ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\t\u00a0]/g, ' ');
  if (upper) text = text.toUpperCase();
  return text;
}

/** @returns {number[]} the code points that take part in layout */
export function codePoints(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !invisible(cp)) out.push(cp);
  }
  return out;
}

/**
 * @param {string} text already cleaned with cleanText
 * @param {object} opts size, minSize, fit, maxLines, lineHeight, letterSpacing, align, valign, x, y, w, h
 * @param {Array} fonts the font stack: first is the layer's font, the rest are fallbacks
 */
export function layoutText(text, opts, fonts) {
  const primary = fonts[0];
  const letterSpacing = opts.letterSpacing || 0;
  const lineHeight = opts.lineHeight > 0 ? opts.lineHeight : 1.2;
  const maxWidth = opts.w > 0 ? opts.w : Infinity;
  const missing = new Set();
  let complex = false;

  function item(cp) {
    for (let f = 0; f < fonts.length; f++) {
      const glyph = fonts[f].glyphIndex(cp);
      if (glyph !== 0) return { cp, font: f, glyph, em: fonts[f].advance(glyph) / fonts[f].unitsPerEm + letterSpacing };
    }
    if (cp !== SPACE) missing.add(cp);
    // The primary font's "missing" glyph (usually an empty box) keeps the gap visible.
    return { cp, font: 0, glyph: 0, em: (cp === SPACE ? 0.28 : primary.advance(0) / primary.unitsPerEm) + letterSpacing };
  }

  /** Tokens: a word, a run of spaces, or a forced line break. */
  const tokens = [];
  let word = null;
  for (const cp of codePoints(text)) {
    if (isComplexScript(cp)) complex = true;
    if (cp === NEWLINE) {
      word = null;
      tokens.push({ kind: 'break', items: [], em: 0 });
      continue;
    }
    if (cp === SPACE) {
      const last = tokens[tokens.length - 1];
      const space = item(cp);
      if (last && last.kind === 'space' && word === null) {
        last.items.push(space);
        last.em += space.em;
      } else tokens.push({ kind: 'space', items: [space], em: space.em });
      word = null;
      continue;
    }
    const it = item(cp);
    if (word === null || wrapsAnywhere(cp)) {
      word = { kind: 'word', items: [], em: 0 };
      tokens.push(word);
    }
    word.items.push(it);
    word.em += it.em;
    if (breaksAfter(cp) || wrapsAnywhere(cp)) word = null;
  }

  /** Width of a run of items at a size: the trailing letter spacing is not part of the ink. */
  function widthOf(items, size) {
    let em = 0;
    for (const it of items) em += it.em;
    return items.length ? (em - letterSpacing) * size : 0;
  }

  /** @returns {{ lines: object[][], broke: boolean }} `broke` when a word had to be split mid-word */
  function wrap(size) {
    const lines = [[]];
    let line = lines[0];
    let em = 0;
    let broke = false;
    const limit = maxWidth / size;
    const trim = () => {
      while (line.length && line[line.length - 1].cp === SPACE) line.pop();
    };
    const fresh = () => {
      trim();
      line = [];
      lines.push(line);
      em = 0;
    };
    for (const token of tokens) {
      if (token.kind === 'break') {
        fresh();
        continue;
      }
      if (token.kind === 'space') {
        // Spaces at the start of a wrapped line are dropped, as in any text box.
        if (line.length === 0) continue;
        line.push(...token.items);
        em += token.em;
        continue;
      }
      if (em + token.em - letterSpacing <= limit + 1e-6) {
        line.push(...token.items);
        em += token.em;
        continue;
      }
      if (line.length) fresh();
      if (token.em - letterSpacing <= limit + 1e-6) {
        line.push(...token.items);
        em = token.em;
        continue;
      }
      // One word wider than the box: split it wherever the line fills.
      broke = true;
      for (const it of token.items) {
        if (line.length && em + it.em - letterSpacing > limit + 1e-6) fresh();
        line.push(it);
        em += it.em;
      }
    }
    trim();
    return { lines, broke };
  }

  function lineLimit(size) {
    let limit = opts.maxLines > 0 ? opts.maxLines : Infinity;
    if (opts.h > 0) limit = Math.min(limit, Math.max(1, Math.floor((opts.h + 0.5) / (size * lineHeight))));
    return limit;
  }

  let size = opts.size > 0 ? opts.size : 16;
  let wrapped = wrap(size);
  if (opts.fit === 'shrink' && (wrapped.lines.length > lineLimit(size) || wrapped.broke)) {
    const floor = Math.max(4, Math.min(size, opts.minSize > 0 ? opts.minSize : Math.round(size / 2)));
    let low = floor;
    let high = Math.floor(size);
    let best = floor;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const attempt = wrap(mid);
      if (attempt.lines.length <= lineLimit(mid) && !attempt.broke) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    size = best;
    wrapped = wrap(size);
  }

  let lines = wrapped.lines;
  let cut = false;
  const limit = lineLimit(size);
  if (lines.length > limit) {
    cut = true;
    lines = lines.slice(0, limit);
    const last = lines[lines.length - 1];
    const dots = fonts.some((f) => f.glyphIndex(ELLIPSIS) !== 0) ? [item(ELLIPSIS)] : [item(0x2e), item(0x2e), item(0x2e)];
    const dotsWidth = widthOf(dots, size) + letterSpacing * size;
    const closes = (cp) => cp === SPACE || cp === 0x2c || cp === 0x2e || cp === 0x3a || cp === 0x3b || cp === 0x2d;
    while (last.length && (widthOf(last, size) + dotsWidth > maxWidth || closes(last[last.length - 1].cp))) last.pop();
    last.push(...dots);
  }

  const ascent = (primary.ascender / primary.unitsPerEm) * size;
  const descent = (-primary.descender / primary.unitsPerEm) * size;
  const linePx = size * lineHeight;
  const height = lines.length * linePx;
  let top = opts.y || 0;
  if (opts.h > 0 && opts.valign === 'middle') top += (opts.h - height) / 2;
  else if (opts.h > 0 && opts.valign === 'bottom') top += opts.h - height;
  const left = opts.x || 0;
  const boxWidth = opts.w > 0 ? opts.w : 0;

  const placed = lines.map((items, index) => {
    const width = widthOf(items, size);
    let x = left;
    if (opts.align === 'center') x += (boxWidth - width) / 2;
    else if (opts.align === 'right') x += boxWidth - width;
    /** Runs of neighbouring glyphs from the same font share one transform. */
    const runs = [];
    let run = null;
    let pen = x;
    for (const it of items) {
      if (!run || run.font !== it.font) {
        run = { font: it.font, x: pen, glyphs: [], offsets: [] };
        runs.push(run);
      }
      // Offsets are in the run font's own units, so the whole run scales once.
      run.glyphs.push(it.glyph);
      run.offsets.push(((pen - run.x) / size) * fonts[it.font].unitsPerEm);
      pen += it.em * size;
    }
    return { x, width, baseline: top + index * linePx + (linePx - ascent - descent) / 2 + ascent, runs };
  });

  return { size, lines: placed, height, cut, complex, missing: [...missing] };
}
