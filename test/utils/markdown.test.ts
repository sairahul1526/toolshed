import { describe, expect, it } from 'vitest';
import { excerpt, markdownToText, renderMarkdown } from '../../src/core/markdown';

/** Tags that may appear in output. Anything else is a bug. */
const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input']);

function tags(html: string): { name: string; attrs: string }[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)].map((m) => ({ name: m[1]!.toLowerCase(), attrs: m[2]! }));
}

/** Attribute names in a tag, with the quoted values taken out so text inside a value cannot look like an attribute. */
function attrNames(attrs: string): string[] {
  return [...attrs.replace(/"[^"]*"/g, '').matchAll(/[^\s=/"'<>]+/g)].map((m) => m[0].toLowerCase());
}

/** The rules every output must meet, whatever the input was. */
function expectSafe(html: string) {
  for (const t of tags(html)) {
    expect(ALLOWED_TAGS.has(t.name), `<${t.name}> in ${html}`).toBe(true);
    for (const name of attrNames(t.attrs)) {
      expect(name, `attribute of <${t.name}> in ${html}`).not.toMatch(/^on|^style$|^id$|^srcdoc$/);
    }
  }
  // No tag may start in the middle of text either: every `<` must begin an allowed tag or a closing tag.
  for (const m of html.matchAll(/<(?!\/?(?:[a-z][a-z0-9]*)(?:\s[^<>]*)?\/?>)/g)) {
    expect.unreachable(`stray "<" at ${m.index} in ${html}`);
  }
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const url = m[1]!.replace(/&amp;/g, '&');
    expect(url, `url in ${html}`).not.toMatch(/^\s*(?:javascript|data|vbscript|file):/i);
  }
}

describe('renderMarkdown basics', () => {
  it('renders the usual markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold**, *italic* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n```js\nlet a = 1 < 2;\n```\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code class="language-js">let a = 1 &lt; 2;');
    expectSafe(html);
  });

  it('renders tables and task lists', () => {
    const html = renderMarkdown('| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n');
    expect(html).toContain('<table>');
    expect(html).toContain('align="center"');
    expect(html).toContain('type="checkbox"');
    expectSafe(html);
  });

  it('adds no ids to headings', () => {
    expect(renderMarkdown('## Hello world')).toBe('<h2>Hello world</h2>\n');
  });

  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('', { inline: true })).toBe('');
  });

  it('keeps non-Latin text and emoji', () => {
    expect(renderMarkdown('**こんにちは** 🌍')).toContain('<strong>こんにちは</strong> 🌍');
  });
});

describe('options', () => {
  it('shifts heading levels with headingOffset and stops at h6', () => {
    expect(renderMarkdown('# A\n\n### C', { headingOffset: 1 })).toBe('<h2>A</h2>\n<h4>C</h4>\n');
    expect(renderMarkdown('###### F', { headingOffset: 3 })).toBe('<h6>F</h6>\n');
  });

  it('renders inline only when asked', () => {
    expect(renderMarkdown('Hello **there** [x](https://example.com)\n\nSecond', { inline: true })).not.toContain('<p>');
    expect(renderMarkdown('**hi**', { inline: true })).toBe('<strong>hi</strong>');
    expect(renderMarkdown('# not a heading', { inline: true })).toBe('# not a heading');
  });

  it('cuts the source at maxLength before rendering', () => {
    expect(renderMarkdown('0123456789', { maxLength: 4, inline: true })).toBe('0123');
    expect(renderMarkdown('**bold text**', { maxLength: 6, inline: true })).toBe('**bold text**'.slice(0, 6));
    expect(renderMarkdown('abc', { maxLength: 0 })).toBe('');
  });

  it('does not leave half an emoji when cutting', () => {
    expect(renderMarkdown('ab😀cd', { maxLength: 3, inline: true })).toBe('ab');
  });

  it('is not slowed to a crawl by a big input', () => {
    const start = Date.now();
    renderMarkdown('text *a* [b](https://example.com) `c`\n\n'.repeat(2000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('links', () => {
  it('opens external links safely', () => {
    expect(renderMarkdown('[site](https://example.com/a?b=1&c=2)', { inline: true })).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener nofollow ugc">site</a>',
    );
    expect(renderMarkdown('[mail](mailto:a@example.com)', { inline: true })).toContain('rel="noopener nofollow ugc"');
    expect(renderMarkdown('<https://example.com>', { inline: true })).toContain('target="_blank"');
    expect(renderMarkdown('see https://example.com/x now', { inline: true })).toContain('href="https://example.com/x"');
  });

  it('leaves relative links in the same tab', () => {
    for (const href of ['/pricing', './a', '../b', 'page.html', '#top', '?q=1']) {
      const html = renderMarkdown(`[x](${href})`, { inline: true });
      expect(html, href).toBe(`<a href="${href}">x</a>`);
    }
  });

  it('escapes the title', () => {
    expect(renderMarkdown('[x](/a "say \\"hi\\" <b>")', { inline: true })).toContain('title="say &quot;hi&quot; &lt;b&gt;"');
  });

  it('turns every other scheme into plain text', () => {
    const payloads = [
      '[x](javascript:alert(1))',
      '[x](JavaScript:alert(1))',
      '[x](  javascript:alert(1))',
      '[x](java\tscript:alert(1))',
      '[x](javascript&#58;alert(1))',
      '[x](javascript&colon;alert(1))',
      '[x](&#106;avascript:alert(1))',
      '[x](&#x6A;avascript:alert(1))',
      '[x](jav&#x09;ascript:alert(1))',
      '[x](<javascript:alert(1)>)',
      '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[x](vbscript:msgbox(1))',
      '[x](file:///etc/passwd)',
      '[x](ftp://example.com/a)',
      '[x](tel:+15550100)',
      '[x](//evil.example.com/a)',
      '[x](\\\\evil.example.com/a)',
      '<javascript:alert(1)>',
      '[x][ref]\n\n[ref]: javascript:alert(1)',
      '[![img](https://example.com/a.png)](javascript:alert(1))',
    ];
    for (const src of payloads) {
      const html = renderMarkdown(src);
      expect(html, src).not.toMatch(/href="[^"]*(?:javascript|data:|vbscript|file:|ftp:|tel:|\/\/evil)/i);
      expectSafe(html);
    }
    expect(renderMarkdown('[click](javascript:alert(1))', { inline: true })).toBe('click');
  });

  it('keeps nested markdown in the link text, and never lets it escape the attribute', () => {
    const html = renderMarkdown('[**bold** `code`](https://example.com "t")', { inline: true });
    expect(html).toContain('<strong>bold</strong> <code>code</code></a>');
    const evil = renderMarkdown('[x](https://example.com/"onmouseover="alert(1))', { inline: true });
    expectSafe(evil);
    expect(attrNames(evil.replace(/^<a /, ''))).not.toContain('onmouseover');
    const titled = renderMarkdown('[x](https://example.com "a\\" onmouseover=\\"alert(1)")', { inline: true });
    expectSafe(titled);
    expect(titled).toContain('title="a&quot; onmouseover=&quot;alert(1)"');
  });

  it('escapes HTML inside link text', () => {
    const html = renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com)', { inline: true });
    expect(html).not.toContain('<img');
    expectSafe(html);
  });
});

describe('images', () => {
  it('turns images into links by default', () => {
    const html = renderMarkdown('![A cat](https://example.com/cat.png)', { inline: true });
    expect(html).toBe('<a href="https://example.com/cat.png" target="_blank" rel="noopener nofollow ugc">A cat</a>');
  });

  it('shows http and https images when allowed, lazily loaded', () => {
    const html = renderMarkdown('![A cat](https://example.com/cat.png "Tabby")', { inline: true, allowImages: true });
    expect(html).toBe('<img src="https://example.com/cat.png" alt="A cat" title="Tabby" loading="lazy">');
    expect(renderMarkdown('![x](http://example.com/a.png)', { inline: true, allowImages: true })).toContain('<img src="http://example.com/a.png"');
  });

  it('never shows other kinds of image, even when images are allowed', () => {
    for (const src of ['![x](javascript:alert(1))', '![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)', '![x](/local.png)', '![x](mailto:a@example.com)', '![x](//evil.example.com/a.png)']) {
      const html = renderMarkdown(src, { inline: true, allowImages: true });
      expect(html, src).not.toContain('<img');
      expectSafe(html);
    }
  });

  it('escapes the alt text', () => {
    const html = renderMarkdown('![" onerror="alert(1)](https://example.com/a.png)', { inline: true, allowImages: true });
    expectSafe(html);
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
  });
});

describe('XSS payloads', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC=//evil.example.com/x.js></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '<svg/onload=alert(1)>',
    '<svg><script>alert(1)</script></svg>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href=javascript:alert(1)>x</a>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<style>body{display:none}</style>',
    '<body onload=alert(1)>',
    '<details open ontoggle=alert(1)>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<form action="https://evil.example.com"><input name=pw></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example.com">',
    '<link rel=stylesheet href=https://evil.example.com/x.css>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<base href="https://evil.example.com/">',
    '<!-- comment --><script>alert(1)</script>',
    '<![CDATA[<script>alert(1)</script>]]>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&#60;script&#62;alert(1)&#60;/script&#62;',
    '`<script>alert(1)</script>`',
    '```html\n<script>alert(1)</script>\n```',
    '    <script>alert(1)</script>',
    '**<script>alert(1)</script>**',
    '# <script>alert(1)</script>',
    '- <img src=x onerror=alert(1)>',
    '> <img src=x onerror=alert(1)>',
    '| <script>alert(1)</script> |\n|---|\n| <img src=x onerror=alert(1)> |',
    '<a href="https://example.com" onclick="alert(1)">x</a>',
    '[x](https://example.com)<script>alert(1)</script>',
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<img src=`x` onerror=alert(1)>',
    'text\u0000<script>alert(1)</script>',
    // Marked skips escaping for text that follows a raw-text tag: these must still come out as text.
    '<script><img src=x onerror=alert(1) <b>',
    '<script>"><img src=x onerror=alert(1) <b>',
    '<style><img src=x onerror=alert(1) <b>',
    '<pre><img src=x onerror=alert(1) <b>',
    '<textarea><img src=x onerror=alert(1) <b>',
    'a <script> <svg onload=alert(1) <b> </script> b',
    '<script>\n\n<img src=x onerror=alert(1) <b>\n\n</script>',
  ];

  for (const src of payloads) {
    it(`is harmless: ${JSON.stringify(src).slice(0, 60)}`, () => {
      for (const opts of [{}, { inline: true }, { allowImages: true }, { headingOffset: 2 }]) {
        const html = renderMarkdown(src, opts);
        expectSafe(html);
        expect(html).not.toMatch(/<script/i);
      }
    });
  }

  it('shows raw HTML as text', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(renderMarkdown('hi <b>there</b>', { inline: true })).toBe('hi &lt;b&gt;there&lt;/b&gt;');
  });

  it('escapes quotes and angle brackets in plain text and code', () => {
    expect(renderMarkdown('a < b > "c" & \'d\'', { inline: true })).not.toMatch(/[<>"]/);
    expect(renderMarkdown('`<b>`', { inline: true })).toBe('<code>&lt;b&gt;</code>');
  });

  it('escapes a code fence language', () => {
    const html = renderMarkdown('```"><script>alert(1)</script>\ncode\n```');
    expectSafe(html);
    expect(html).not.toContain('language-"');
  });
});

describe('markdownToText', () => {
  it('drops the markup and keeps the words', () => {
    expect(markdownToText('# Title\n\nSome **bold**, *italic* and `code`.')).toBe('Title\n\nSome bold, italic and code.');
  });

  it('keeps list items on their own lines', () => {
    expect(markdownToText('- one\n- two\n\n1. first\n2. second')).toBe('- one\n- two\n\n1. first\n2. second');
    expect(markdownToText('- a\n  - b\n- c')).toContain('- a\n  - b\n- c');
    expect(markdownToText('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo');
  });

  it('keeps a link address next to its label, unless it is the label', () => {
    expect(markdownToText('[docs](https://example.com/docs)')).toBe('docs (https://example.com/docs)');
    expect(markdownToText('<https://example.com>')).toBe('https://example.com');
    expect(markdownToText('[a@example.com](mailto:a@example.com)')).toBe('a@example.com');
    expect(markdownToText('[x](javascript:alert(1))')).toBe('x');
    expect(markdownToText('[x](/relative)')).toBe('x');
  });

  it('uses alt text for images', () => {
    expect(markdownToText('![A cat](https://example.com/cat.png)')).toBe('A cat');
  });

  it('reads quotes, code blocks and tables', () => {
    expect(markdownToText('> wise words')).toBe('wise words');
    expect(markdownToText('```\nlet a = 1;\n```')).toBe('let a = 1;');
    expect(markdownToText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a | b\n1 | 2');
  });

  it('decodes entities and keeps raw HTML as typed text', () => {
    expect(markdownToText('Fish &amp; chips &lt;3')).toBe('Fish & chips <3');
    expect(markdownToText('<b>hi</b>')).toBe('<b>hi</b>');
  });

  it('keeps line breaks and non-Latin text', () => {
    expect(markdownToText('one  \ntwo')).toBe('one\ntwo');
    expect(markdownToText('**こんにちは** 🌍')).toBe('こんにちは 🌍');
  });

  it('returns an empty string for nothing', () => {
    expect(markdownToText('')).toBe('');
    expect(markdownToText('\n\n  \n')).toBe('');
  });
});

describe('excerpt', () => {
  it('returns short text unchanged, as plain text on one line', () => {
    expect(excerpt('# Hi\n\nthere **you**')).toBe('Hi there you');
  });

  it('cuts at a word boundary and adds an ellipsis', () => {
    const out = excerpt('The quick brown fox jumps over the lazy dog', 20);
    expect(out).toBe('The quick brown fox…');
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('keeps a whole word that ends exactly at the cut', () => {
    expect(excerpt('alpha beta gamma delta', 11)).toBe('alpha beta…');
  });

  it('never goes over the limit, whatever the text', () => {
    const text = 'word '.repeat(200);
    for (const max of [1, 5, 33, 160]) expect(excerpt(text, max).length).toBeLessThanOrEqual(max);
    expect(excerpt('x'.repeat(500), 40)).toBe(`${'x'.repeat(39)}…`);
  });

  it('defaults to 160 characters', () => {
    const out = excerpt('lorem ipsum '.repeat(50));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not end on stray punctuation before the ellipsis', () => {
    expect(excerpt('Hello, brave new world of words', 14)).toBe('Hello, brave…');
  });

  it('does not split an emoji', () => {
    const out = excerpt('😀'.repeat(50), 11);
    expect(out).toBe(`${'😀'.repeat(5)}…`);
  });
});
