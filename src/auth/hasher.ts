// Toolshed password hasher: PBKDF2-SHA256 through Web Crypto.
//
// Chosen by the 2026-11-20 hashing spike (spikes/hash, notes/2026-11-20.md):
// scrypt at Better Auth's default settings costs ~34-49 ms of CPU, far past the
// 10 ms Workers Free limit; PBKDF2-SHA256 at 50,000 iterations costs ~3-4 ms.
//
// 50,000 is a Free-plan compromise: OWASP (2023) asks for 600,000, and
// Cloudflare caps PBKDF2 at 100,000. Paid-plan owners should set 100,000 via
// TOOLSHED_PASSWORD_ITERATIONS. Rate limits, passkeys and 2FA carry the rest.
//
// Stored format (self-describing, so the cost can be raised later). Better Auth
// has no rehash hook: the auth wrapper (#2) must call needsRehash() after a
// successful sign-in and store a fresh hash itself.
//   pbkdf2-sha256$<iterations>$<salt base64url>$<hash base64url>

export const DEFAULT_ITERATIONS = 50_000;
/** Cloudflare's Web Crypto refuses more than 100,000 PBKDF2 iterations in production. */
export const MAX_ITERATIONS = 100_000;
export const MIN_ITERATIONS = 10_000;
/** Max length in characters (code points), checked before normalization. */
export const MAX_PASSWORD_LENGTH = 256;

const PREFIX = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BITS = 256;

export class PasswordHashError extends Error {
  constructor(
    public code: "password_too_long" | "password_empty" | "password_invalid" | "bad_iterations",
    message: string,
  ) {
    super(message);
    this.name = "PasswordHashError";
  }
}

export interface HasherOptions {
  iterations?: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ITERATIONS_TEXT = /^[1-9][0-9]{0,5}$/;

function checkIterations(n: number): number {
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new PasswordHashError(
      "bad_iterations",
      `Password iterations must be a whole number from ${MIN_ITERATIONS} to ${MAX_ITERATIONS}.`,
    );
  }
  return n;
}

function encodePassword(password: string): Uint8Array {
  // Length is counted in code points on the raw input, so an emoji counts as
  // one character and NFKC expansion (e.g. U+FDFA -> 18 chars) can't push an
  // accepted password over the limit. CPU stays flat: PBKDF2 pre-hashes keys.
  const length = [...password].length;
  if (length === 0) throw new PasswordHashError("password_empty", "Enter a password.");
  if (length > MAX_PASSWORD_LENGTH) {
    throw new PasswordHashError(
      "password_too_long",
      `Passwords can be up to ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  if (LONE_SURROGATE.test(password)) {
    throw new PasswordHashError("password_invalid", "This password has a character we can't read. Try typing it again.");
  }
  // NFKC so the same password typed on different keyboards matches.
  return new TextEncoder().encode(password.normalize("NFKC"));
}

async function derive(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

interface Parsed {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  if (!ITERATIONS_TEXT.test(parts[1]!)) return null;
  const iterations = Number(parts[1]);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  const salt = fromB64url(parts[2]!);
  const hash = fromB64url(parts[3]!);
  if (!salt || !hash || salt.length !== SALT_BYTES || hash.length !== HASH_BITS / 8) return null;
  return { iterations, salt, hash };
}

export async function hashPassword(password: string, opts: HasherOptions = {}): Promise<string> {
  const iterations = checkIterations(opts.iterations ?? DEFAULT_ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(encodePassword(password), salt, iterations);
  return `${PREFIX}$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

/** Returns false for a wrong password or a malformed stored hash; never throws for those. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  let input: Uint8Array;
  try {
    input = encodePassword(password);
  } catch {
    return false;
  }
  const hash = await derive(input, parsed.salt, parsed.iterations);
  return timingSafeEqual(hash, parsed.hash);
}

/** True when the stored hash uses a different cost than the current setting (rehash after sign-in). */
export function needsRehash(stored: string, opts: HasherOptions = {}): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.iterations !== checkIterations(opts.iterations ?? DEFAULT_ITERATIONS);
}

/** Reads TOOLSHED_PASSWORD_ITERATIONS from env; falls back to the default when unset. */
export function iterationsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ITERATIONS;
  const text = value.trim();
  if (!ITERATIONS_TEXT.test(text)) return checkIterations(NaN);
  return checkIterations(Number(text));
}

/**
 * Shape Better Auth expects for `emailAndPassword.password`.
 * #2 must set Better Auth's maxPasswordLength <= MAX_PASSWORD_LENGTH, so its
 * unknown-email timing decoy (which calls hash()) can never throw and leak
 * which emails exist.
 */
export function betterAuthPasswordHasher(opts: HasherOptions = {}) {
  return {
    hash: (password: string) => hashPassword(password, opts),
    verify: ({ hash, password }: { hash: string; password: string }) => verifyPassword(password, hash),
  };
}
