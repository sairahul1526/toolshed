import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/core/csv';
import { guessColumns, parseCsv, rowsToObjects } from '../../src/core/csv-parse';

describe('parseCsv', () => {
  it('reads headers and rows', () => {
    expect(parseCsv('name,email\nAda,ada@example.com\nGrace,grace@example.com\n')).toEqual({
      headers: ['name', 'email'],
      rows: [
        ['Ada', 'ada@example.com'],
        ['Grace', 'grace@example.com'],
      ],
      truncated: false,
    });
  });

  it('reads CRLF, LF and lone CR line ends', () => {
    for (const eol of ['\r\n', '\n', '\r']) {
      expect(parseCsv(`a,b${eol}1,2${eol}3,4${eol}`).rows, JSON.stringify(eol)).toEqual([['1', '2'], ['3', '4']]);
    }
  });

  it('handles quoted fields, doubled quotes, delimiters and line breaks inside quotes', () => {
    const text = 'name,note\r\n"Ada, Countess","She said ""hi"""\r\n"Two\r\nlines","a\nb"\r\n';
    expect(parseCsv(text).rows).toEqual([
      ['Ada, Countess', 'She said "hi"'],
      ['Two\r\nlines', 'a\nb'],
    ]);
  });

  it('keeps an empty quoted field', () => {
    expect(parseCsv('a,b\n"",x\n').rows).toEqual([['', 'x']]);
  });

  it('copes with a quote that never closes', () => {
    expect(parseCsv('a,b\n1,"oops\nstill going').rows).toEqual([['1', 'oops\nstill going']]);
  });

  it('keeps stray quotes inside an unquoted field', () => {
    expect(parseCsv('a,b\n5" pipe,x').rows).toEqual([['5" pipe', 'x']]);
  });

  it('strips a UTF-8 byte order mark', () => {
    expect(parseCsv('﻿name,email\nAda,a@example.com').headers).toEqual(['name', 'email']);
  });

  it('detects semicolons and tabs from the first line', () => {
    expect(parseCsv('a;b;c\n1;2;3').rows).toEqual([['1', '2', '3']]);
    expect(parseCsv('a\tb\tc\n1\t2\t3').rows).toEqual([['1', '2', '3']]);
    expect(parseCsv('a,b,c\n1;x,2,3').rows).toEqual([['1;x', '2', '3']]);
  });

  it('ignores delimiters inside quotes when detecting', () => {
    expect(parseCsv('"a,b,c";d\n1;2').headers).toEqual(['a,b,c', 'd']);
  });

  it('lets the caller pick the delimiter', () => {
    expect(parseCsv('a|b\n1|2', { delimiter: '|' })).toMatchObject({ headers: ['a', 'b'], rows: [['1', '2']] });
    expect(parseCsv('a,b;c\n1,2;3', { delimiter: ';' }).headers).toEqual(['a,b', 'c']);
  });

  it('falls back to a comma for a single column', () => {
    expect(parseCsv('email\nada@example.com').rows).toEqual([['ada@example.com']]);
  });

  it('ignores blank lines and trailing empty lines', () => {
    expect(parseCsv('a,b\n\n1,2\n\n\n3,4\n\n\n').rows).toEqual([['1', '2'], ['3', '4']]);
    expect(parseCsv('a,b\n1,2\n,\n,\n').rows).toEqual([['1', '2']]);
  });

  it('pads short rows to the header width and keeps long rows whole', () => {
    expect(parseCsv('a,b,c\n1\n1,2\n1,2,3,4').rows).toEqual([['1', '', ''], ['1', '2', ''], ['1', '2', '3', '4']]);
  });

  it('trims header names but not cells', () => {
    expect(parseCsv(' Name , Email \n Ada , x ')).toMatchObject({ headers: ['Name', 'Email'], rows: [[' Ada ', ' x ']] });
  });

  it('handles empty input and a header row alone', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [], truncated: false });
    expect(parseCsv('\n\n')).toEqual({ headers: [], rows: [], truncated: false });
    expect(parseCsv('a,b')).toEqual({ headers: ['a', 'b'], rows: [], truncated: false });
  });

  it('keeps non-Latin text and emoji', () => {
    expect(parseCsv('名前,メール\n山田 太郎,taro@example.com\n🌍,😀').rows).toEqual([['山田 太郎', 'taro@example.com'], ['🌍', '😀']]);
  });

  describe('maxRows', () => {
    const file = (n: number) => `a\n${Array.from({ length: n }, (_, i) => i + 1).join('\n')}\n`;

    it('stops at the limit and says so', () => {
      const out = parseCsv(file(10), { maxRows: 3 });
      expect(out.rows).toEqual([['1'], ['2'], ['3']]);
      expect(out.truncated).toBe(true);
    });

    it('is not truncated when the file fits exactly', () => {
      const out = parseCsv(file(3), { maxRows: 3 });
      expect(out.rows).toHaveLength(3);
      expect(out.truncated).toBe(false);
    });

    it('is not truncated by empty rows after the limit', () => {
      expect(parseCsv('a,b\n1,2\n,\n,\n\n', { maxRows: 1 }).truncated).toBe(false);
    });

    it('does not count the header, and defaults to 50,000 rows', () => {
      expect(parseCsv('a\n1', { maxRows: 1 }).truncated).toBe(false);
      expect(parseCsv('a\n1', { maxRows: 0 }).truncated).toBe(true);
      const big = parseCsv(file(50_001));
      expect(big.rows).toHaveLength(50_000);
      expect(big.truncated).toBe(true);
      expect(parseCsv(file(50_000)).truncated).toBe(false);
    });
  });

  it('reads what toCsv writes, including awkward cells', () => {
    const rows = [
      { name: 'Ada, Countess', note: 'She said "hi"' },
      { name: 'Two\nlines', note: 'tab\there' },
      { name: '山田', note: '' },
    ];
    const parsed = parseCsv(toCsv(rows, { bom: true }));
    expect(rowsToObjects(parsed.headers, parsed.rows)).toEqual(rows);
  });
});

describe('guessColumns', () => {
  const wanted = { email: ['email', 'e-mail', 'email address'], name: ['name', 'full name'], plan: ['plan', 'tier'] };

  it('matches ignoring case and punctuation', () => {
    expect(guessColumns(['Full_Name', 'E-Mail Address', 'Company'], wanted)).toEqual({ email: 1, name: 0, plan: null });
    expect(guessColumns(['EMAIL', 'nAmE'], wanted)).toEqual({ email: 0, name: 1, plan: null });
  });

  it('prefers the earlier alias when several headers match', () => {
    expect(guessColumns(['Full name', 'Name'], wanted).name).toBe(1);
  });

  it('uses each header once', () => {
    const out = guessColumns(['Name'], { first: ['name'], last: ['name'] });
    expect(out).toEqual({ first: 0, last: null });
  });

  it('returns null for every field when nothing matches or there are no headers', () => {
    expect(guessColumns(['foo', 'bar'], wanted)).toEqual({ email: null, name: null, plan: null });
    expect(guessColumns([], wanted)).toEqual({ email: null, name: null, plan: null });
    expect(guessColumns(['a'], {})).toEqual({});
  });

  it('matches non-Latin headers and ignores aliases with no letters', () => {
    expect(guessColumns(['メール', '名前'], { email: ['メール'], name: ['名前'] })).toEqual({ email: 0, name: 1 });
    expect(guessColumns(['---', ''], { x: ['--', ''] })).toEqual({ x: null });
  });
});

describe('rowsToObjects', () => {
  it('keys each row by header', () => {
    expect(rowsToObjects(['a', 'b'], [['1', '2'], ['3', '4']])).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('fills missing cells with empty strings and ignores extra cells', () => {
    expect(rowsToObjects(['a', 'b'], [['1'], ['1', '2', '3']])).toEqual([{ a: '1', b: '' }, { a: '1', b: '2' }]);
  });

  it('keeps the first of a repeated header and skips empty headers', () => {
    expect(rowsToObjects(['a', 'a', '', 'b'], [['1', '2', '3', '4']])).toEqual([{ a: '1', b: '4' }]);
  });

  it('is safe with headers named like object internals', () => {
    const [row] = rowsToObjects(['__proto__', 'constructor', 'toString'], [['x', 'y', 'z']]);
    expect(Object.keys(row!)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('returns nothing for no rows', () => {
    expect(rowsToObjects(['a'], [])).toEqual([]);
  });
});
