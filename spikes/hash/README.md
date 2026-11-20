# Hashing spike (Week 0, feature #1)

Measures password-hash CPU for scrypt and PBKDF2 so we can pick a setting that fits the Workers Free plan (10 ms CPU).

- `npm run spike:hash:node`: CPU per hash in Node (process.cpuUsage).
- `npm run spike:hash:dev`, then `node spikes/hash/bench-workerd.mjs`: time per hash inside workerd.
- `npm run demo:hash`: a local page at http://127.0.0.1:8798 that charts these results and lets you try the hasher.
- On a real Free account: `wrangler deploy -c spikes/hash/wrangler.jsonc`, call `/bench?id=<case>&n=1`, and read CPU time in Workers Logs. **Not done yet: needs the test account.**

Results from 2026-11-20 are in `results/`. Decision: PBKDF2-SHA256, 50,000 iterations (see `docs/passwords.md`).
