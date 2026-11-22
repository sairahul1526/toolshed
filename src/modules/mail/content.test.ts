import { describe, expect, it } from 'vitest';
import { mergeHtml, mergeMarkdown, mergeText, valuesFor, findTags } from './merge';
import { renderMail } from './render';
import { sanitizeHtml } from './sanitize';
import { compileFilter, parseFilter } from './segments';
import { querySubscribers, joinList } from './subscribers';
import { fixture, T0, DAY } from './testkit';

const brand = { name: 'Acme', logoUrl: null, accent: '#2563eb', footer: '' } as never;
const footer = { listName: 'The Weekly', postalAddress: '1 Example Street', unsubscribeUrl: 'http://localhost/n/u/x' };

describe('merge tags', () => {
  const values = valuesFor({ email: 'sam@example.com', name: 'Sam Rivera', fields: { plan: 'pro', company: '<b>Evil</b>' } }, { list_name: 'The Weekly', unsubscribe_url: 'http://localhost/n/u/x' });

  it('fills first name, uses fallbacks and leaves nothing blank', () => {
    expect(mergeText('Hi {{first_name|friend}}', values)).toBe('Hi Sam');
    const anon = valuesFor({ email: 'a@example.com', name: '', fields: {} }, { list_name: 'L', unsubscribe_url: '#' });
    expect(mergeText('Hi {{first_name|friend}}', anon)).toBe('Hi friend');
    expect(mergeText('Hi {{ first_name }}!', anon)).toBe('Hi !');
  });

  it('escapes values in HTML so a field cannot inject markup', () => {
    expect(mergeHtml('<p>{{company}}</p>', values)).toBe('<p>&lt;b&gt;Evil&lt;/b&gt;</p>');
  });

  it('escapes values in Markdown so a name cannot add links or headings', () => {
    const v = valuesFor({ email: 'a@example.com', name: '[click](https://evil.example) # hi', fields: {} }, { list_name: 'L', unsubscribe_url: '#' });
    const out = mergeMarkdown('Hello {{name}}', v);
    const html = renderMail({ format: 'markdown', subject: 's', preheader: '', body: 'Hello {{name}}' }, { brand, values: v, footer }).html;
    expect(out).not.toContain('](https://evil');
    expect(html).not.toContain('href="https://evil.example"');
  });

  it('finds the tags a body uses, so unknown ones can be flagged', () => {
    expect(findTags('Hi {{first_name|x}} {{ nope }} {{plan}}').map((t) => t.name)).toEqual(['first_name', 'nope', 'plan']);
  });
});

describe('email rendering', () => {
  const v = valuesFor({ email: 'a@example.com', name: 'Ada', fields: {} }, { list_name: 'The Weekly', unsubscribe_url: 'http://localhost/n/u/x' });

  it('renders Markdown with a button, and always includes the footer and postal address', () => {
    const r = renderMail({ format: 'markdown', subject: 'Hi {{first_name}}', preheader: 'p', body: '# Title\n\nHello **{{first_name}}**\n\n::button[Read](https://example.com/x)' }, { brand, values: v, footer });
    expect(r.subject).toBe('Hi Ada');
    expect(r.html).toContain('<h1');
    expect(r.html).toContain('Read</a>');
    expect(r.html).toContain('1 Example Street');
    expect(r.html).toContain('http://localhost/n/u/x');
    expect(r.text).toContain('Unsubscribe: http://localhost/n/u/x');
  });

  it('strips scripts, event handlers and javascript links from raw HTML', () => {
    const dirty = '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">go</a><img src="x" onerror="y()"><a href="https://example.com">ok</a>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(clean).toContain('https://example.com');
  });
});

describe('segments', () => {
  it('filters by tag, field, name, age and match mode, with values bound not pasted', async () => {
    const f = await fixture();
    const base = { base: 'http://localhost', sender: f.sender };
    await joinList(f.ctx, f.list, { email: 'a@example.com', name: 'Ada', tags: ['vip'], fields: { plan: 'pro' }, confirmed: true }, { ...base, now: T0 - 40 * DAY });
    await joinList(f.ctx, f.list, { email: 'b@example.com', name: '', tags: ['beta'], fields: { plan: 'free' }, confirmed: true }, { ...base, now: T0 - 2 * DAY });
    await joinList(f.ctx, f.list, { email: 'c@example.com', name: 'Cy', tags: ['vip', 'beta'], fields: { plan: 'pro' }, confirmed: true }, { ...base, now: T0 - DAY });
    const run = async (raw: unknown) => (await querySubscribers(f.ctx, { listId: f.list.id, segment: parseFilter(raw) }, T0)).items.map((i) => i.email).sort();

    expect(await run({ match: 'all', rules: [{ type: 'tag', op: 'has', value: 'vip' }, { type: 'field', key: 'plan', op: 'is', value: 'pro' }] })).toEqual(['a@example.com', 'c@example.com']);
    expect(await run({ match: 'any', rules: [{ type: 'tag', op: 'has', value: 'beta' }, { type: 'name', op: 'set' }] })).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(await run({ match: 'all', rules: [{ type: 'tag', op: 'not', value: 'vip' }] })).toEqual(['b@example.com']);
    expect(await run({ match: 'all', rules: [{ type: 'joined_days', op: 'within', value: 7 }] })).toEqual(['b@example.com', 'c@example.com']);
    expect(await run({ match: 'all', rules: [{ type: 'name', op: 'empty' }] })).toEqual(['b@example.com']);
    expect(await run({ rules: [] })).toHaveLength(3);

    const hostile = compileFilter(parseFilter({ match: 'all', rules: [{ type: 'email', op: 'contains', value: "'; DROP TABLE mail_subscribers; --" }] }), T0);
    expect(hostile.sql).not.toContain('DROP');
    expect(hostile.params.some((p) => /drop table/i.test(String(p)))).toBe(true);
    expect(await run({ rules: [{ type: 'email', op: 'contains', value: "'; DROP TABLE mail_subscribers; --" }] })).toEqual([]);
    expect(() => parseFilter({ rules: [{ type: 'bogus' }] })).toThrow();
  });
});
