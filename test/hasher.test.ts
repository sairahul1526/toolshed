import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ITERATIONS,
  MAX_PASSWORD_LENGTH,
  PasswordHashError,
  betterAuthPasswordHasher,
  hashPassword,
  iterationsFromEnv,
  needsRehash,
  verifyPassword,
} from "../src/auth/hasher";

const FAST = { iterations: 10_000 };

describe("hashPassword / verifyPassword", () => {
  it("round-trips and uses the documented format", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).toMatch(/^pbkdf2-sha256\$50000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", h)).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same", FAST), hashPassword("same", FAST)]);
    expect(a).not.toBe(b);
  });

  it("normalizes Unicode (NFKC) so composed and decomposed forms match", async () => {
    const h = await hashPassword("café", FAST);
    expect(await verifyPassword("café", h)).toBe(true);
  });

  it("handles non-Latin and emoji passwords", async () => {
    const pw = "пароль-密码-🔑🔑";
    const h = await hashPassword(pw, FAST);
    expect(await verifyPassword(pw, h)).toBe(true);
  });

  it("refuses empty and over-long passwords with stable codes", async () => {
    await expect(hashPassword("", FAST)).rejects.toMatchObject({ code: "password_empty" });
    await expect(hashPassword("a".repeat(MAX_PASSWORD_LENGTH + 1), FAST)).rejects.toBeInstanceOf(PasswordHashError);
    await expect(hashPassword("a".repeat(MAX_PASSWORD_LENGTH), FAST)).resolves.toMatch(/^pbkdf2-sha256\$/);
  });

  it("returns false (never throws) for malformed stored hashes", async () => {
    for (const bad of [
      "",
      "plain",
      "pbkdf2-sha256$50000$abc",
      "pbkdf2-sha256$abc$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43),
      "pbkdf2-sha256$999999999$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43),
      "scrypt$16384$x$y",
      "pbkdf2-sha256$50000$!!!$" + "A".repeat(43),
    ]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
    expect(await verifyPassword("a".repeat(MAX_PASSWORD_LENGTH + 1), await hashPassword("a", FAST))).toBe(false);
  });

  it("refuses iteration counts outside 10k–100k", async () => {
    await expect(hashPassword("x", { iterations: 5_000 })).rejects.toMatchObject({ code: "bad_iterations" });
    await expect(hashPassword("x", { iterations: 600_000 })).rejects.toMatchObject({ code: "bad_iterations" });
    await expect(hashPassword("x", { iterations: 12_345.5 })).rejects.toMatchObject({ code: "bad_iterations" });
  });
});

describe("known answer and edge cases", () => {
  it("matches node:crypto pbkdf2Sync byte for byte", async () => {
    const h = await hashPassword("pw", FAST);
    const [, iter, salt, hash] = h.split("$");
    const expected = pbkdf2Sync("pw", Buffer.from(salt!, "base64url"), Number(iter), 32, "sha256");
    expect(Buffer.from(hash!, "base64url").equals(expected)).toBe(true);
  });

  it("counts emoji as one character and allows NFKC-expanding input", async () => {
    await expect(hashPassword("🔑".repeat(MAX_PASSWORD_LENGTH), FAST)).resolves.toMatch(/^pbkdf2-sha256\$/);
    const wide = "\ufdfa".repeat(100); // expands to 1,800 chars under NFKC
    expect(await verifyPassword(wide, await hashPassword(wide, FAST))).toBe(true);
  });

  it("rejects lone surrogates instead of colliding them", async () => {
    await expect(hashPassword("\uD800", FAST)).rejects.toMatchObject({ code: "password_invalid" });
    expect(await verifyPassword("\uD800", await hashPassword("\uFFFD", FAST))).toBe(false);
  });

  it("rejects non-canonical iteration text and wrong salt/hash lengths", async () => {
    const h = await hashPassword("x", FAST);
    const [p, , salt, hash] = h.split("$");
    for (const iter of ["0x2710", "1e4", " 10000", "+10000", "10000.0", "010000"]) {
      expect(await verifyPassword("x", [p, iter, salt, hash].join("$"))).toBe(false);
    }
    expect(await verifyPassword("x", [p, "10000", salt + "AAAA", hash].join("$"))).toBe(false);
    expect(await verifyPassword("x", [p, "10000", salt, hash + "A"].join("$"))).toBe(false);
  });

  it("betterAuth verify returns false for over-long input", async () => {
    const hasher = betterAuthPasswordHasher(FAST);
    const hash = await hasher.hash("pw");
    expect(await hasher.verify({ hash, password: "a".repeat(MAX_PASSWORD_LENGTH + 1) })).toBe(false);
  });
});

describe("needsRehash", () => {
  it("is false at the current cost and true when the setting changes", async () => {
    const h = await hashPassword("x", FAST);
    expect(needsRehash(h, FAST)).toBe(false);
    expect(needsRehash(h, { iterations: DEFAULT_ITERATIONS })).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
    expect(needsRehash(h)).toBe(true); // 10k hash vs 50k default
    expect(needsRehash(await hashPassword("x"))).toBe(false);
  });
});

describe("iterationsFromEnv", () => {
  it("defaults when unset and validates when set", () => {
    expect(iterationsFromEnv(undefined)).toBe(DEFAULT_ITERATIONS);
    expect(iterationsFromEnv("  ")).toBe(DEFAULT_ITERATIONS);
    expect(iterationsFromEnv("100000")).toBe(100_000);
    expect(() => iterationsFromEnv("abc")).toThrow(PasswordHashError);
    expect(() => iterationsFromEnv("1e5")).toThrow(PasswordHashError);
    expect(() => iterationsFromEnv("0x10")).toThrow(PasswordHashError);
  });
});

describe("betterAuthPasswordHasher", () => {
  it("matches Better Auth's hash/verify shape", async () => {
    const hasher = betterAuthPasswordHasher(FAST);
    const hash = await hasher.hash("pw-1");
    expect(await hasher.verify({ hash, password: "pw-1" })).toBe(true);
    expect(await hasher.verify({ hash, password: "pw-2" })).toBe(false);
  });
});
