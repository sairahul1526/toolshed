/** A tiny authenticator app for tests: the standard 6-digit, 30-second TOTP (RFC 6238, SHA-1). */
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fromBase32(text: string): Buffer {
  let bits = '';
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`Not base32: ${ch}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The secret inside an `otpauth://` address, as the QR code carries it. */
export function secretFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('No secret in that address.');
  return secret;
}

/** The code an authenticator app would show for `secret` at time `at` (ms). */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}
