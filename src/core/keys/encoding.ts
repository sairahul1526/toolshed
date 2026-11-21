/**
 * Small byte and text helpers shared by API keys and tokens. Web Crypto only, so the same code
 * runs in Workers and in Node.
 */

const encoder = new TextEncoder();
// ignoreBOM keeps a leading byte order mark in the text, so JSON with one in front is refused.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type Bytes = Uint8Array<ArrayBuffer>;

export function utf8(text: string): Bytes {
  const encoded = encoder.encode(text);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
}

/** Bytes to text. Returns null when the bytes are not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url (no padding, no other characters). Returns null for anything else. */
export function b64uDecode(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(text: string): Bytes | null {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Compare two byte strings without stopping at the first difference, so the time taken says
 * nothing about how many leading bytes matched.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `length` random characters from 0-9, A-Z, a-z. About 5.95 bits each. */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length - out.length + 8)) {
      // 248 is the largest multiple of 62 that fits in a byte. Dropping the rest keeps every
      // character equally likely.
      if (b >= 248) continue;
      out += BASE62[b % 62]!;
      if (out.length === length) break;
    }
  }
  return out;
}

/** A whole number as base62, left-padded with zeros to `width` characters. */
export function base62Fixed(value: number, width: number): string {
  let n = Math.floor(value);
  let out = '';
  for (let i = 0; i < width; i++) {
    out = BASE62[n % 62]! + out;
    n = Math.floor(n / 62);
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the zip and PNG one) of some ASCII text, as an unsigned 32-bit number. */
export function crc32(text: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < text.length; i++) c = CRC_TABLE[(c ^ text.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
