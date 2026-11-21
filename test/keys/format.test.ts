import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKey, KEY_PREFIX, parseKey } from '../../src/core/apikeys';
import { b64uDecode, b64uEncode, base62Fixed, constantTimeEqual, crc32, fromHex, fromUtf8, randomBase62, toHex, utf8 } from '../../src/core/keys/encoding';
import { hashKey } from '../../src/core/keys/format';

describe('key format', () => {
  it('is ts_<live|test>_ plus an 8 character id, a 32 character secret and a 6 character checksum', () => {
    const live = generateKey('live');
    const test = generateKey('test');
    expect(KEY_PREFIX).toBe('ts_');
    expect(live.secret).toMatch(/^ts_live_[0-9A-Za-z]{46}$/);
    expect(test.secret).toMatch(/^ts_test_[0-9A-Za-z]{46}$/);
    expect(live.secret).toHaveLength(54);
    expect(live.prefix).toBe(live.secret.slice(0, 16));
    expect(live.prefix).toMatch(/^ts_live_[0-9A-Za-z]{8}$/);
  });

  it('has at least 160 bits in the secret part and never repeats', () => {
    expect(32 * Math.log2(62)).toBeGreaterThanOrEqual(160);
    const seen = new Set(Array.from({ length: 200 }, () => generateKey('live').secret));
    expect(seen.size).toBe(200);
  });

  it('accepts a key it made', () => {
    const key = generateKey('live');
    expect(parseKey(key.secret)).toEqual({ prefix: key.prefix });
  });

  it('refuses a key with any one character changed', () => {
    const { secret } = generateKey('live');
    for (let i = KEY_PREFIX.length; i < secret.length; i++) {
      const swapped = secret[i] === 'A' ? 'B' : 'A';
      const typo = secret.slice(0, i) + swapped + secret.slice(i + 1);
      expect(parseKey(typo), `position ${i}`).toBeNull();
    }
  });

  it('refuses a live key relabelled as a test key', () => {
    const { secret } = generateKey('live');
    expect(parseKey(secret.replace('ts_live_', 'ts_test_'))).toBeNull();
  });

  it('refuses anything that is not shaped like a key', () => {
    const { secret } = generateKey('live');
    const bad = ['', 'garbage', 'ts_', 'ts_live_', secret.slice(0, -1), `${secret}A`, ` ${secret}`, `${secret}\n`, secret.replace('ts_', 'sk_'), secret.toUpperCase(), `Bearer ${secret}`, 'x'.repeat(100_000)];
    for (const value of bad) expect(parseKey(value), JSON.stringify(value.slice(0, 20))).toBeNull();
    expect(parseKey(undefined as unknown as string)).toBeNull();
    expect(parseKey(42 as unknown as string)).toBeNull();
  });

  it('stores a key as its SHA-256', async () => {
    const { secret } = generateKey('test');
    const hash = await hashKey(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(secret).digest('hex'));
  });
});

describe('byte helpers', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });

  it('writes fixed-width base62', () => {
    expect(base62Fixed(0, 6)).toBe('000000');
    expect(base62Fixed(61, 2)).toBe('0z');
    expect(base62Fixed(62, 2)).toBe('10');
    expect(base62Fixed(0xffffffff, 6)).toHaveLength(6);
  });

  it('makes random base62 text of the asked length', () => {
    for (const length of [1, 8, 32, 100]) expect(randomBase62(length)).toMatch(new RegExp(`^[0-9A-Za-z]{${length}}$`));
  });

  it('compares bytes without caring where they differ', () => {
    expect(constantTimeEqual(utf8('same'), utf8('same'))).toBe(true);
    expect(constantTimeEqual(utf8('same'), utf8('sane'))).toBe(false);
    expect(constantTimeEqual(utf8('same'), utf8('samey'))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('round-trips base64url and refuses anything that is not base64url', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = b64uEncode(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(b64uDecode(text)).toEqual(bytes);
    expect(b64uDecode('')).toEqual(new Uint8Array(0));
    for (const bad of ['a', 'ab+c', 'ab/c', 'abc=', 'ab c', 'ab\ncd']) expect(b64uDecode(bad), bad).toBeNull();
  });

  it('round-trips hex and refuses anything that is not lowercase hex', () => {
    expect(fromHex(toHex(new Uint8Array([0, 15, 16, 255])))).toEqual(new Uint8Array([0, 15, 16, 255]));
    for (const bad of ['abc', 'zz', 'AB']) expect(fromHex(bad), bad).toBeNull();
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(fromUtf8(utf8('héllo'))).toBe('héllo');
    expect(fromUtf8(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});
