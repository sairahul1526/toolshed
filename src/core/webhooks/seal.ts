/**
 * Encrypts secrets at rest: AES-256-GCM under a key derived from AUTH_SECRET with HKDF, the same
 * approach as the token signing keys. `aad` ties the ciphertext to its row and column, so it cannot
 * be copied to another endpoint. Stored form: `v1.<salt>.<iv>.<ciphertext>`.
 */
import type { Env } from '../../env';
import { errors } from '../errors';
import { b64uDecode, b64uEncode, fromUtf8, randomBytes, utf8 } from '../keys/encoding';

const MIN_SECRET_LENGTH = 32;

async function wrappingKey(env: Env, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    throw errors.needs_setup(`Set AUTH_SECRET to a random value of at least ${MIN_SECRET_LENGTH} characters, then try again.`);
  }
  const material = await crypto.subtle.importKey('raw', utf8(env.AUTH_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('toolshed:webhook-secrets:v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(env: Env, aad: string, plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await wrappingKey(env, salt);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(plaintext));
  return `v1.${b64uEncode(salt)}.${b64uEncode(iv)}.${b64uEncode(new Uint8Array(sealed))}`;
}

/** The text that was sealed, or null when it cannot be opened (AUTH_SECRET changed, wrong row, or damage). */
export async function open(env: Env, aad: string, stored: string): Promise<string | null> {
  const [version, saltText, ivText, sealedText, extra] = stored.split('.');
  const salt = b64uDecode(saltText ?? '');
  const iv = b64uDecode(ivText ?? '');
  const sealed = b64uDecode(sealedText ?? '');
  if (version !== 'v1' || extra !== undefined || !salt || !iv || !sealed) return null;
  const key = await wrappingKey(env, salt);
  try {
    return fromUtf8(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, sealed)));
  } catch {
    return null;
  }
}

export const secretAad = (endpointId: string): string => `${endpointId}:secret`;
export const headersAad = (endpointId: string): string => `${endpointId}:headers`;
