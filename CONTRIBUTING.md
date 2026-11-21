# Contributing to Toolshed

Thanks for helping. Toolshed is early (pre-alpha), so the code base is small and moves fast. Open an issue before starting anything big, so we can agree on the approach first.

## Set up

```bash
git clone https://github.com/sairahul1526/toolshed.git
cd toolshed
npm ci
npm run check   # typecheck + tests, the same as CI
npx playwright install chromium   # once, for the end-to-end tests
npm run test:e2e   # Playwright against wrangler dev, also run in CI
```

You need Node.js 22 or newer. No Cloudflare account is needed: everything runs locally with `wrangler dev`.

## Ground rules

1. **Cloudflare only.** Toolshed must install with one click into a Cloudflare account. Don't add a dependency on another hosted service (Stripe, Twilio, Firebase, an OAuth app and so on). Optional add-ons that stay off by default can be discussed in an issue.
2. **Fit the Free plan.** A request gets about 10 ms of CPU on Workers Free. Measure anything CPU-heavy. `spikes/hash/` shows how.
3. **MIT only.** Don't copy code from AGPL or GPL projects. Reading them for ideas is fine. Copied code must carry a compatible license and credit.
4. **One module, one job.** Keep files small and focused. Code in `src/<area>/` gets a matching test file in `test/`.
5. **Stable errors.** Errors that users can see carry a stable `code` (for example `password_too_long`) and a short plain-English message. Don't change existing codes.
6. **No secrets in the repo.** Local secrets go in `.dev.vars`, which git ignores.

## Pull requests

- Keep each PR to one change, with tests.
- `npm run check` and `npm run test:e2e` must pass. A change you can see in a browser comes with an end-to-end test.
- Say what changed and why in the description. For anything visible, add a screenshot in light mode, dark mode and at phone width (375 px).
- Commit messages: a short imperative summary line, for example "Add rate limit to email codes".

## Spikes

A spike is a small experiment that answers one question, such as "which password hash fits in 10 ms?". It lives in `spikes/<name>/` with a README covering the question, how to run it, the results and the decision. Spikes aren't product code and aren't type-checked.
