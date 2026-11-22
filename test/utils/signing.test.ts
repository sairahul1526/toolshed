import { describe, expect, it } from 'vitest';
import { readSignedToken, sign, signedToken, verify } from '../../src/core/signing';
import type { Env } from '../../src/env';

const env = { AUTH_SECRET: 'unit-test-secret-unit-test-secret-0123456789' } as Env;
const otherEnv = { AUTH_SECRET: 'a-different-secret-a-different-secret-9876543210' } as Env;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Change one character in the middle, always to a different one, so the result never equals the input. */
function flipMiddle(text: string): string {
  const at = Math.floor(text.length / 2);
  return `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`;
}

/** The next character in the alphabet: same data bits, different spare bits, so a second spelling of the same bytes. */
function aliasLastChar(text: string): string {
  return `${text.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(text.at(-1)!) + 1]}`;
}

describe('sign and verify', () => {
  it('gives a base64url signature that verifies', async () => {
    const sig = await sign(env, 'unsubscribe', 'user_1');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verify(env, 'unsubscribe', 'user_1', sig)).toBe(true);
  });

  it('is stable for the same input and different for different data', async () => {
    expect(await sign(env, 'p', 'a')).toBe(await sign(env, 'p', 'a'));
    expect(await sign(env, 'p', 'a')).not.toBe(await sign(env, 'p', 'b'));
  });

  it('gives unrelated signatures to different purposes', async () => {
    const a = await sign(env, 'unsubscribe', 'user_1');
    const b = await sign(env, 'confirm', 'user_1');
    expect(a).not.toBe(b);
    expect(await verify(env, 'confirm', 'user_1', a)).toBe(false);
  });

  it('does not verify under another secret', async () => {
    const sig = await sign(env, 'p', 'data');
    expect(await verify(otherEnv, 'p', 'data', sig)).toBe(false);
    expect(await sign(otherEnv, 'p', 'data')).not.toBe(sig);
  });

  it('rejects changed data, changed signatures, wrong lengths and junk', async () => {
    const sig = await sign(env, 'p', 'data');
    expect(await verify(env, 'p', 'data2', sig)).toBe(false);
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await verify(env, 'p', 'data', flipped)).toBe(false);
    expect(await verify(env, 'p', 'data', sig.slice(0, -2))).toBe(false);
    expect(await verify(env, 'p', 'data', '')).toBe(false);
    expect(await verify(env, 'p', 'data', '***not base64***')).toBe(false);
    expect(await verify(env, 'p', 'data', `${sig}=`)).toBe(false);
  });

  it('signs non-Latin text', async () => {
    const sig = await sign(env, 'p', 'こんにちは 🌍');
    expect(await verify(env, 'p', 'こんにちは 🌍', sig)).toBe(true);
  });

  it('refuses a second spelling of a valid signature (non-zero trailing bits)', async () => {
    const sig = await sign(env, 'p', 'data');
    // A 32 byte signature is 43 characters, and the last one carries 2 spare bits that must be zero.
    expect(ALPHABET.indexOf(sig.at(-1)!) % 4).toBe(0);
    for (let step = 1; step < 4; step++) {
      const alias = `${sig.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(sig.at(-1)!) + step]}`;
      expect(await verify(env, 'p', 'data', alias), alias).toBe(false);
    }
    expect(await verify(env, 'p', 'data', flipMiddle(sig))).toBe(false);
    expect(await verify(env, 'p', 'data', sig)).toBe(true);
  });

  it('refuses to sign without AUTH_SECRET', async () => {
    for (const secret of [undefined, '', '   ']) {
      const bare = { AUTH_SECRET: secret } as unknown as Env;
      await expect(sign(bare, 'p', 'x')).rejects.toThrow('AUTH_SECRET is not set');
      await expect(verify(bare, 'p', 'x', 'abc')).rejects.toThrow('AUTH_SECRET is not set');
    }
  });

  it('refuses a secret shorter than 32 characters, the same rule the JWT keystore uses', async () => {
    for (const secret of ['short', 'x'.repeat(31), `${' '.repeat(10)}${'x'.repeat(31)}${' '.repeat(10)}`]) {
      const weak = { AUTH_SECRET: secret } as Env;
      await expect(sign(weak, 'p', 'x'), secret).rejects.toThrow('AUTH_SECRET is too short');
      await expect(verify(weak, 'p', 'x', 'abc'), secret).rejects.toThrow('at least 32 characters');
      await expect(signedToken(weak, 'p', { a: 1 }), secret).rejects.toThrow('AUTH_SECRET is too short');
    }
    const exactly32 = { AUTH_SECRET: 'x'.repeat(32) } as Env;
    expect(await verify(exactly32, 'p', 'x', await sign(exactly32, 'p', 'x'))).toBe(true);
  });
});

describe('signed tokens', () => {
  it('round trips a payload', async () => {
    const token = await signedToken(env, 'confirm', { email: 'ada@example.com', n: 3, nested: { ok: true } });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await readSignedToken(env, 'confirm', token)).toEqual({ email: 'ada@example.com', n: 3, nested: { ok: true } });
  });

  it('keeps non-Latin text intact', async () => {
    const token = await signedToken(env, 'confirm', { name: '山田 太郎 🌍' });
    expect(await readSignedToken<{ name: string }>(env, 'confirm', token)).toEqual({ name: '山田 太郎 🌍' });
  });

  it('puts exp in the payload when given a lifetime, and refuses it afterwards', async () => {
    const before = Date.now();
    const token = await signedToken(env, 'confirm', { id: 1 }, 60);
    const payload = await readSignedToken<{ id: number; exp: number }>(env, 'confirm', token, before);
    expect(payload?.id).toBe(1);
    expect(payload!.exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(payload!.exp).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(await readSignedToken(env, 'confirm', token, payload!.exp - 1)).not.toBeNull();
    expect(await readSignedToken(env, 'confirm', token, payload!.exp)).toBeNull();
    expect(await readSignedToken(env, 'confirm', token, payload!.exp + 1)).toBeNull();
  });

  it('never expires without a lifetime', async () => {
    const token = await signedToken(env, 'confirm', { id: 1 });
    expect(await readSignedToken(env, 'confirm', token, Date.now() + 10 * 365 * 24 * 3600 * 1000)).toEqual({ id: 1 });
  });

  it('lets the lifetime win over an exp already in the payload', async () => {
    const token = await signedToken(env, 'confirm', { exp: 1 }, 60);
    expect(await readSignedToken(env, 'confirm', token)).not.toBeNull();
  });

  it('returns null for another purpose or another secret', async () => {
    const token = await signedToken(env, 'confirm', { id: 1 });
    expect(await readSignedToken(env, 'unsubscribe', token)).toBeNull();
    expect(await readSignedToken(otherEnv, 'confirm', token)).toBeNull();
  });

  it('returns null for a changed payload or signature', async () => {
    const token = await signedToken(env, 'confirm', { id: 1, admin: false });
    const [body, sig] = token.split('.') as [string, string];
    const forged = btoa(JSON.stringify({ id: 1, admin: true })).replace(/=+$/, '');
    expect(await readSignedToken(env, 'confirm', `${forged}.${sig}`)).toBeNull();
    expect(await readSignedToken(env, 'confirm', `${body}.${flipMiddle(sig)}`)).toBeNull();
    expect(await readSignedToken(env, 'confirm', token)).toEqual({ id: 1, admin: false });
  });

  it('returns null for a token whose signature has a non-canonical last character', async () => {
    const token = await signedToken(env, 'confirm', { id: 1 });
    const [body, sig] = token.split('.') as [string, string];
    expect(await readSignedToken(env, 'confirm', `${body}.${aliasLastChar(sig)}`)).toBeNull();
  });

  it('returns null for malformed tokens', async () => {
    const token = await signedToken(env, 'confirm', { id: 1 });
    for (const bad of ['', '.', 'abc', 'a.b.c', `${token}.extra`, `.${token.split('.')[1]}`, `${token.split('.')[0]}.`, '%%%.%%%']) {
      expect(await readSignedToken(env, 'confirm', bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('returns null when a validly signed body is not a JSON object', async () => {
    for (const body of ['"text"', '[1,2]', 'null', '42', 'not json']) {
      const encoded = btoa(body).replace(/=+$/, '');
      const token = `${encoded}.${await sign(env, 'confirm', encoded)}`;
      expect(await readSignedToken(env, 'confirm', token), body).toBeNull();
    }
  });

  it('returns null when exp is not a number', async () => {
    const encoded = btoa(JSON.stringify({ exp: 'never' })).replace(/=+$/, '');
    const token = `${encoded}.${await sign(env, 'confirm', encoded)}`;
    expect(await readSignedToken(env, 'confirm', token)).toBeNull();
  });

  it('refuses to make or read tokens without AUTH_SECRET', async () => {
    const bare = {} as Env;
    await expect(signedToken(bare, 'p', { a: 1 })).rejects.toThrow('AUTH_SECRET is not set');
    await expect(readSignedToken(bare, 'p', 'a.b')).rejects.toThrow('AUTH_SECRET is not set');
  });
});
