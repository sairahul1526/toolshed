// Times each case inside workerd (wrangler dev): wall time of n repeats minus a /noop baseline.
import { CASES } from "./cases.mjs";
const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const N = 10;
async function t(path) { const s = performance.now(); const r = await fetch(BASE + path); const b = await r.json(); return { ms: performance.now() - s, b }; }
let base = []; for (let i = 0; i < 10; i++) base.push((await t("/noop")).ms);
base.sort((a, b) => a - b); const noop = base[5];
const rows = [];
for (const c of CASES) {
  await t(`/bench?id=${c.id}&n=1`);
  const runs = [];
  let err;
  for (let i = 0; i < 3; i++) { const { ms, b } = await t(`/bench?id=${c.id}&n=${N}`); if (!b.ok) { err = b.error; break; } runs.push((ms - noop) / N); }
  runs.sort((a, b) => a - b);
  rows.push(err ? { id: c.id, error: err } : { id: c.id, perHashMs: +runs[1].toFixed(2) });
}
console.log(JSON.stringify({ noopMs: +noop.toFixed(2), repeats: N, rows }, null, 2));
