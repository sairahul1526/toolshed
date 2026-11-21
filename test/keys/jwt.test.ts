import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors';
import {
  getJwks,
  getSigningKeyStatus,
  KEY_ROTATE_AFTER_MS,
  rotateSigningKey,
  signEmbedToken,
  signJwt,
  TOKEN_TTL_SECONDS,
  verifyEmbedToken,
  verifyJwt,
} from '../../src/core/jwt';
import type { Env } from '../../src/env';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { auditRows, coldInstance, DAY, MINUTE, ORG_A, ORG_B, SECOND, T0, tableRows } from './helpers';

interface SigningRow {
  kid: string;
  alg: string;
  public_jwk: string;
  private_enc: string | null;
  created_at: number;
  retired_at: number | null;
}

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const S0 = T0 / 1000;
const bytes = (text: string) => new TextEncoder().encode(text);
const b64u = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');
const json = (value: unknown) => b64u(JSON.stringify(value));
const unjson = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

function split(token: string) {
  const [h, p, s] = token.split('.') as [string, string, string];
  return { h, p, s, header: unjson(h), payload: unjson(p) };
}

async function signWith(key: CryptoKey, header: unknown, payload: unknown): Promise<string> {
  const input = `${json(header)}.${json(payload)}`;
  return `${input}.${b64u(new Uint8Array(await crypto.subtle.sign(ES256, key, bytes(input))))}`;
}

const newPair = async () => (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;

/**
 * Put a public key we hold the private half of among the install's keys. Tokens signed with it
 * pass the signature check, so each test below fails on the one claim it bends and nothing else.
 */
async function plantKey(t: TestEnv, kid = 'planted') {
  const pair = await newPair();
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  t.sqlite
    .prepare("INSERT INTO jwt_signing_keys (kid, alg, public_jwk, private_enc, created_at) VALUES (?, 'ES256', ?, NULL, ?)")
    .run(kid, JSON.stringify({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' }), T0);
  return (payload: unknown, header: Record<string, unknown> = {}) => signWith(pair.privateKey, { alg: 'ES256', typ: 'JWT', kid, ...header }, payload);
}

/** A well-formed access token payload. Pass `undefined` for a claim to leave it out. */
const payloadWith = (over: Record<string, unknown> = {}) => ({
  sub: 'usr_1',
  org: ORG_A,
  role: 'member',
  scopes: ['links:read'],
  kind: 'user',
  iss: 'http://localhost',
  aud: 'toolshed',
  iat: S0,
  exp: S0 + 900,
  jti: 'jti_1',
  ...over,
});

let t: TestEnv;
const claims = { sub: 'usr_1', orgId: ORG_A, role: 'member', scopes: ['links:read'] } as const;
const sign = (env: Env = t.env, now = T0) => signJwt(env, { ...claims, scopes: [...claims.scopes] }, { now });

beforeEach(() => {
  t = createTestEnv();
});

describe('signJwt and verifyJwt', () => {
  it('round trip a 15 minute token', async () => {
    const { token, expiresAt } = await sign();
    expect(expiresAt).toBe(T0 + 15 * MINUTE);
    expect(TOKEN_TTL_SECONDS).toBe(900);
    expect(await verifyJwt(t.env, token, { now: T0 + SECOND })).toEqual({
      sub: 'usr_1',
      orgId: ORG_A,
      role: 'member',
      scopes: ['links:read'],
      kind: 'user',
      iat: S0,
      exp: S0 + 900,
      iss: 'http://localhost',
      aud: 'toolshed',
      jti: expect.stringMatching(/^[\w-]{22}$/),
    });
    const { header } = split(token);
    const { keys } = await getJwks(t.env, T0);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: keys[0]!.kid });
  });

  it('says when a key made the token, and gives every token its own id', async () => {
    const a = await signJwt(t.env, { ...claims, scopes: ['*'], sub: 'key_1', kind: 'key', role: 'admin' }, { now: T0, ttlSeconds: 60 });
    const b = await sign();
    const read = await verifyJwt(t.env, a.token, { now: T0 });
    expect(read).toMatchObject({ sub: 'key_1', kind: 'key', role: 'admin', scopes: ['*'], exp: S0 + 60 });
    expect(read!.jti).not.toBe((await verifyJwt(t.env, b.token, { now: T0 }))!.jti);
  });

  it('refuses to sign nonsense', async () => {
    const bad: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ role: 'owner' }, {}],
      [{ scopes: ['has space'] }, {}],
      [{ scopes: 'links:read' }, {}],
      [{ scopes: Array.from({ length: 51 }, (_, i) => `links:s${i}`) }, {}],
      [{ sub: '' }, {}],
      [{ orgId: '' }, {}],
      [{}, { ttlSeconds: 0 }],
      [{}, { ttlSeconds: 1.5 }],
      [{}, { ttlSeconds: 24 * 3600 + 1 }],
    ];
    for (const [claim, opts] of bad) {
      await expect(signJwt(t.env, { ...claims, scopes: ['links:read'], ...claim } as never, { now: T0, ...opts }), JSON.stringify([claim, opts])).rejects.toThrow();
    }
    expect(tableRows(t, 'jwt_signing_keys').length).toBeLessThanOrEqual(1);
  });

  it('refuses anything that is not a token', async () => {
    const { token } = await sign();
    for (const bad of ['', 'a.b.c', 'not a token', `${token}.extra`, `${token} `, ` ${token}`, token.replace('.', '..'), 'x'.repeat(9000), 123 as never, null as never]) {
      expect(await verifyJwt(t.env, bad, { now: T0 })).toBeNull();
    }
    expect(await verifyJwt(t.env, `${token}${'A'.repeat(8192)}`, { now: T0 })).toBeNull();
  });
});

describe('a forged token', () => {
  it('fails when the payload is changed', async () => {
    const { token } = await sign();
    const { h, s, payload } = split(token);
    for (const change of [{ role: 'admin' }, { scopes: ['*'] }, { org: ORG_B }, { exp: S0 + 86_400 }, { sub: 'usr_other' }]) {
      expect(await verifyJwt(t.env, `${h}.${json({ ...payload, ...change })}.${s}`, { now: T0 })).toBeNull();
    }
    // The same payload, re-encoded byte for byte, still passes: the check above is not a fluke.
    expect(await verifyJwt(t.env, `${h}.${json(payload)}.${s}`, { now: T0 })).not.toBeNull();
  });

  it('fails when the header is changed', async () => {
    const { token } = await sign();
    const { p, s, header } = split(token);
    expect(await verifyJwt(t.env, `${json({ ...header, extra: 1 })}.${p}.${s}`, { now: T0 })).toBeNull();
  });

  it('fails when the signature is changed, cut short or missing', async () => {
    const { token } = await sign();
    const { h, p, s } = split(token);
    const raw = Buffer.from(s, 'base64url');
    const flipped = Buffer.from(raw);
    flipped[10] = flipped[10]! ^ 0x01;
    const zeros = new Uint8Array(64);
    for (const signature of [b64u(flipped), b64u(raw.subarray(0, 63)), b64u(Buffer.concat([raw, Buffer.from([0])])), b64u(zeros), '', 'AAAA', `${s}=`]) {
      expect(await verifyJwt(t.env, `${h}.${p}.${signature}`, { now: T0 }), signature).toBeNull();
    }
    expect(await verifyJwt(t.env, `${h}.${p}`, { now: T0 })).toBeNull();
  });

  it('fails with alg none, with or without a signature', async () => {
    const { token } = await sign();
    const { p, s, header } = split(token);
    for (const alg of ['none', 'None', 'NONE', 'nOnE', '', null]) {
      const h = json({ ...header, alg });
      for (const forged of [`${h}.${p}.`, `${h}.${p}.${s}`, `${h}.${p}.${b64u(new Uint8Array(64))}`]) {
        expect(await verifyJwt(t.env, forged, { now: T0 })).toBeNull();
      }
    }
    expect(await verifyJwt(t.env, `${json({ typ: 'JWT', kid: header.kid })}.${p}.${s}`, { now: T0 })).toBeNull();
  });

  it('fails when it claims a shared-secret algorithm and signs with the public key', async () => {
    const { token } = await sign();
    const { header, payload } = split(token);
    const [jwk] = (await getJwks(t.env, T0)).keys;
    const forgedPayload = json({ ...payload, role: 'admin', scopes: ['*'] });
    const secrets = [JSON.stringify(jwk), jwk!.x, Buffer.from(jwk!.x, 'base64url'), Buffer.concat([Buffer.from([4]), Buffer.from(jwk!.x, 'base64url'), Buffer.from(jwk!.y, 'base64url')])];
    for (const [alg, hash] of [
      ['HS256', 'sha256'],
      ['HS512', 'sha512'],
    ] as const) {
      for (const secret of secrets) {
        const input = `${json({ ...header, alg })}.${forgedPayload}`;
        // HS512 gives 64 bytes, the same length as a real signature, so only the alg check stops it.
        const mac = createHmac(hash, secret).update(input).digest();
        expect(await verifyJwt(t.env, `${input}.${b64u(mac)}`, { now: T0 })).toBeNull();
      }
    }
    for (const alg of ['ES384', 'ES512', 'RS256', 'PS256', 'EdDSA', 'es256', ['ES256']]) {
      const { p, s } = split(token);
      expect(await verifyJwt(t.env, `${json({ ...header, alg })}.${p}.${s}`, { now: T0 })).toBeNull();
    }
  });

  it('fails when it brings its own key', async () => {
    const { token } = await sign();
    const { header, payload } = split(token);
    const attacker = await newPair();
    const jwk = await crypto.subtle.exportKey('jwk', attacker.publicKey);
    const wanted = { ...payload, role: 'admin', scopes: ['*'] };
    for (const forgedHeader of [
      { ...header, jwk },
      { ...header, jku: 'https://attacker.example.com/jwks.json' },
      { ...header, x5u: 'https://attacker.example.com/cert.pem' },
      { ...header, kid: 'attacker', jwk },
      { alg: 'ES256', typ: 'JWT', jwk },
    ]) {
      expect(await verifyJwt(t.env, await signWith(attacker.privateKey, forgedHeader, wanted), { now: T0 })).toBeNull();
    }
  });

  it('fails with a key id this install never made', async () => {
    const { token } = await sign();
    const { p, s, header } = split(token);
    for (const kid of ['unknown', '', '../../etc/passwd', "x' OR '1'='1", 'k'.repeat(65), 7, null, undefined]) {
      expect(await verifyJwt(t.env, `${json({ ...header, kid })}.${p}.${s}`, { now: T0 })).toBeNull();
    }
  });

  it('fails when another install signed it', async () => {
    const other = createTestEnv();
    const theirs = await signJwt(other.env, { ...claims, scopes: ['*'], role: 'admin' }, { now: T0 });
    expect(await verifyJwt(other.env, theirs.token, { now: T0 })).not.toBeNull();
    await sign();
    expect(await verifyJwt(t.env, theirs.token, { now: T0 })).toBeNull();
    // Even when it names our key id.
    const ourKid = (await getJwks(t.env, T0)).keys[0]!.kid;
    const { p, s, header } = split(theirs.token);
    expect(await verifyJwt(t.env, `${json({ ...header, kid: ourKid })}.${p}.${s}`, { now: T0 })).toBeNull();
  });
});

describe('time', () => {
  it('refuses an expired token, allowing 30 seconds for clocks that disagree', async () => {
    const { token } = await sign();
    expect(await verifyJwt(t.env, token, { now: T0 + 15 * MINUTE - 1 })).not.toBeNull();
    expect(await verifyJwt(t.env, token, { now: T0 + 15 * MINUTE + 30 * SECOND - 1 })).not.toBeNull();
    expect(await verifyJwt(t.env, token, { now: T0 + 15 * MINUTE + 30 * SECOND })).toBeNull();
    expect(await verifyJwt(t.env, token, { now: T0 + DAY })).toBeNull();
  });

  it('refuses a token before its start time', async () => {
    const { token } = await signJwt(t.env, { ...claims, scopes: ['*'] }, { now: T0, notBefore: T0 + 5 * MINUTE });
    expect(split(token).payload.nbf).toBe(S0 + 300);
    expect(await verifyJwt(t.env, token, { now: T0 })).toBeNull();
    expect(await verifyJwt(t.env, token, { now: T0 + 270 * SECOND - 1 })).toBeNull();
    expect(await verifyJwt(t.env, token, { now: T0 + 270 * SECOND })).toMatchObject({ nbf: S0 + 300 });
  });

  it('refuses a token made in the future', async () => {
    const { token } = await sign(t.env, T0 + 10 * MINUTE);
    expect(await verifyJwt(t.env, token, { now: T0 })).toBeNull();
    expect(await verifyJwt(t.env, token, { now: T0 + 10 * MINUTE - 30 * SECOND })).not.toBeNull();
  });
});

describe('issuer and audience', () => {
  it('refuses a token for another address', async () => {
    const { token } = await sign();
    expect(split(token).payload).toMatchObject({ iss: 'http://localhost', aud: 'toolshed' });
    expect(await verifyJwt({ ...t.env, APP_URL: 'https://other.example.com' }, token, { now: T0 })).toBeNull();
    expect(await verifyJwt({ ...t.env, APP_URL: 'https://localhost' }, token, { now: T0 })).toBeNull();
    expect(await verifyJwt({ ...t.env, APP_URL: 'not a url' }, token, { now: T0 })).toBeNull();
    // Only the origin counts, so a path on APP_URL changes nothing.
    expect(await verifyJwt({ ...t.env, APP_URL: 'http://localhost/app/' }, token, { now: T0 })).not.toBeNull();
  });

  it('uses the request’s address only when APP_URL is not set', async () => {
    const bare: Env = { ...t.env };
    delete bare.APP_URL;
    await expect(signJwt(bare, { ...claims, scopes: ['*'] }, { now: T0 })).rejects.toThrow(/issuer/);

    const mine = await signJwt(bare, { ...claims, scopes: ['*'] }, { now: T0, issuer: 'https://tools.example.com/api/v1/token' });
    expect(split(mine.token).payload.iss).toBe('https://tools.example.com');
    expect(await verifyJwt(bare, mine.token, { now: T0, issuer: 'https://tools.example.com' })).not.toBeNull();
    expect(await verifyJwt(bare, mine.token, { now: T0, issuer: 'https://evil.example.com' })).toBeNull();
    expect(await verifyJwt(bare, mine.token, { now: T0 })).toBeNull();

    // With APP_URL set, a request that arrives under another host name changes nothing.
    const real = await sign();
    expect(await verifyJwt(t.env, real.token, { now: T0, issuer: 'https://evil.example.com' })).not.toBeNull();
    const spoofed = await signJwt(bare, { ...claims, scopes: ['*'] }, { now: T0, issuer: 'https://evil.example.com' });
    expect(await verifyJwt(t.env, spoofed.token, { now: T0, issuer: 'https://evil.example.com' })).toBeNull();
  });
});

describe('claims of a correctly signed token', () => {
  it('are each checked', async () => {
    const forge = await plantKey(t);
    expect(await verifyJwt(t.env, await forge(payloadWith()), { now: T0 })).toMatchObject({ sub: 'usr_1', role: 'member' });

    const badPayloads: Record<string, unknown>[] = [
      { aud: 'another-app' },
      { aud: ['toolshed'] },
      { aud: undefined },
      { iss: 'https://other.example.com' },
      { iss: 'http://localhost/' },
      { iss: undefined },
      { exp: undefined },
      { exp: String(S0 + 900) },
      { exp: S0 + 900.5 },
      { exp: S0 },
      { exp: S0 - 1 },
      { exp: S0 + 24 * 3600 + 1 },
      { exp: Number.MAX_SAFE_INTEGER },
      { iat: undefined },
      { iat: -1, exp: 900 },
      { iat: String(S0) },
      { nbf: 'soon' },
      { nbf: S0 + 600 },
      { sub: undefined },
      { sub: '' },
      { sub: 42 },
      { sub: 'x'.repeat(201) },
      { jti: undefined },
      { org: undefined },
      { org: '' },
      { role: 'owner' },
      { role: 'superuser' },
      { role: undefined },
      { scopes: 'links:read' },
      { scopes: ['has space'] },
      { scopes: [1] },
      { scopes: undefined },
      { scopes: Array.from({ length: 51 }, (_, i) => `links:s${i}`) },
      { kind: 'embed' },
      { kind: undefined },
    ];
    for (const change of badPayloads) {
      expect(await verifyJwt(t.env, await forge(payloadWith(change)), { now: T0 }), JSON.stringify(change)).toBeNull();
    }
    for (const notAnObject of [[payloadWith()], 'text', 7, null]) {
      expect(await verifyJwt(t.env, await forge(notAnObject), { now: T0 })).toBeNull();
    }
  });

  it('are refused when the header asks for extensions or another type', async () => {
    const forge = await plantKey(t);
    for (const header of [{ crit: ['exp'] }, { crit: [] }, { typ: 'at+jwt' }, { typ: 'JWS' }, { typ: 1 }]) {
      expect(await verifyJwt(t.env, await forge(payloadWith(), header), { now: T0 }), JSON.stringify(header)).toBeNull();
    }
    // `typ` may be left out.
    expect(await verifyJwt(t.env, await forge(payloadWith(), { typ: undefined }), { now: T0 })).not.toBeNull();
  });
});

describe('the signing key', () => {
  it('is made on first use, and that is written down', async () => {
    expect(await getJwks(t.env, T0)).toEqual({ keys: [] });
    expect(await getSigningKeyStatus(t.env)).toBeNull();
    expect(tableRows(t, 'jwt_signing_keys')).toHaveLength(0);
    expect(t.kv.store.size).toBe(0);

    await sign();
    await sign(t.env, T0 + SECOND);
    const rows = tableRows<SigningRow>(t, 'jwt_signing_keys');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ alg: 'ES256', created_at: T0, retired_at: null });
    expect(await getSigningKeyStatus(t.env)).toEqual({ kid: rows[0]!.kid, createdAt: T0, rotatesAt: T0 + KEY_ROTATE_AFTER_MS });
    const audits = auditRows(t).filter((r) => r.action.startsWith('signing_key.'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'signing_key.created', actor_type: 'system', org_id: null, target_type: 'signing_key', target_id: rows[0]!.kid });
  });

  it('is never stored in clear text', async () => {
    await sign();
    const [row] = tableRows<SigningRow>(t, 'jwt_signing_keys');
    expect(row!.private_enc).toMatch(/^v1\.[\w-]{22}\.[\w-]{16}\.[\w-]+$/);
    expect(Object.keys(JSON.parse(row!.public_jwk) as object).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);

    const [, salt, iv, sealed] = row!.private_enc!.split('.').map((part) => new Uint8Array(Buffer.from(part, 'base64url'))) as [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
    expect(Buffer.from(sealed).toString('latin1')).not.toMatch(/"d"|"kty"|P-256|EC/);

    // It opens with AUTH_SECRET and its own key id, and with nothing else.
    const open = async (secret: string, kid: string) => {
      const material = await crypto.subtle.importKey('raw', bytes(secret), 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: bytes('toolshed:jwt-signing-key:v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: bytes(kid) }, key, sealed);
      return JSON.parse(Buffer.from(plain).toString('utf8')) as JsonWebKey;
    };
    const opened = await open(t.env.AUTH_SECRET, row!.kid);
    expect(opened).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(opened.d).toMatch(/^[\w-]{43}$/);
    await expect(open('another-secret-another-secret-another-secret', row!.kid)).rejects.toThrow();
    await expect(open(t.env.AUTH_SECRET, 'another-kid')).rejects.toThrow();

    const everythingStored = JSON.stringify([tableRows(t, 'jwt_signing_keys'), auditRows(t), [...t.kv.store.values()]]);
    expect(everythingStored).not.toContain(opened.d);
    expect(JSON.stringify(await getJwks(t.env, T0))).not.toContain(opened.d);
  });

  it('needs a real AUTH_SECRET', async () => {
    const weak = createTestEnv({ AUTH_SECRET: 'too-short' });
    const err = await signJwt(weak.env, { ...claims, scopes: ['*'] }, { now: T0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('needs_setup');
    expect(tableRows(weak, 'jwt_signing_keys')).toHaveLength(0);
  });

  it('is replaced when AUTH_SECRET changes, and everything signed before stops', async () => {
    const old = await sign();
    const oldKid = split(old.token).header.kid;
    const restarted: Env = { ...coldInstance(t.env).env, AUTH_SECRET: 'a-new-secret-a-new-secret-a-new-secret-a-new-secret' };

    const fresh = await sign(restarted, T0 + MINUTE);
    const rows = tableRows<SigningRow>(t, 'jwt_signing_keys');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kid).not.toBe(oldKid);
    expect(await verifyJwt(restarted, fresh.token, { now: T0 + MINUTE })).not.toBeNull();
    expect(await verifyJwt(restarted, old.token, { now: T0 + MINUTE })).toBeNull();
    expect(JSON.parse(auditRows(t, 'signing_key.rotated')[0]!.meta!)).toEqual({ revokedOld: true });
  });
});

describe('rotation', () => {
  it('keeps tokens signed before it valid until they expire', async () => {
    const before = await sign();
    const dayLong = await signEmbedToken(t.env, { orgId: ORG_A, module: 'feedback', subject: 'board:1', scopes: ['feedback:vote'], ttlSeconds: 24 * 3600 }, { now: T0 });
    const kid1 = split(before.token).header.kid as string;

    const { kid: kid2 } = await rotateSigningKey(t.env, { now: T0 + MINUTE, actor: { userId: 'usr_owner', label: 'owner@example.com', ip: '203.0.113.7' } });
    expect(kid2).not.toBe(kid1);
    const after = await sign(t.env, T0 + MINUTE);
    expect(split(after.token).header.kid).toBe(kid2);

    expect(await verifyJwt(t.env, before.token, { now: T0 + 2 * MINUTE })).not.toBeNull();
    expect(await verifyJwt(t.env, after.token, { now: T0 + 2 * MINUTE })).not.toBeNull();
    expect((await getJwks(t.env, T0 + 2 * MINUTE)).keys.map((k) => k.kid)).toEqual([kid2, kid1]);

    // The old private key is gone at once. Only its public half is kept.
    const rows = tableRows<SigningRow>(t, 'jwt_signing_keys');
    expect(rows.find((r) => r.kid === kid1)).toMatchObject({ private_enc: null, retired_at: T0 + MINUTE });
    expect(rows.find((r) => r.kid === kid2)).toMatchObject({ retired_at: null });
    expect(rows.find((r) => r.kid === kid2)!.private_enc).toMatch(/^v1\./);

    // The longest-lived token the old key could have signed still passes on its last second.
    expect(await verifyEmbedToken(t.env, dayLong.token, { module: 'feedback' }, { now: T0 + DAY - SECOND })).not.toBeNull();
    expect(await verifyJwt(t.env, before.token, { now: T0 + 16 * MINUTE })).toBeNull();

    expect(auditRows(t, 'signing_key.rotated')[0]).toMatchObject({
      actor_type: 'user',
      actor_id: 'usr_owner',
      actor_label: 'owner@example.com',
      target_id: kid2,
      summary: 'Replaced the token signing key. Tokens signed before now work until they expire',
    });
  });

  it('stops publishing an old key once nothing it signed can still be valid', async () => {
    const before = await sign();
    const kid1 = split(before.token).header.kid as string;
    const { kid: kid2 } = await rotateSigningKey(t.env, { now: T0 + MINUTE });
    expect((await getJwks(t.env, T0 + DAY)).keys.map((k) => k.kid)).toEqual([kid2, kid1]);
    expect((await getJwks(t.env, T0 + DAY + 5 * MINUTE)).keys.map((k) => k.kid)).toEqual([kid2]);

    // The row itself goes at the next rotation.
    const { kid: kid3 } = await rotateSigningKey(t.env, { now: T0 + 2 * DAY });
    expect(tableRows<SigningRow>(t, 'jwt_signing_keys').map((r) => r.kid).sort()).toEqual([kid2, kid3].sort());
  });

  it('can stop every earlier token at once', async () => {
    const before = await sign();
    expect(await verifyJwt(t.env, before.token, { now: T0 })).not.toBeNull();
    const { kid } = await rotateSigningKey(t.env, { now: T0 + SECOND, revokeOld: true });
    expect(await verifyJwt(t.env, before.token, { now: T0 + SECOND })).toBeNull();
    expect(tableRows<SigningRow>(t, 'jwt_signing_keys').map((r) => r.kid)).toEqual([kid]);
    expect((await getJwks(t.env, T0 + SECOND)).keys.map((k) => k.kid)).toEqual([kid]);
    expect(await verifyJwt(t.env, (await sign(t.env, T0 + SECOND)).token, { now: T0 + SECOND })).not.toBeNull();
    expect(auditRows(t, 'signing_key.rotated')[0]!.summary).toBe('Replaced the token signing key. Tokens signed before now stopped working');
  });

  it('happens by itself after 90 days', async () => {
    const first = await sign();
    const stillFirst = await sign(t.env, T0 + 89 * DAY);
    expect(split(stillFirst.token).header.kid).toBe(split(first.token).header.kid);
    expect(auditRows(t, 'signing_key.rotated')).toHaveLength(0);

    const second = await sign(t.env, T0 + 90 * DAY);
    expect(split(second.token).header.kid).not.toBe(split(first.token).header.kid);
    expect(await verifyJwt(t.env, second.token, { now: T0 + 90 * DAY })).not.toBeNull();
    expect(auditRows(t, 'signing_key.rotated')[0]).toMatchObject({ actor_type: 'system', actor_id: null });
    expect(tableRows<SigningRow>(t, 'jwt_signing_keys').filter((r) => r.retired_at === null)).toHaveLength(1);
  });

  it('reaches other Worker instances within a minute', async () => {
    const before = await sign();
    const other = coldInstance(t.env).env;
    expect(await verifyJwt(other, before.token, { now: T0 })).not.toBeNull();

    await rotateSigningKey(t.env, { now: T0 + SECOND, revokeOld: true });
    const after = await sign(t.env, T0 + SECOND);
    // A new key is picked up at once, from the database.
    expect(await verifyJwt(other, after.token, { now: T0 + 2 * SECOND })).not.toBeNull();
    // And a revoked one is dropped in the same step.
    expect(await verifyJwt(other, before.token, { now: T0 + 2 * SECOND })).toBeNull();
  });

  it('lets an instance that saw no new key trust its copy for at most a minute', async () => {
    const before = await sign();
    const other = coldInstance(t.env).env;
    expect(await verifyJwt(other, before.token, { now: T0 })).not.toBeNull();
    await rotateSigningKey(t.env, { now: T0 + SECOND, revokeOld: true });
    expect(await verifyJwt(other, before.token, { now: T0 + 30 * SECOND })).not.toBeNull();
    expect(await verifyJwt(other, before.token, { now: T0 + MINUTE })).toBeNull();
  });
});

describe('checking a token reads no database', () => {
  const unknownKid = (n: number) => `${json({ alg: 'ES256', typ: 'JWT', kid: `unknown-${n}` })}.${json(payloadWith())}.${b64u(new Uint8Array(64).fill(n))}`;

  it('on an instance that has the key in memory', async () => {
    const warm = coldInstance(t.env);
    const { token } = await sign(warm.env);
    const afterSigning = warm.queries();
    for (const now of [T0, T0 + SECOND, T0 + 59 * SECOND]) expect(await verifyJwt(warm.env, token, { now })).not.toBeNull();
    t.kv.store.clear();
    expect(await verifyJwt(warm.env, token, { now: T0 + 59 * SECOND })).not.toBeNull();
    expect(warm.queries()).toBe(afterSigning);
  });

  it('on an instance that has only just started, thanks to KV', async () => {
    const { token } = await sign();
    expect(t.kv.store.size).toBe(1);
    const cold = coldInstance(t.env);
    expect(await verifyJwt(cold.env, token, { now: T0 })).not.toBeNull();
    expect(await getJwks(cold.env, T0)).toEqual(await getJwks(t.env, T0));
    // A minute later the copy is refreshed, again from KV.
    expect(await verifyJwt(cold.env, token, { now: T0 + 5 * MINUTE })).not.toBeNull();
    expect(cold.queries()).toBe(0);
  });

  it('and falls back to one read, then refills KV, when KV is empty', async () => {
    const { token } = await sign();
    t.kv.store.clear();
    const cold = coldInstance(t.env);
    expect(await verifyJwt(cold.env, token, { now: T0 })).not.toBeNull();
    expect(cold.queries()).toBe(1);
    expect(t.kv.store.size).toBe(1);
    expect(await verifyJwt(cold.env, token, { now: T0 + SECOND })).not.toBeNull();
    expect(cold.queries()).toBe(1);
  });

  it('and a flood of made-up key ids costs one read every 10 seconds', async () => {
    const { token } = await sign();
    const cold = coldInstance(t.env);
    expect(await verifyJwt(cold.env, token, { now: T0 })).not.toBeNull();
    for (let n = 1; n <= 20; n++) expect(await verifyJwt(cold.env, unknownKid(n), { now: T0 + SECOND })).toBeNull();
    expect(cold.queries()).toBe(1);
    for (let n = 1; n <= 20; n++) expect(await verifyJwt(cold.env, unknownKid(n), { now: T0 + 12 * SECOND })).toBeNull();
    expect(cold.queries()).toBe(2);
  });

  it('never trusts KV for private keys', async () => {
    await sign();
    const [entry] = [...t.kv.store.values()];
    const stored = JSON.parse(entry!.value) as { keys: { jwk: Record<string, unknown>; until: number | null }[] };
    expect(stored.keys).toHaveLength(1);
    expect(Object.keys(stored.keys[0]!.jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    expect(entry!.expiresAt).not.toBeNull();
  });
});

describe('getJwks', () => {
  it('publishes exactly what a verifier needs', async () => {
    const { token } = await sign();
    const { keys } = await getJwks(t.env, T0);
    expect(keys).toHaveLength(1);
    const jwk = keys[0]!;
    expect(jwk).toEqual({ kty: 'EC', crv: 'P-256', x: expect.stringMatching(/^[\w-]{43}$/), y: expect.stringMatching(/^[\w-]{43}$/), kid: expect.any(String), alg: 'ES256', use: 'sig' });
    // The key id is the RFC 7638 thumbprint, so anyone can recompute it.
    expect(jwk.kid).toBe(createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest('base64url'));

    // Someone with only the JWKS can check a token.
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, EC, false, ['verify']);
    const { h, p, s } = split(token);
    expect(await crypto.subtle.verify(ES256, key, new Uint8Array(Buffer.from(s, 'base64url')), bytes(`${h}.${p}`))).toBe(true);
  });

  it('never makes a key', async () => {
    const cold = coldInstance(t.env);
    expect(await getJwks(cold.env, T0)).toEqual({ keys: [] });
    expect(await getJwks(cold.env, T0 + SECOND)).toEqual({ keys: [] });
    expect(tableRows(t, 'jwt_signing_keys')).toHaveLength(0);
    expect(cold.queries()).toBe(1);
  });
});

describe('embed tokens', () => {
  const input = { orgId: ORG_A, module: 'feedback', subject: 'board:brd_1', scopes: ['feedback:vote'] };

  it('round trip for their own module only', async () => {
    const { token, expiresAt } = await signEmbedToken(t.env, { ...input, ttlSeconds: 3600 }, { now: T0 });
    expect(expiresAt).toBe(T0 + 60 * MINUTE);
    expect(await verifyEmbedToken(t.env, token, { module: 'feedback' }, { now: T0 })).toEqual({
      sub: 'board:brd_1',
      orgId: ORG_A,
      module: 'feedback',
      scopes: ['feedback:vote'],
      iat: S0,
      exp: S0 + 3600,
      jti: expect.any(String),
    });
    expect(await verifyEmbedToken(t.env, token, { module: 'feedback', orgId: ORG_A }, { now: T0 })).not.toBeNull();
    expect(await verifyEmbedToken(t.env, token, { module: 'feedback', orgId: ORG_B }, { now: T0 })).toBeNull();
    expect(await verifyEmbedToken(t.env, token, { module: 'links' }, { now: T0 })).toBeNull();
    expect(await verifyEmbedToken(t.env, token, { module: 'feedback' }, { now: T0 + 60 * MINUTE + 30 * SECOND })).toBeNull();
  });

  it('live 15 minutes unless told otherwise', async () => {
    const { expiresAt } = await signEmbedToken(t.env, input, { now: T0 });
    expect(expiresAt).toBe(T0 + 15 * MINUTE);
  });

  it('are not API tokens, and API tokens are not embed tokens', async () => {
    const embed = await signEmbedToken(t.env, input, { now: T0 });
    expect(await verifyJwt(t.env, embed.token, { now: T0 })).toBeNull();
    const access = await signJwt(t.env, { ...claims, scopes: ['feedback:vote'] }, { now: T0 });
    expect(await verifyEmbedToken(t.env, access.token, { module: 'feedback' }, { now: T0 })).toBeNull();
  });

  it('can only carry named scopes of their own module', async () => {
    for (const change of [
      { scopes: ['links:read'] },
      { scopes: ['feedback:vote', 'links:read'] },
      { scopes: ['feedback:*'] },
      { scopes: ['*'] },
      { scopes: [] },
      { scopes: ['feedbackish'] },
      { module: 'Feedback' },
      { module: '' },
      { subject: '' },
      { orgId: '' },
      { ttlSeconds: 24 * 3600 + 1 },
      { ttlSeconds: 0 },
    ]) {
      await expect(signEmbedToken(t.env, { ...input, ...change }, { now: T0 }), JSON.stringify(change)).rejects.toThrow();
    }
  });

  it('are refused when a forged one names another module’s scopes', async () => {
    const forge = await plantKey(t);
    const embed = (over: Record<string, unknown>) => forge(payloadWith({ kind: 'embed', module: 'feedback', scopes: ['feedback:vote'], role: undefined, ...over }));
    expect(await verifyEmbedToken(t.env, await embed({}), { module: 'feedback' }, { now: T0 })).not.toBeNull();
    for (const change of [{ scopes: ['links:write'] }, { scopes: 'feedback:vote' }, { org: undefined }, { module: 'links' }, { kind: 'user' }]) {
      expect(await verifyEmbedToken(t.env, await embed(change), { module: 'feedback' }, { now: T0 }), JSON.stringify(change)).toBeNull();
    }
  });
});
