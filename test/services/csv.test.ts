import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, toCsv } from '../../src/core/csv';

describe('csvCell', () => {
  it('writes plain text, numbers and empties as they are', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-3.5)).toBe('-3.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes cells with commas, quotes and line breaks, and doubles inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });

  it('keeps non-Latin text and emoji untouched', () => {
    expect(csvCell('こんにちは, 世界')).toBe('"こんにちは, 世界"');
    expect(csvCell('café')).toBe('café');
  });

  it('writes objects as JSON and dates as ISO text', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(new Date(Date.UTC(2026, 10, 21)))).toBe('2026-11-21T00:00:00.000Z');
  });

  it('stops spreadsheet formulas in text cells', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1 555 0100')).toBe("'+1 555 0100");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tTabbed')).toBe("'\tTabbed");
    expect(csvCell('=HYPERLINK("http://example.com","x")')).toBe(`"'=HYPERLINK(""http://example.com"",""x"")"`);
  });

  it('does not touch real numbers, even negative ones', () => {
    expect(csvCell(-5)).toBe('-5');
  });

  it('can switch the guard off', () => {
    expect(csvCell('=A1', { guard: false })).toBe('=A1');
  });
});

describe('csvRow and toCsv', () => {
  it('ends rows with CRLF', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });

  it('writes a header, orders by columns and fills gaps', () => {
    const csv = toCsv([{ name: 'Ana', age: 31 }, { age: 40, name: 'Ben, Jr.' }, { name: 'Cy' }], { columns: ['name', 'age'] });
    expect(csv).toBe('name,age\r\nAna,31\r\n"Ben, Jr.",40\r\nCy,\r\n');
  });

  it('uses the first row keys when no columns are given, and returns nothing for no data', () => {
    expect(toCsv([{ x: 1, y: 2 }])).toBe('x,y\r\n1,2\r\n');
    expect(toCsv([])).toBe('');
  });

  it('adds a byte order mark on request and guards header names', () => {
    expect(toCsv([{ '-x': 1 }], { bom: true })).toBe("﻿'-x\r\n1\r\n");
    expect(toCsv([], { columns: ['a'], bom: true })).toBe('﻿a\r\n');
  });
});
