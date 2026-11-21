import { describe, expect, it } from 'vitest';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { crc32, ZipWriter, zipBytes } from '../../src/core/zip';
import { readZip } from './zipreader';

const enc = new TextEncoder();

describe('crc32', () => {
  it('matches the standard check value and Node', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    const big = new Uint8Array(100_000).map((_, i) => (i * 31 + 7) & 255);
    expect(crc32(big)).toBe(nodeCrc32(big));
  });

  it('can be built up in pieces', () => {
    const a = enc.encode('hello ');
    const b = enc.encode('world');
    expect(crc32(b, crc32(a))).toBe(crc32(enc.encode('hello world')));
  });
});

describe('ZipWriter', () => {
  it('writes entries a strict reader accepts, with right sizes and CRCs', async () => {
    const bytes = await zipBytes([
      { name: 'a.txt', content: 'alpha' },
      { name: 'dir/b.bin', content: new Uint8Array([0, 1, 2, 255]) },
      { name: 'empty.txt', content: '' },
    ]);
    const files = readZip(bytes);
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'dir/b.bin', 'empty.txt']);
    expect(files[0]!.text()).toBe('alpha');
    expect([...files[1]!.data]).toEqual([0, 1, 2, 255]);
    expect(files[2]!.size).toBe(0);
    expect(files.every((f) => (f.flags & 0x800) !== 0 && (f.flags & 0x8) !== 0)).toBe(true);
  });

  it('keeps UTF-8 names and text intact', async () => {
    const files = readZip(await zipBytes([{ name: 'données/日本語.txt', content: 'çà et là — 日本語 😀' }]));
    expect(files[0]!.name).toBe('données/日本語.txt');
    expect(files[0]!.text()).toBe('çà et là — 日本語 😀');
  });

  it('streams a file from an async source without holding it all', async () => {
    const chunks: number[] = [];
    const sink = (c: Uint8Array) => void chunks.push(c.length);
    const zip = new ZipWriter(sink);
    async function* source() {
      for (let i = 0; i < 50; i++) yield `row ${i}\n`;
    }
    await zip.addFile('rows.txt', source());
    await zip.finish();
    expect(chunks.length).toBeGreaterThan(50);
  });

  it('round-trips a streamed file', async () => {
    const parts: Uint8Array[] = [];
    const zip = new ZipWriter((c) => void parts.push(c));
    async function* source() {
      yield 'one,';
      yield new Uint8Array(enc.encode('two,'));
      yield 'three';
    }
    await zip.addFile('x.csv', source());
    await zip.finish();
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    expect(readZip(all)[0]!.text()).toBe('one,two,three');
  });

  it('waits for an async sink and passes its failure on', async () => {
    const zip = new ZipWriter(async () => {
      throw new Error('disk full');
    });
    await expect(zip.addFile('a', 'x')).rejects.toThrow('disk full');
  });

  it('refuses files after finish, and finish twice is harmless', async () => {
    const zip = new ZipWriter(() => {});
    await zip.addFile('a', 'x');
    await zip.finish();
    await zip.finish();
    await expect(zip.addFile('b', 'y')).rejects.toThrow('finished');
  });

  it('stores the modified time as DOS date and time', async () => {
    const bytes = await zipBytes([{ name: 'a', content: 'x' }], new Date(Date.UTC(2026, 10, 21, 13, 14, 16)));
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const time = v.getUint16(10, true);
    const date = v.getUint16(12, true);
    expect([(time >> 11) & 31, (time >> 5) & 63, (time & 31) * 2]).toEqual([13, 14, 16]);
    expect([((date >> 9) & 127) + 1980, (date >> 5) & 15, date & 31]).toEqual([2026, 11, 21]);
  });
});
