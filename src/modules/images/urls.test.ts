import { describe, expect, it } from 'vitest';
import { starterByKey } from './starters';
import { imagesTestEnv } from './test-support';
import { canonicalQuery, checkSignature, clampWidth, describeQuery, imageUrl, normaliseValues, renderHash } from './urls';

const doc = starterByKey('blog')!.doc;
const BASE = 'https://app.example.com';

describe('signed image URLs', () => {
  it('accepts a URL it signed, whatever order the parameters arrive in', async () => {
    const { env } = imagesTestEnv();
    const url = new URL(await imageUrl(env, BASE, 'blog-card', 'svg', { values: { title: 'Hello', site: 'a.example.com' }, width: 600, version: 2 }));
    expect(url.pathname).toBe('/i/blog-card.svg');
    expect(await checkSignature(env, 'blog-card', url.searchParams)).toBe('ok');
    const shuffled = new URLSearchParams([...url.searchParams].reverse());
    expect(await checkSignature(env, 'blog-card', shuffled)).toBe('ok');
  });

  it('refuses a changed value, an added parameter and another template', async () => {
    const { env } = imagesTestEnv();
    const url = new URL(await imageUrl(env, BASE, 'blog-card', 'svg', { values: { title: 'Hello' } }));
    const changed = new URLSearchParams(url.searchParams);
    changed.set('title', 'Hacked');
    expect(await checkSignature(env, 'blog-card', changed)).toBe('bad');
    const added = new URLSearchParams(url.searchParams);
    added.set('w', '2400');
    expect(await checkSignature(env, 'blog-card', added)).toBe('bad');
    expect(await checkSignature(env, 'other-card', url.searchParams)).toBe('bad');
  });

  it('says when there is no signature at all', async () => {
    const { env } = imagesTestEnv();
    const url = new URL(await imageUrl(env, BASE, 'blog-card', 'png', { values: { title: 'Hello' }, unsigned: true }));
    expect(url.search).toBe('?title=Hello');
    expect(await checkSignature(env, 'blog-card', url.searchParams)).toBe('missing');
  });

  it('does not accept a signature made with another secret', async () => {
    const one = imagesTestEnv();
    const two = imagesTestEnv({ AUTH_SECRET: 'another-secret-another-secret-another-secret-9876' });
    const url = new URL(await imageUrl(one.env, BASE, 'blog-card', 'svg', { values: { title: 'Hello' } }));
    expect(await checkSignature(two.env, 'blog-card', url.searchParams)).toBe('bad');
  });

  it('signs the first copy of a repeated parameter and escapes separators', () => {
    expect(canonicalQuery('s', new URLSearchParams('b=2&a=1&a=9&sig=x'))).toBe('s?a=1&b=2');
    expect(canonicalQuery('s', new URLSearchParams([['a', '1&b=2']]))).toBe('s?a=1%26b%3D2');
  });
});

describe('cache keys', () => {
  it('is the same for the same picture and different for anything that changes it', async () => {
    const base = await renderHash('imgt_1', 1, 'svg', 1200, { title: 'A', site: 'B' });
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(await renderHash('imgt_1', 1, 'svg', 1200, { site: 'B', title: 'A' })).toBe(base);
    expect(await renderHash('imgt_1', 2, 'svg', 1200, { title: 'A', site: 'B' })).not.toBe(base);
    expect(await renderHash('imgt_1', 1, 'png', 1200, { title: 'A', site: 'B' })).not.toBe(base);
    expect(await renderHash('imgt_1', 1, 'svg', 600, { title: 'A', site: 'B' })).not.toBe(base);
    expect(await renderHash('imgt_2', 1, 'svg', 1200, { title: 'A', site: 'B' })).not.toBe(base);
    expect(await renderHash('imgt_1', 1, 'svg', 1200, { title: 'A', site: 'C' })).not.toBe(base);
  });

  it('cannot be confused by values that contain the separator', async () => {
    expect(await renderHash('imgt_1', 1, 'svg', 1200, { title: 'A","site":"B' })).not.toBe(await renderHash('imgt_1', 1, 'svg', 1200, { title: 'A', site: 'B' }));
  });
});

describe('field values', () => {
  it('keeps only the template’s fields and drops values equal to the default', () => {
    const values = normaliseValues(doc, { title: 'Hello', site: 'example.com', debug: '1', sig: 'x' });
    expect(values).toEqual({ title: 'Hello' });
  });

  it('cuts text to the field’s length without splitting an emoji', () => {
    const long = '😀'.repeat(200);
    const { title } = normaliseValues(doc, { title: long });
    expect(Array.from(title!)).toHaveLength(140);
    expect(title!.endsWith('😀')).toBe(true);
  });

  it('ignores a colour that is not a hex colour', () => {
    expect(normaliseValues(doc, { accent: 'url(javascript:alert(1))' })).toEqual({});
    expect(normaliseValues(doc, { accent: '#FF0000' })).toEqual({ accent: '#ff0000' });
  });

  it('lets only a signed URL point a picture at another site', () => {
    const withPhoto = { ...doc, fields: [...doc.fields, { name: 'photo', type: 'image' as const, default: '' }] };
    expect(normaliseValues(withPhoto, { photo: 'https://cdn.example.com/a.png' })).toEqual({ photo: 'https://cdn.example.com/a.png' });
    expect(normaliseValues(withPhoto, { photo: 'https://cdn.example.com/a.png' }, { remotePictures: false })).toEqual({});
    expect(normaliseValues(withPhoto, { photo: 'asset:imga_abc123' }, { remotePictures: false })).toEqual({ photo: 'asset:imga_abc123' });
    expect(normaliseValues(withPhoto, { photo: 'http://cdn.example.com/a.png' })).toEqual({});
    expect(normaliseValues(withPhoto, { photo: 'data:image/png;base64,AAAA' })).toEqual({});
  });

  it('keeps the width inside what the module draws', () => {
    expect(clampWidth('600', 1200)).toBe(600);
    expect(clampWidth('99999', 1200)).toBe(2400);
    expect(clampWidth('1', 1200)).toBe(16);
    expect(clampWidth('-5', 1200)).toBe(1200);
    expect(clampWidth('wide', 1200)).toBe(1200);
    expect(clampWidth(undefined, 1200)).toBe(1200);
  });

  it('describes a stored image by its values and width', () => {
    expect(describeQuery({ title: 'Hi there' }, 600, 1200)).toBe('title=Hi+there&w=600');
    expect(describeQuery({}, 1200, 1200)).toBe('');
  });
});
