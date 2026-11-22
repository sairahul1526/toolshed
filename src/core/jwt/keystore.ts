/**
 * The key pairs that sign short-lived tokens, and the cache that lets a token be checked
 * without a database read.
 *
 * ES256 (ECDSA on P-256 with SHA-256) because Workers and Node 22 both ship it in Web Crypto
 * with no flag, Web Crypto already gives the signature in the 64 byte form a JWT wants, and
 * every JWT library can check it. EdDSA is as good a signature but is still missing from some
 * verifiers and was experimental in Node's Web Crypto for a long time.
 *
 * Where a key lives:
 * - D1 (`jwt_signing_keys`) is the truth. The private key is stored encrypted with AES-256-GCM
 *   under a key derived from AUTH_SECRET with HKDF, so a copy of the database alone signs nothing.
 * - KV holds the public keys for checking tokens, so a cold Worker does not need D1.
 * - Each Worker instance keeps both in memory for a minute.
 *
 * Rotation: a new pair is made when the current one is 90 days old, or on demand. The old
 * private key is erased at once. The old public key stays published until every token it could
 * have signed has expired, then it is deleted.
 */
import type { Env } from '../../env';
import { audit } from '../audit';
import { b64uDecode, b64uEncode, fromUtf8, randomBytes, sha256, utf8 } from '../keys/encoding';
import { requireSecret } from '../secret';

export const JWT_ALG = 'ES256';
/** The longest any token may live (embed tokens). Access tokens live 15 minutes. */
export const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** A signing key is replaced when it is this old. */
export const KEY_ROTATE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** How long a Worker instance signs with the key it has before looking for a newer one. */
const SIGNER_CACHE_MS = 60_000;
/** How long a Worker instance trusts its copy of the public keys. */
const VERIFY_CACHE_MS = 60_000;
/** An unknown `kid` sends one instance to the database at most this often, however many arrive. */
const MISS_REFRESH_MS = 10_000;
/**
 * A retired public key stays this long: the longest token life, plus the minute another
 * instance may still sign with it, plus slack for clocks.
 */
const RETIRED_PUBLISH_MS = MAX_TOKEN_TTL_SECONDS * 1000 + SIGNER_CACHE_MS + 2 * 60_000;
const KV_KEY = 'core:jwt:jwks:v1';
/** The KV copy rebuilds itself from D1 this often, which also bounds how long a failed write can linger. */
const KV_TTL_SECONDS = 15 * 60;
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** A public key as published at /.well-known/jwks.json. */
export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export interface Jwks {
  keys: PublicJwk[];
}

interface PublishedKey {
  jwk: PublicJwk;
  /** When this key stops being accepted (ms). Null while it is the signing key. */
  until: number | null;
}

interface SigningRow {
  kid: string;
  public_jwk: string;
  private_enc: string | null;
  created_at: number;
  retired_at: number | null;
}

export interface Signer {
  kid: string;
  key: CryptoKey;
  createdAt: number;
}

interface State {
  signer: (Signer & { loadedAt: number }) | null;
  published: PublishedKey[];
  verifiers: Map<string, { key: CryptoKey; until: number | null }>;
  loadedAt: number | null;
  lastMissAt: number | null;
}

/**
 * One cache per database binding. In a Worker that is one per instance. In tests every
 * `createTestEnv()` has its own database, so installs never see each other's keys.
 */
const states = new WeakMap<object, State>();

function stateFor(env: Env): State {
  let state = states.get(env.DB);
  if (!state) {
    state = { signer: null, published: [], verifiers: new Map(), loadedAt: null, lastMissAt: null };
    states.set(env.DB, state);
  }
  return state;
}

function isPublicJwk(value: unknown): value is PublicJwk {
  if (!value || typeof value !== 'object') return false;
  const jwk = value as Record<string, unknown>;
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' && typeof jwk.kid === 'string';
}

function parsePublished(value: unknown): PublishedKey[] | null {
  if (!value || typeof value !== 'object') return null;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  const out: PublishedKey[] = [];
  for (const entry of keys as { jwk?: unknown; until?: unknown }[]) {
    if (!entry || !isPublicJwk(entry.jwk) || (entry.until !== null && typeof entry.until !== 'number')) return null;
    out.push({ jwk: entry.jwk, until: entry.until });
  }
  return out;
}

function publishedFrom(rows: SigningRow[]): PublishedKey[] {
  const out: PublishedKey[] = [];
  for (const row of rows) {
    let jwk: unknown;
    try {
      jwk = JSON.parse(row.public_jwk);
    } catch {
      continue;
    }
    if (isPublicJwk(jwk)) out.push({ jwk, until: row.retired_at === null ? null : row.retired_at + RETIRED_PUBLISH_MS });
  }
  return out;
}

async function loadRows(env: Env): Promise<SigningRow[]> {
  const { results } = await env.DB.prepare('SELECT kid, public_jwk, private_enc, created_at, retired_at FROM jwt_signing_keys ORDER BY created_at DESC, kid').all<SigningRow>();
  return results;
}

/** Take a fresh list of public keys into this instance's cache. Keys already imported are reused. */
async function adopt(state: State, published: PublishedKey[], now: number): Promise<void> {
  const verifiers = new Map<string, { key: CryptoKey; until: number | null }>();
  for (const { jwk, until } of published) {
    const key = state.verifiers.get(jwk.kid)?.key ?? (await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, EC, false, ['verify']));
    verifiers.set(jwk.kid, { key, until });
  }
  state.published = published;
  state.verifiers = verifiers;
  state.loadedAt = now;
}

/** Write the public keys to KV. A failed write is not fatal: readers fall back to D1. */
async function publish(env: Env, published: PublishedKey[]): Promise<void> {
  try {
    await env.KV.put(KV_KEY, JSON.stringify({ keys: published }), { expirationTtl: KV_TTL_SECONDS });
  } catch (err) {
    console.error('[jwt] could not write the public keys to KV', err);
  }
}

async function refreshFromDb(env: Env, state: State, now: number): Promise<SigningRow[]> {
  const rows = await loadRows(env);
  const published = publishedFrom(rows);
  await adopt(state, published, now);
  // Nothing to publish before the first token is signed, and no reason to spend a KV write on it.
  if (published.length > 0) await publish(env, published);
  return rows;
}

async function refresh(env: Env, state: State, now: number): Promise<void> {
  let published: PublishedKey[] | null = null;
  try {
    published = parsePublished(await env.KV.get(KV_KEY, 'json'));
  } catch {
    published = null;
  }
  if (published) await adopt(state, published, now);
  else await refreshFromDb(env, state, now);
}

/**
 * The public key for a `kid`, or null when this install has no such key or it is past its time.
 * With a warm cache this does no I/O. A stale cache costs one KV read. Only a `kid` nobody has
 * seen (a key another instance just made) reaches D1, and at most once every 10 seconds.
 */
export async function findVerifier(env: Env, kid: string, now: number): Promise<CryptoKey | null> {
  const state = stateFor(env);
  if (state.loadedAt === null || Math.abs(now - state.loadedAt) >= VERIFY_CACHE_MS) await refresh(env, state, now);
  let hit = state.verifiers.get(kid);
  if (!hit && (state.lastMissAt === null || Math.abs(now - state.lastMissAt) >= MISS_REFRESH_MS)) {
    state.lastMissAt = now;
    await refreshFromDb(env, state, now);
    hit = state.verifiers.get(kid);
  }
  if (!hit || (hit.until !== null && hit.until <= now)) return null;
  return hit.key;
}

/** The public keys to check tokens with. Empty until the first token is signed. */
export async function getJwks(env: Env, now = Date.now()): Promise<Jwks> {
  const state = stateFor(env);
  if (state.loadedAt === null || Math.abs(now - state.loadedAt) >= VERIFY_CACHE_MS) await refresh(env, state, now);
  return { keys: state.published.filter((k) => k.until === null || k.until > now).map((k) => k.jwk) };
}

async function wrappingKey(env: Env, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  requireSecret(env);
  const material = await crypto.subtle.importKey('raw', utf8(env.AUTH_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('toolshed:jwt-signing-key:v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `v1.<salt>.<iv>.<ciphertext>`. The `kid` is bound in, so a ciphertext cannot be moved to another row. */
async function encryptPrivate(env: Env, kid: string, jwk: JsonWebKey): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await wrappingKey(env, salt);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(kid) }, key, utf8(JSON.stringify(jwk)));
  return `v1.${b64uEncode(salt)}.${b64uEncode(iv)}.${b64uEncode(new Uint8Array(sealed))}`;
}

/** The signing key from its stored form, or null when it cannot be opened (AUTH_SECRET changed, or damage). */
async function decryptPrivate(env: Env, kid: string, stored: string): Promise<CryptoKey | null> {
  const [version, saltText, ivText, sealedText, extra] = stored.split('.');
  const salt = b64uDecode(saltText ?? '');
  const iv = b64uDecode(ivText ?? '');
  const sealed = b64uDecode(sealedText ?? '');
  if (version !== 'v1' || extra !== undefined || !salt || !iv || !sealed) return null;
  const key = await wrappingKey(env, salt);
  try {
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(kid) }, key, sealed);
    const jwk = JSON.parse(fromUtf8(new Uint8Array(opened)) ?? '') as JsonWebKey;
    return await crypto.subtle.importKey('jwk', jwk, EC, false, ['sign']);
  } catch {
    return null;
  }
}

/** The JWK thumbprint (RFC 7638), so the same key always gets the same id. */
async function thumbprint(x: string, y: string): Promise<string> {
  return b64uEncode(await sha256(utf8(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)));
}

export interface RotateOptions {
  /**
   * Also stop trusting every older key, so every token signed before now fails. For a leak.
   * Without it, tokens signed before the rotation keep working until they expire.
   * Other Worker instances catch up within a few minutes (15 at worst, if the KV write fails).
   */
  revokeOld?: boolean;
  now?: number;
  /** Who pressed the button. Left out when the system rotates on its own. */
  actor?: { userId: string; label?: string | null; ip?: string | null };
}

async function createKey(env: Env, opts: RotateOptions, action: 'signing_key.created' | 'signing_key.rotated'): Promise<Signer> {
  const now = opts.now ?? Date.now();
  const pair = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  if (!pub.x || !pub.y) throw new Error('The new signing key has no public point');
  const kid = await thumbprint(pub.x, pub.y);
  const jwk: PublicJwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: JWT_ALG, use: 'sig' };
  const sealed = await encryptPrivate(env, kid, priv);

  await env.DB.batch([
    env.DB.prepare('INSERT INTO jwt_signing_keys (kid, alg, public_jwk, private_enc, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
      kid,
      JWT_ALG,
      JSON.stringify(jwk),
      sealed,
      now,
    ),
    opts.revokeOld
      ? env.DB.prepare('DELETE FROM jwt_signing_keys WHERE kid != ?1').bind(kid)
      : env.DB.prepare('UPDATE jwt_signing_keys SET retired_at = ?2, private_enc = NULL WHERE kid != ?1 AND retired_at IS NULL').bind(kid, now),
    env.DB.prepare('DELETE FROM jwt_signing_keys WHERE retired_at IS NOT NULL AND retired_at < ?1').bind(now - RETIRED_PUBLISH_MS),
  ]);

  const state = stateFor(env);
  await refreshFromDb(env, state, now);
  const signer: Signer = { kid, key: await crypto.subtle.importKey('jwk', priv, EC, false, ['sign']), createdAt: now };
  state.signer = { ...signer, loadedAt: now };

  await audit(env, {
    actorId: opts.actor?.userId ?? null,
    actorType: opts.actor ? 'user' : 'system',
    actorLabel: opts.actor?.label ?? null,
    ip: opts.actor?.ip ?? null,
    action,
    targetType: 'signing_key',
    targetId: kid,
    summary:
      action === 'signing_key.created'
        ? 'Made the first key for signing tokens'
        : opts.revokeOld
          ? 'Replaced the token signing key. Tokens signed before now stopped working'
          : 'Replaced the token signing key. Tokens signed before now work until they expire',
    meta: { revokedOld: opts.revokeOld === true },
  });
  return signer;
}

/** Replace the signing key now. Returns the new key's id. */
export async function rotateSigningKey(env: Env, opts: RotateOptions = {}): Promise<{ kid: string }> {
  const { kid } = await createKey(env, opts, 'signing_key.rotated');
  return { kid };
}

/**
 * The key to sign with. Makes the first key on first use and replaces one that is 90 days old.
 * A key that no longer opens means AUTH_SECRET changed: it is replaced and the old ones are
 * dropped, because whoever changed the secret wanted everything signed under it to stop.
 */
export async function getSigner(env: Env, now: number): Promise<Signer> {
  const state = stateFor(env);
  const cached = state.signer;
  if (cached && Math.abs(now - cached.loadedAt) < SIGNER_CACHE_MS && now - cached.createdAt < KEY_ROTATE_AFTER_MS) return cached;

  const rows = await loadRows(env);
  const current = rows.find((row) => row.retired_at === null && row.private_enc !== null);
  if (!current) return createKey(env, { now }, rows.length === 0 ? 'signing_key.created' : 'signing_key.rotated');
  if (now - current.created_at >= KEY_ROTATE_AFTER_MS) return createKey(env, { now }, 'signing_key.rotated');
  const key = cached?.kid === current.kid ? cached.key : await decryptPrivate(env, current.kid, current.private_enc ?? '');
  if (!key) return createKey(env, { now, revokeOld: true }, 'signing_key.rotated');
  state.signer = { kid: current.kid, key, createdAt: current.created_at, loadedAt: now };
  return state.signer;
}

/** When the signing key was made and when it will be replaced. Null before the first token. */
export async function getSigningKeyStatus(env: Env): Promise<{ kid: string; createdAt: number; rotatesAt: number } | null> {
  const row = await env.DB.prepare('SELECT kid, created_at FROM jwt_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1').first<{
    kid: string;
    created_at: number;
  }>();
  return row ? { kid: row.kid, createdAt: row.created_at, rotatesAt: row.created_at + KEY_ROTATE_AFTER_MS } : null;
}
