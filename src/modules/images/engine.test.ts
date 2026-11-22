import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { buildCatalog, encodeRanges, parseFont } from '../../../public/m/images/engine/index.js';
import { orgDb } from '../../core/db';
import { drawTemplate } from './render';
import { blankDoc, docSchema, type TemplateDoc, type TemplateLayer } from './schema';
import { sha256Hex } from './sniff';
import { STARTERS } from './starters';
import { imagesTestEnv } from './test-support';

const t = imagesTestEnv();
const db = orgDb(t.env.DB, t.org.id);

type TextLayer = Extract<TemplateLayer, { type: 'text' }>;

function textDoc(text: string, layer: Partial<TextLayer> = {}): TemplateDoc {
  const doc = blankDoc(1200, 630);
  doc.fields = [{ name: 'title', type: 'text', default: text, maxLength: 2000 }];
  doc.layers = [{ id: 'title', type: 'text', text: '{{title}}', x: 100, y: 100, w: 600, h: 400, size: 60, weight: 800, color: '#111111', ...layer }];
  return docSchema.parse(doc);
}

const drawDoc = (doc: TemplateDoc, values: Record<string, string> = {}) => drawTemplate(t.env, db, doc, values, { allowedHosts: [] });
/** Each line of one font is one positioned group. */
const lineCount = (svg: string) => svg.split('<g transform="translate(').length - 1;
const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe('bundled fonts', () => {
  test('the catalog lists exactly what each font file can draw', async () => {
    const catalog = buildCatalog();
    const files = [...catalog.families.flatMap((family) => family.faces.flatMap((face) => face.files)), catalog.emoji!];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const font = parseFont(await readFile(`public/m/images/fonts/${file.key}`));
      expect(encodeRanges(font.coverage()), file.key).toBe(file.ranges);
    }
  });

  test('refuses font formats it cannot read, with a reason', () => {
    const woff = new Uint8Array(64);
    woff.set([0x77, 0x4f, 0x46, 0x32]);
    expect(() => parseFont(woff)).toThrowError(expect.objectContaining({ code: 'font_is_woff' }));
    expect(() => parseFont(new Uint8Array(8))).toThrowError(expect.objectContaining({ code: 'font_unreadable' }));
  });
});

describe('text layout', () => {
  test('wraps at spaces to the width of the box', async () => {
    const out = await drawDoc(textDoc('One two three four five six seven eight nine ten'));
    expect(lineCount(out.svg)).toBeGreaterThan(2);
    expect(out.warnings).toEqual([]);
    expect(out.sizes.title).toBe(60);
  });

  test('keeps explicit line breaks', async () => {
    const out = await drawDoc(textDoc('One\nTwo\r\nThree'));
    expect(lineCount(out.svg)).toBe(3);
  });

  test('splits a word that is wider than the box instead of running out of it', async () => {
    const out = await drawDoc(textDoc('Pneumonoultramicroscopicsilicovolcanoconiosis', { w: 300, size: 40 }));
    expect(lineCount(out.svg)).toBeGreaterThan(1);
    expect(codes(out.warnings)).toEqual([]);
  });

  test('shrinks the text until it fits, but never under the smallest size', async () => {
    const long = 'A long headline that would never fit this box at the size the designer first picked for it';
    const fits = await drawDoc(textDoc(long, { fit: 'shrink', minSize: 20, maxLines: 3, h: 200 }));
    expect(fits.sizes.title).toBeLessThan(60);
    expect(fits.sizes.title).toBeGreaterThanOrEqual(20);
    expect(lineCount(fits.svg)).toBeLessThanOrEqual(3);
    expect(codes(fits.warnings)).toEqual([]);

    const tooLong = await drawDoc(textDoc(long.repeat(6), { fit: 'shrink', minSize: 40, maxLines: 2, h: 200 }));
    expect(tooLong.sizes.title).toBe(40);
    expect(codes(tooLong.warnings)).toEqual(['text_cut']);
  });

  test('cuts to the line limit and ends with an ellipsis', async () => {
    const font = parseFont(await readFile('public/m/images/fonts/inter/inter-800-latin.ttf'));
    const out = await drawDoc(textDoc('One two three four five six seven eight nine ten eleven twelve', { maxLines: 2 }));
    expect(lineCount(out.svg)).toBe(2);
    expect(codes(out.warnings)).toEqual(['text_cut']);
    expect(out.svg).toContain(`id="g0_${font.glyphIndex(0x2026)}"`);
  });

  test('draws emoji from the emoji font, in the text colour', async () => {
    const out = await drawDoc(textDoc('Launch day 🚀'));
    expect(out.warnings).toEqual([]);
    expect(out.svg).toContain('id="g1_');
  });

  test('draws Cyrillic, Greek and Vietnamese from the script files', async () => {
    const out = await drawDoc(textDoc('Привет мир. Γειά σου κόσμε. Xin chào thế giới.'));
    expect(out.warnings).toEqual([]);
  });

  test('says which characters no font could draw, instead of leaving silent boxes', async () => {
    const out = await drawDoc(textDoc('Hello 你好'));
    expect(out.warnings).toEqual([{ layer: 'title', code: 'missing_glyphs', detail: '你好' }]);
  });

  test('flags scripts that need shaping or right-to-left order', async () => {
    const out = await drawDoc(textDoc('مرحبا'));
    expect(codes(out.warnings)).toContain('complex_script');
  });

  test('uses the nearest weight and falls back to the default family for an unknown font', async () => {
    const known = await drawDoc(textDoc('Same', { weight: 700 }));
    const unknown = await drawDoc(textDoc('Same', { weight: 700, font: 'no-such-font' }));
    expect(unknown.svg).toBe(known.svg);
    expect((await drawDoc(textDoc('Same', { weight: 400 }))).svg).not.toBe(known.svg);
  });
});

describe('fields', () => {
  test('text is drawn as shapes, so markup in a value cannot end up in the file', async () => {
    const out = await drawDoc(textDoc('x'), { title: '<script>alert(1)</script>"&' });
    expect(out.svg).not.toMatch(/<script|alert|&quot;|onload/);
    expect(out.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">')).toBe(true);
  });

  test('a colour that is not a colour falls back to the default', async () => {
    const doc = textDoc('x');
    doc.fields.push({ name: 'accent', type: 'color', default: '#ff0000' });
    doc.background = '{{accent}}';
    const good = await drawDoc(docSchema.parse(doc), { accent: '#00ff0080' });
    expect(good.svg).toContain('fill="#00ff00" fill-opacity="0.5"');
    const bad = await drawDoc(docSchema.parse(doc), { accent: 'url(#x)" onload="alert(1)' });
    expect(bad.svg).toContain('<rect width="1200" height="630" fill="#ff0000"/>');
  });

  test('a value longer than the field allows is cut', async () => {
    const doc = textDoc('x', { w: 1000, h: 500, size: 20 });
    doc.fields[0]!.maxLength = 5;
    const out = await drawDoc(doc, { title: 'abcdefghij' });
    expect(out.svg.split('<use ').length - 1).toBe(5);
  });

  test('a picture that cannot be loaded leaves a marked box and a warning', async () => {
    const doc = textDoc('x');
    doc.layers.push({ id: 'pic', type: 'image', src: 'asset:imga_missing0000', x: 0, y: 0, w: 100, h: 100 });
    const out = await drawDoc(docSchema.parse(doc));
    expect(out.warnings).toEqual([{ layer: 'pic', code: 'image_missing', detail: 'asset:imga_missing0000' }]);
    expect(out.svg).toContain('fill="#d4d4d8"');
  });

  test('scales the output without changing the drawing', async () => {
    const out = await drawTemplate(t.env, db, textDoc('Hello'), {}, { allowedHosts: [], width: 600 });
    expect(out.svg).toContain('width="600" height="315" viewBox="0 0 1200 630"');
  });
});

describe('starter templates', () => {
  test.each(STARTERS)('$key draws the same picture as before', async (starter) => {
    const doc = docSchema.parse(starter.doc);
    const out = await drawDoc(doc);
    expect(out.warnings).toEqual([]);
    // The glyph outlines are long and never read by a person, so they are pinned by a hash.
    const [defs = ''] = /<defs>.*<\/defs>/.exec(out.svg) ?? [];
    expect({ bytes: out.svg.length, outlines: (await sha256Hex(defs)).slice(0, 16), sizes: out.sizes, drawing: out.svg.replace(defs, '') }).toMatchSnapshot();
  });
});
