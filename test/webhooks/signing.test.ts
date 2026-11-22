import { describe, expect, it } from 'vitest';
import { generateSecret, signPayload, verifySignature } from '../../src/core/webhooks/signing';

// The example published with the Standard Webhooks specification.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TIMESTAMP = 1614265330;
const BODY = '{"test": 2432232314}';
const SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
const NOW = TIMESTAMP * 1000;

const headers = (signature = SIGNATURE) => ({ 'webhook-id': ID, 'webhook-timestamp': String(TIMESTAMP), 'webhook-signature': signature });

describe('signPayload', () => {
  it('matches the published Standard Webhooks vector', async () => {
    expect(await signPayload(SECRET, ID, TIMESTAMP, BODY)).toBe(SIGNATURE);
  });

  it('changes when the id, time, body or secret changes', async () => {
    const base = await signPayload(SECRET, ID, TIMESTAMP, BODY);
    expect(await signPayload(SECRET, 'msg_other', TIMESTAMP, BODY)).not.toBe(base);
    expect(await signPayload(SECRET, ID, TIMESTAMP + 1, BODY)).not.toBe(base);
    expect(await signPayload(SECRET, ID, TIMESTAMP, `${BODY} `)).not.toBe(base);
    expect(await signPayload(generateSecret(), ID, TIMESTAMP, BODY)).not.toBe(base);
  });
});

describe('generateSecret', () => {
  it('is whsec_ and the base64 of 24 random bytes', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(generateSecret()).not.toBe(secret);
  });
});

describe('verifySignature', () => {
  it('accepts the published vector', async () => {
    expect(await verifySignature(SECRET, headers(), BODY, { now: NOW })).toBe(true);
  });

  it('accepts a Headers object and any header name case', async () => {
    const h = new Headers({ 'Webhook-Id': ID, 'WEBHOOK-TIMESTAMP': String(TIMESTAMP), 'webhook-Signature': SIGNATURE });
    expect(await verifySignature(SECRET, h, BODY, { now: NOW })).toBe(true);
    expect(await verifySignature(SECRET, { 'Webhook-Id': ID, 'Webhook-Timestamp': String(TIMESTAMP), 'Webhook-Signature': SIGNATURE }, BODY, { now: NOW })).toBe(true);
  });

  it('rejects a changed body, the wrong secret and a damaged signature', async () => {
    expect(await verifySignature(SECRET, headers(), `${BODY} `, { now: NOW })).toBe(false);
    expect(await verifySignature(generateSecret(), headers(), BODY, { now: NOW })).toBe(false);
    expect(await verifySignature(SECRET, headers('v1,AAAA'), BODY, { now: NOW })).toBe(false);
    expect(await verifySignature(SECRET, headers('v2,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='), BODY, { now: NOW })).toBe(false);
  });

  it('accepts when any one of several space-separated signatures is right', async () => {
    const other = await signPayload(generateSecret(), ID, TIMESTAMP, BODY);
    expect(await verifySignature(SECRET, headers(`${other} ${SIGNATURE}`), BODY, { now: NOW })).toBe(true);
    expect(await verifySignature(SECRET, headers(`${SIGNATURE} ${other}`), BODY, { now: NOW })).toBe(true);
    expect(await verifySignature(SECRET, headers(`${other} ${other}`), BODY, { now: NOW })).toBe(false);
  });

  it('rejects a timestamp outside the tolerance, old or in the future', async () => {
    expect(await verifySignature(SECRET, headers(), BODY, { now: NOW + 301_000 })).toBe(false);
    expect(await verifySignature(SECRET, headers(), BODY, { now: NOW - 301_000 })).toBe(false);
    expect(await verifySignature(SECRET, headers(), BODY, { now: NOW + 299_000 })).toBe(true);
    expect(await verifySignature(SECRET, headers(), BODY, { now: NOW + 3_600_000, toleranceSec: 7200 })).toBe(true);
  });

  it('rejects missing or malformed headers', async () => {
    expect(await verifySignature(SECRET, {}, BODY, { now: NOW })).toBe(false);
    expect(await verifySignature(SECRET, { ...headers(), 'webhook-timestamp': 'soon' }, BODY, { now: NOW })).toBe(false);
    expect(await verifySignature(SECRET, { 'webhook-id': ID, 'webhook-timestamp': String(TIMESTAMP) }, BODY, { now: NOW })).toBe(false);
  });
});
