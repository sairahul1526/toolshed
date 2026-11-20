// Spike Worker: GET /bench?id=<case>&n=<repeats> runs one case n times.
// Deployable as-is to a Free account later; CPU time then shows in Workers Logs.
import { scryptSync } from "node:crypto";
import { scrypt as nobleScrypt } from "@noble/hashes/scrypt";
import { CASES } from "./cases.mjs";

const password = new TextEncoder().encode("correct horse battery staple");

async function runCase(c, salt) {
  if (c.kind === "scrypt-native") {
    scryptSync(password, salt, 64, { N: c.N, r: c.r, p: c.p, maxmem: 256 * c.N * c.r * 2 });
  } else if (c.kind === "scrypt-noble") {
    nobleScrypt(password, salt, { N: c.N, r: c.r, p: c.p, dkLen: 64 });
  } else {
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: c.hash, salt, iterations: c.iterations }, key, 256);
  }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/noop") return Response.json({ ok: true });
    const c = CASES.find((x) => x.id === url.searchParams.get("id"));
    if (!c) return Response.json({ error: "unknown id", ids: CASES.map((x) => x.id) }, { status: 404 });
    const n = Math.min(Number(url.searchParams.get("n") ?? 1), 50);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    try {
      for (let i = 0; i < n; i++) await runCase(c, salt);
      return Response.json({ ok: true, id: c.id, n });
    } catch (e) {
      return Response.json({ ok: false, id: c.id, error: String(e?.message ?? e) }, { status: 500 });
    }
  },
};
