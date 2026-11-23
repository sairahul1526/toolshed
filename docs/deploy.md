# Deploy

> **Not verified yet.** The steps below are written from Cloudflare's documentation and have not been run on a fresh Cloudflare account. Until that test is done, treat this page as a draft. The README does not show a Deploy button for the same reason.

Toolshed is one Cloudflare Worker with a D1 database, a KV namespace, an R2 bucket and a queue. There are two ways to put it on your own account.

## What you need

- A Cloudflare account. The Free plan is enough to start.
- R2 turned on for the account (it asks for a card even on the free tier).
- Two values:

| Name | What it is |
|---|---|
| `AUTH_SECRET` | Signs sessions. A random string of at least 32 characters. Make one with `openssl rand -base64 32`. The example value from `.dev.vars.example` is refused |
| `OWNER_EMAIL` | Your email address. Only this address can claim the new install, at `/setup` |

## Option 1: the Deploy to Cloudflare button

The button link is:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/sairahul1526/toolshed
```

What Cloudflare does with it:

1. Copies the repository into your GitHub or GitLab account.
2. Reads `wrangler.jsonc` and creates the database, KV namespace, bucket and queue.
3. Reads `.dev.vars.example` and asks you for `AUTH_SECRET` and `OWNER_EMAIL` as secrets. The hints next to each field come from `cloudflare.bindings` in `package.json`.
4. Runs the `build` script, then the `deploy` script.

## Option 2: from your computer

```bash
git clone https://github.com/sairahul1526/toolshed.git
```

```bash
cd toolshed && npm install
```

```bash
npx wrangler secret put AUTH_SECRET
```

```bash
npx wrangler secret put OWNER_EMAIL
```

```bash
npm run deploy
```

## What `npm run deploy` does

1. `node scripts/prepare.mjs` collects every module's screens and database changes into `src/generated/` and `migrations/`.
2. `wrangler d1 migrations apply DB --remote` applies the database changes that are not applied yet. It uses the binding name `DB`, so it works whatever you named the database.
3. `wrangler deploy` uploads the Worker.

Database changes only ever add tables, columns and indexes, so step 2 is safe to run again. If step 2 fails, step 3 does not run and the old version keeps serving.

## After the first deploy

1. Open `https://<your-worker-address>/setup`.
2. Enter the `OWNER_EMAIL` address. A new install cannot send email yet, so the claim code is written to the Worker's log instead: open the Worker in the Cloudflare dashboard, then Logs, and look for `Toolshed claim code`. See [Sign-in](auth.md).
3. Name your workspace. You land on [Get started](guide/get-started.md).

After that, add a sending domain so sign-in codes and invites arrive by email. See [Email](email.md).

## Updating

Pull the new version into your copy of the repository and run `npm run deploy` again (or let Workers Builds run it on push). The [Updates](guide/updates.md) screen shows the version that is running.

## Not done yet

- A test on a fresh account, including reading the claim code from the log.
- The Deploy button in the README.
- `npm create toolshed@latest`.
