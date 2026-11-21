/**
 * What an API key looks like:
 *
 *   ts_live_Ab12Cd34<32 random characters><6 character checksum>
 *   └┬┘ └┬─┘ └──┬───┘
 *    │   │      └ key id: 8 random characters. Not secret. Shown in lists and used to find the row.
 *    │   └ `live`, or `test` for keys made on a dev install, so the two are never mixed up.
 *    └ every key starts with `ts_`, which makes leaked keys easy to spot and scan for.
 *
 * - The 32 secret characters are base62, about 190 bits from the system's random source.
 * - The checksum is the CRC-32 of everything before it, like GitHub's tokens. A mistyped or
 *   cut-off key fails it, so we can say no without asking the database.
 * - Only letters, digits and `_`, so a double click selects the whole key.
 */
import { base62Fixed, crc32, randomBase62, sha256, toHex, utf8 } from './encoding';
import type { Bytes } from './encoding';

/** Every key starts with this, so leaked keys are easy to spot and scan for. */
export const KEY_PREFIX = 'ts_';

export type KeyMode = 'live' | 'test';

const ID_LENGTH = 8;
const SECRET_LENGTH = 32;
const CHECKSUM_LENGTH = 6;
const KEY_PATTERN = /^(ts_(?:live|test)_[0-9A-Za-z]{8})[0-9A-Za-z]{32}([0-9A-Za-z]{6})$/;
/** `ts_live_` + id + secret + checksum. Longer input is refused before any other work. */
const MAX_KEY_LENGTH = 8 + ID_LENGTH + SECRET_LENGTH + CHECKSUM_LENGTH;

function checksum(body: string): string {
  return base62Fixed(crc32(body), CHECKSUM_LENGTH);
}

export interface NewKey {
  /** The full key. Shown once and never stored. */
  secret: string;
  /** `ts_live_` plus the key id. Safe to store and show. */
  prefix: string;
}

export function generateKey(mode: KeyMode): NewKey {
  const prefix = `${KEY_PREFIX}${mode}_${randomBase62(ID_LENGTH)}`;
  const body = prefix + randomBase62(SECRET_LENGTH);
  return { secret: body + checksum(body), prefix };
}

/**
 * Check the shape and checksum of something sent as a key. Returns its prefix (for the lookup),
 * or null when it cannot be one of ours. Passing this says nothing about the key being real.
 */
export function parseKey(token: string): { prefix: string } | null {
  if (typeof token !== 'string' || token.length > MAX_KEY_LENGTH) return null;
  const match = KEY_PATTERN.exec(token);
  if (!match) return null;
  const body = token.slice(0, token.length - CHECKSUM_LENGTH);
  if (checksum(body) !== match[2]) return null;
  return { prefix: match[1]! };
}

/**
 * The stored form of a key: SHA-256 of the whole key.
 *
 * A slow password hash (PBKDF2, scrypt) exists to make guessing weak, human-chosen secrets
 * expensive. A key here is 190 random bits, so there is nothing to guess and a fast hash is
 * enough. It also has to run on every API call, inside a 10 ms CPU budget.
 */
export function hashKeyBytes(token: string): Promise<Bytes> {
  return sha256(utf8(token));
}

export async function hashKey(token: string): Promise<string> {
  return toHex(await hashKeyBytes(token));
}
