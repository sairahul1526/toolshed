/**
 * Signatures as the Standard Webhooks spec describes them (https://www.standardwebhooks.com):
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`, keyed with the
 * base64-decoded part of the secret after `whsec_`. Several signatures may be listed, separated by
 * spaces, which is how a rotated secret and its predecessor both sign for a day.
 *
 * `signPayload` and `verifySignature` use Web Crypto only, so the same code runs in a Worker, in
 * Node and in a receiver's own service (docs/webhooks.md shows it).
 */
import { constantTimeEqual, randomBytes } from '../keys/encoding';

const SECRET_PREFIX = 'whsec_';
/** How far a timestamp may be from the receiver's clock, in seconds, unless told otherwise. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A new signing secret: `whsec_` and the base64 of 24 random bytes. */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${toBase64(randomBytes(24))}`;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const raw = fromBase64(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret);
  if (!raw || raw.length === 0) throw new Error('The signing secret is not valid');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** `v1,<signature>` for one message. `timestampSec` is whole seconds since 1970. */
export async function signPayload(secret: string, id: string, timestampSec: number, body: string): Promise<string> {
  return `v1,${toBase64(await hmac(secret, `${id}.${timestampSec}.${body}`))}`;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(' ') : (value ?? null);
  }
  return null;
}

/**
 * True when `webhook-signature` holds a valid `v1` signature of `body` for this secret and the
 * timestamp is within `toleranceSec` of now (default 5 minutes). The comparison is constant time.
 * `body` must be the raw text received, not a parsed and re-encoded copy.
 */
export async function verifySignature(
  secret: string,
  headers: HeaderSource,
  body: string,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<boolean> {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return false;
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > tolerance) return false;

  let expected: Uint8Array;
  try {
    expected = await hmac(secret, `${id}.${timestamp}.${body}`);
  } catch {
    return false;
  }
  let matched = false;
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',');
    const bytes = version === 'v1' && value ? fromBase64(value) : null;
    // Check every candidate so the time taken does not say which one matched.
    if (bytes && constantTimeEqual(bytes, expected)) matched = true;
  }
  return matched;
}
