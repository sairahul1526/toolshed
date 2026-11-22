/**
 * The render engine's front door. The Worker and the browser both import this file, so a preview
 * in the editor and an image from a URL are drawn by the same code.
 */
import { DEFAULT_FAMILY, EMOJI, FAMILIES } from './catalog.js';
import { plan, render } from './svg.js';

export { FontError, encodeRanges, parseFont } from './font.js';
export { FIELD_PATTERN, fieldValue, isColor, plan, render, usedFields } from './svg.js';
export { DEFAULT_FAMILY, FAMILIES } from './catalog.js';

/**
 * The fonts a render may use: the bundled families plus a workspace's own uploads.
 * A font file is named by a key: a path under the fonts folder, or `asset:<id>` for an upload.
 * @param {{ id: string, name: string, faces: { weight: number, files: { key: string, ranges: string }[] }[] }[]} [custom]
 */
export function buildCatalog(custom = []) {
  const bundled = FAMILIES.map((family) => ({
    id: family.id,
    name: family.name,
    kind: family.kind,
    faces: family.faces.map((face) => ({ weight: face.weight, files: face.files.map((file) => ({ key: file.path, ranges: file.ranges })) })),
  }));
  return {
    families: [...bundled, ...custom.map((family) => ({ ...family, kind: 'custom' }))],
    emoji: { key: EMOJI.path, ranges: EMOJI.ranges },
    fallback: DEFAULT_FAMILY,
  };
}

/**
 * Loads what a template needs, then draws it. `host.font(key)` and `host.image(src)` fetch one
 * font or picture; either may answer null, and the image then says so with a warning.
 * @returns {Promise<{ svg: string, warnings: { layer: string, code: string, detail?: string }[], sizes: Record<string, number> }>}
 */
export async function draw(doc, values, host) {
  const needs = plan(doc, values, host.catalog);
  const fonts = new Map();
  const images = new Map();
  await Promise.all([
    ...needs.fonts.map(async (key) => {
      const font = await host.font(key);
      if (font) fonts.set(key, font);
    }),
    ...needs.images.map(async (src) => {
      const data = await host.image(src);
      if (data) images.set(src, data);
    }),
  ]);
  return render(doc, values, { catalog: host.catalog, fonts, images, width: host.width });
}
