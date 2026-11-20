// Local dev page for feature #1: shows the spike results and lets you try the hasher.
// Run: npm run demo:hash  (serves ui/toolshed.css and this page's HTML as static assets)
import { hashPassword, verifyPassword, PasswordHashError } from "../../src/auth/hasher";
import { CASES } from "./cases.mjs";
import results from "./results/2026-11-20-workerd-local.json";

const LABELS: Record<string, string> = {
  "scrypt-native-N16384-r16-p1": "scrypt N=16384 r=16 (native)",
  "scrypt-noble-N16384-r16-p1": "scrypt N=16384 r=16 (pure JS)",
  "scrypt-native-N8192-r8-p1": "scrypt N=8192 r=8",
  "scrypt-native-N16384-r8-p1": "scrypt N=16384 r=8",
  "scrypt-native-N32768-r8-p1": "scrypt N=32768 r=8",
  "scrypt-native-N131072-r8-p1": "scrypt N=131072 r=8",
  "pbkdf2-sha256-10000": "PBKDF2-SHA256, 10,000",
  "pbkdf2-sha256-50000": "PBKDF2-SHA256, 50,000",
  "pbkdf2-sha256-100000": "PBKDF2-SHA256, 100,000",
  "pbkdf2-sha256-600000": "PBKDF2-SHA256, 600,000",
  "pbkdf2-sha512-100000": "PBKDF2-SHA512, 100,000",
  "pbkdf2-sha512-210000": "PBKDF2-SHA512, 210,000",
};
const NOTES: Record<string, string> = {
  "scrypt-native-N16384-r16-p1": "Better Auth default",
  "scrypt-noble-N16384-r16-p1": "Better Auth default, as shipped",
  "scrypt-native-N131072-r8-p1": "OWASP minimum",
  "pbkdf2-sha256-50000": "Picked",
  "pbkdf2-sha256-100000": "Cloudflare's maximum",
  "pbkdf2-sha256-600000": "OWASP 2023",
};

export default {
  async fetch(req: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/results") {
      const rows = (results.rows as { id: string; perHashMs: number }[])
        .filter((r) => CASES.some((c: { id: string }) => c.id === r.id))
        .map((r) => ({ ...r, label: LABELS[r.id] ?? r.id, note: NOTES[r.id] ?? "" }))
        .sort((a, b) => a.perHashMs - b.perHashMs);
      return Response.json({ rows });
    }
    if (req.method === "POST" && url.pathname === "/api/hash") {
      const { password, iterations } = (await req.json()) as { password: string; iterations: number };
      try {
        return Response.json({ stored: await hashPassword(String(password ?? ""), { iterations }) });
      } catch (e) {
        if (e instanceof PasswordHashError) return Response.json({ code: e.code, message: e.message }, { status: 400 });
        throw e;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/verify") {
      const { password, stored } = (await req.json()) as { password: string; stored: string };
      return Response.json({ ok: await verifyPassword(String(password ?? ""), String(stored ?? "")) });
    }
    if (url.pathname === "/toolshed.css") return env.ASSETS.fetch(new Request(new URL("/toolshed.css", url)));
    return env.ASSETS.fetch(new Request(new URL("/index.html", url)));
  },
};
