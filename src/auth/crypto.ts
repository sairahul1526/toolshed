/** Small Web Crypto helpers: keyed hashes for things stored at rest and constant-time checks. */

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** HMAC-SHA256 as unpadded base64url. */
export async function hmac(secret: string, data: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Compare two strings without leaking where they differ. Both sides are hashed with a fresh key
 * first, so the comparison time depends on neither value nor on their lengths.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])) as CryptoKey;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(a));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(b));
}

/** Check a standard-base64 HMAC-SHA256 signature (the format of a signed cookie) in constant time. */
export async function verifyBase64Hmac(secret: string, data: string, signature: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(signature), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, encoder.encode(data));
}

/** A short, stable stand-in for an address in rate-limit keys, so raw emails are not stored there. */
export async function fingerprint(secret: string, value: string): Promise<string> {
  return (await hmac(secret, `fp:${value}`)).slice(0, 22);
}

/** `count` random decimal digits, each uniformly distributed. */
export function randomDigits(count: number): string {
  const out: number[] = [];
  while (out.length < count) {
    const bytes = crypto.getRandomValues(new Uint8Array(count * 2));
    // Bytes 250-255 are dropped so every digit is equally likely.
    for (const byte of bytes) if (byte < 250 && out.length < count) out.push(byte % 10);
  }
  return out.join('');
}
