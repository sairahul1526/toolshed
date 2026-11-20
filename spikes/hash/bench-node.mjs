// Node CPU benchmark of each case. Uses process.cpuUsage, median of RUNS.
import { scryptSync, webcrypto } from "node:crypto";
import { scrypt as nobleScrypt } from "@noble/hashes/scrypt";
import { CASES } from "./cases.mjs";

const RUNS = Number(process.env.RUNS ?? 7);
const password = new TextEncoder().encode("correct horse battery staple");
const salt = webcrypto.getRandomValues(new Uint8Array(16));

async function runCase(c) {
  if (c.kind === "scrypt-native") {
    scryptSync(password, salt, 64, { N: c.N, r: c.r, p: c.p, maxmem: 256 * c.N * c.r * 2 });
  } else if (c.kind === "scrypt-noble") {
    nobleScrypt(password, salt, { N: c.N, r: c.r, p: c.p, dkLen: 64 });
  } else {
    const key = await webcrypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: c.hash, salt, iterations: c.iterations }, key, 256);
  }
}

const rows = [];
for (const c of CASES) {
  await runCase(c); // warm up
  const cpu = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.cpuUsage();
    await runCase(c);
    const d = process.cpuUsage(t);
    cpu.push((d.user + d.system) / 1000);
  }
  cpu.sort((a, b) => a - b);
  rows.push({ id: c.id, medianCpuMs: +cpu[Math.floor(cpu.length / 2)].toFixed(2), maxCpuMs: +cpu.at(-1).toFixed(2), note: c.note ?? "" });
}
console.log(JSON.stringify({ node: process.version, arch: process.arch, runs: RUNS, rows }, null, 2));
