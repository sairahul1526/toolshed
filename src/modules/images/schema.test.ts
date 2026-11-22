import { describe, expect, test } from 'vitest';
import { blankDoc, docSchema, MAX_LAYERS, PRESETS } from './schema';
import { STARTERS } from './starters';

const issues = (doc: unknown) => {
  const result = docSchema.safeParse(doc);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('template documents', () => {
  test('every preset makes a valid blank template', () => {
    for (const preset of PRESETS) expect(issues(blankDoc(preset.width, preset.height))).toEqual([]);
  });

  test('every starter is valid and uses each of its fields', () => {
    for (const starter of STARTERS) {
      expect(issues(starter.doc), starter.key).toEqual([]);
      const used = JSON.stringify(starter.doc.layers) + starter.doc.background + (starter.doc.background2 ?? '');
      for (const field of starter.doc.fields) expect(used, `${starter.key}.${field.name}`).toContain(`{{${field.name}}}`);
    }
    expect(new Set(STARTERS.map((s) => s.key)).size).toBe(STARTERS.length);
  });

  test('refuses a field name the URL already uses', () => {
    const doc = blankDoc(1200, 630);
    doc.fields[0]!.name = 'sig';
    expect(issues(doc).join('\n')).toContain('used by the image URL itself');
  });

  test('refuses a reference to a field that does not exist', () => {
    const doc = blankDoc(1200, 630);
    doc.fields = [];
    expect(issues(doc)).toEqual(['layers.0.text: This uses {{title}}, but there is no field with that name. Add the field or remove it.']);
  });

  test('refuses oversized canvases, too many layers and outside picture addresses that are not https', () => {
    expect(issues({ ...blankDoc(1200, 630), width: 5000 })[0]).toContain('2400 px wide at most');
    const many = blankDoc(1200, 630);
    many.layers = Array.from({ length: MAX_LAYERS + 1 }, (_, i) => ({ id: `r${i}`, type: 'rect' as const, x: 0, y: 0, w: 10, h: 10, fill: '#000000' }));
    expect(issues(many)[0]).toContain(`${MAX_LAYERS} layers at most`);
    const pic = blankDoc(1200, 630);
    pic.layers.push({ id: 'p', type: 'image', src: 'http://example.com/a.png', x: 0, y: 0, w: 10, h: 10 });
    expect(issues(pic)[0]).toContain('Pick a picture from your assets');
    pic.layers[1] = { id: 'p', type: 'image', src: 'javascript:alert(1)', x: 0, y: 0, w: 10, h: 10 };
    expect(issues(pic)).toHaveLength(1);
  });

  test('refuses anything that is not a plain colour or a single field as paint', () => {
    const doc = blankDoc(1200, 630);
    doc.background = 'url(#a)';
    expect(issues(doc)[0]).toContain('hex colour');
    doc.background = 'red';
    expect(issues(doc)).toHaveLength(1);
  });
});
