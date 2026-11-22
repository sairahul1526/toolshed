/**
 * What the editor, the share page and the public generator page share in the browser: drawing a
 * template with the same engine the server uses, and turning the result into a file.
 * Fonts and pictures only ever come from this site.
 */
import { buildCatalog, draw, parseFont } from './engine/index.js';

const ASSET = /^asset:([a-z0-9_]{4,64})$/;
const BUNDLED_FONT = /^[a-z0-9-]+\/[a-z0-9-]+\.ttf$/;
const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

/** Parsed fonts and loaded pictures, kept for the life of the page so typing never refetches them. */
const fonts = new Map();
const pictures = new Map();

function fontAddress(key) {
  const upload = ASSET.exec(key);
  if (upload) return `/i/a/${upload[1]}`;
  return BUNDLED_FONT.test(key) ? `/m/images/fonts/${key}` : null;
}

/** A failed load is forgotten, so a dropped connection does not leave a font missing until reload. */
function once(cache, key, load) {
  let pending = cache.get(key);
  if (!pending) {
    pending = load().catch(() => null);
    cache.set(key, pending);
    pending.then((value) => {
      if (value === null) cache.delete(key);
    });
  }
  return pending;
}

function loadFont(key) {
  const address = fontAddress(key);
  if (!address) return Promise.resolve(null);
  return once(fonts, key, async () => {
    const res = await fetch(address);
    return res.ok ? parseFont(await res.arrayBuffer()) : null;
  });
}

function asDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadPicture(src, addressOf) {
  const upload = ASSET.exec(src);
  const address = upload ? `/i/a/${upload[1]}` : addressOf ? addressOf(src) : null;
  if (!address) return Promise.resolve(null);
  return once(pictures, src, async () => {
    const res = await fetch(address);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_PICTURE_BYTES) return null;
    return asDataUri(blob);
  });
}

/**
 * A drawing surface for one page.
 * @param {{ custom?: object[], picture?: (src: string) => string | null }} [options]
 *   `custom` lists the workspace's uploaded font families. `picture` gives the address on this
 *   site that serves an outside picture, or null when this page may not load it.
 */
export function createStudio({ custom = [], picture } = {}) {
  const catalog = buildCatalog(custom);
  return {
    catalog,
    /** @returns {Promise<{ svg: string, warnings: { layer: string, code: string, detail?: string }[], sizes: Record<string, number> }>} */
    draw(doc, values = {}, width) {
      return draw(doc, values, { catalog, width, font: loadFont, image: (src) => loadPicture(src, picture) });
    },
  };
}

const shown = new WeakMap();

/** Puts an SVG into an <img>, and frees the one it replaces. */
export function showSvg(img, svg) {
  const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const before = shown.get(img);
  img.src = next;
  shown.set(img, next);
  if (before) URL.revokeObjectURL(before);
}

/** Draws an SVG onto a canvas and gives back a PNG file of exactly `width` × `height` pixels. */
export async function svgToPng(svg, width, height) {
  const address = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const picture = new Image();
    picture.src = address;
    await picture.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(picture, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not make a PNG.'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(address);
  }
}

/** Saves a file to the visitor's downloads folder. */
export function download(blob, name) {
  const address = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = address;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(address), 1000);
}

/** Runs `run` once things have been quiet for `ms`. `flush()` runs a waiting call now. */
export function debounce(run, ms) {
  let timer = 0;
  let waiting = false;
  const fire = () => {
    timer = 0;
    waiting = false;
    return run();
  };
  const call = () => {
    waiting = true;
    clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };
  call.flush = () => {
    clearTimeout(timer);
    return waiting ? fire() : undefined;
  };
  return call;
}

const WARNINGS = {
  missing_glyphs: (detail) => `has characters its font cannot draw${detail ? ` (${detail})` : ''}. They are left out.`,
  complex_script: () => 'uses a script that needs letter joining or right-to-left layout, which is not supported yet. It may look wrong.',
  text_cut: () => 'does not fit its box, so the end is cut off with “…”. Make the box larger, lower the size, or allow more lines.',
  image_missing: (detail) => `could not load its picture${detail ? ` (${detail})` : ''}. Pick an uploaded picture, or allow the site in Settings.`,
  font_missing: (detail) => `asks for a font that is not here${detail ? ` (${detail})` : ''}, so Inter is used.`,
};

/** A drawing problem in plain words, starting with the layer it is about. */
export function describeWarning(doc, warning) {
  const layer = (doc.layers || []).find((x) => x.id === warning.layer);
  const name = layer ? layer.name || layer.id : warning.layer;
  const say = WARNINGS[warning.code];
  return `“${name}” ${say ? say(warning.detail) : 'has a problem.'}`;
}

/**
 * One call to this site's API. Answers with the parsed JSON, or throws an Error whose message can
 * be shown to the person as it is; `fields` holds any per-field messages.
 */
export async function call(address, { method = 'GET', json, body, type } = {}) {
  const headers = { accept: 'application/json' };
  if (json !== undefined) headers['content-type'] = 'application/json';
  else if (type) headers['content-type'] = type;
  let res;
  try {
    res = await fetch(address, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch {
    throw new Error('We could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = new Error((data && data.message) || 'That did not work. Try again.');
    problem.fields = (data && data.fields) || {};
    problem.status = res.status;
    throw problem;
  }
  return data;
}
