# Using the API

Everything under `/api/v1/` answers in JSON. Call it with an API key, or swap the key for a short-lived token and send that instead. The examples use a local install at `http://127.0.0.1:8787`.

## Make a key

A workspace admin makes keys while signed in to the dashboard. The dashboard sends:

```
POST /api/v1/keys
{ "name": "Deploy script", "scopes": ["links:write"], "role": "member", "expiresInDays": 90 }
```

| Field | Notes |
|---|---|
| `name` | Up to 80 characters. Shown in lists and in the audit log. |
| `scopes` | What the key may touch. At least one, at most 50. See below. |
| `role` | `admin`, `member` or `viewer`. Leave it out to get your own role. Never stronger than yours, and never `owner`. |
| `expiresInDays` | 1 to 3650. Leave it out for a key that does not expire. |
| `serviceAccountId` | Makes the key belong to a service account. See below. |

The answer holds the key once, in `secret`. Toolshed stores only a hash of it, so copy it now. Nobody can show it again.

```json
{
  "key": { "id": "key_...", "name": "Deploy script", "prefix": "ts_live_3kP9xQ2m", "scopes": ["links:write"], "role": "member", "status": "active", "expiresAt": 1776000000000, "lastUsedAt": null },
  "secret": "ts_live_3kP9xQ2m................................a1B2c3"
}
```

A key starts with `ts_live_` (or `ts_test_` on a development install) and is 54 characters long. The first 16 characters are its `prefix`. The prefix is not secret, and it is how you tell keys apart in a list or a log. The last 6 characters are a checksum, so a mistyped key is turned away at once.

A key or a token can read keys (`GET`), if it has the Admin role and the `*` scope. It can never make, rename, rotate or revoke one. Those need a signed-in admin, and answer `keys.session_required` otherwise.

## Send the key

```sh
curl http://127.0.0.1:8787/api/v1/keys \
  -H "Authorization: Bearer $TOOLSHED_KEY"
```

Keep the key in a secret store or an environment variable. Do not put it in a URL, in a web page or in a repository.

## Scopes and roles

A request must pass two checks: the key's scopes and the key's role.

- A scope names a module and an action, such as `links:read`. `links:write` also covers `links:read`.
- `links:*` covers everything in one module. `*` covers everything, including modules added later.
- `GET /api/v1/keys/scopes` lists every scope this install has, with a plain label for each.
- The role works as it does for people: a Viewer key can only read, even with a `write` scope.

Asking for a scope that does not exist answers `keys.unknown_scope`. Scopes and role are fixed when a key is made. To change them, make a new key.

## Service accounts

A key you make for yourself is a personal key. It stops working when you leave the workspace, and it never acts with a stronger role than you have.

A service account is a named identity that is not a person, for keys that must outlive whoever made them: a deploy script, a sync job. Only admins manage them.

```
POST   /api/v1/keys/service-accounts        { "name": "Deploy bot", "role": "member" }
GET    /api/v1/keys/service-accounts
PATCH  /api/v1/keys/service-accounts/:id    { "name": "...", "role": "viewer" }
DELETE /api/v1/keys/service-accounts/:id    revokes every key of the account
```

Pass the account's id as `serviceAccountId` when you make a key. The key acts with the account's role. Changing that role changes all of its keys on their next request.

## Rotate and revoke

```
GET    /api/v1/keys                   working keys. Add ?include=revoked for all of them
GET    /api/v1/keys/:id
PATCH  /api/v1/keys/:id               { "name": "New name" }
POST   /api/v1/keys/:id/rotate        { "graceSeconds": 3600 }
DELETE /api/v1/keys/:id               revokes the key at once
```

Rotating makes a new key with the same name, scopes and role, and answers `{ key, secret, previous }`. The old key stops at once. To switch over without downtime, send `graceSeconds` (up to 7 days) and the old key keeps working for that long.

Revoking cannot be undone. A token made from a revoked key keeps working until it expires, which is 15 minutes at most.

A workspace can have 250 working keys and 50 service accounts.

## Webhooks

Toolshed can send a signed message to your own address whenever something happens, such as a form being submitted. Admins set the endpoints up with `/api/v1/webhooks` (a dashboard screen is on the way). A key needs `webhooks:read` to look and `webhooks:write` to change. Showing or replacing a signing secret needs a signed-in admin. Signatures, retries, the delivery log and every route are in [webhooks.md](./webhooks.md).

## Errors

Every error has the same shape. `code` is stable, so match on it. `message` is for people. Quote `requestId` when you ask for help. `fields` is there when one part of your input was wrong.

```json
{
  "code": "keys.unknown_scope",
  "message": "This permission doesn’t exist: link:read. Check the list and try again.",
  "requestId": "req_...",
  "fields": { "scopes": "This permission doesn’t exist: link:read. Check the list and try again." }
}
```

| Status | Codes |
|---|---|
| 400 | `bad_request` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `webhooks.session_required`, `keys.session_required`, `keys.role_too_high`, `token.scope_too_wide`, `token.role_too_high`, `token.not_renewable` |
| 404 | `not_found`, `keys.service_account_not_found` |
| 409 | `conflict`, `webhooks.too_many`, `webhooks.endpoint_disabled`, `webhooks.delivery_pending`, `keys.revoked`, `keys.expired`, `keys.already_rotated`, `keys.too_many`, `keys.name_taken` |
| 422 | `validation_failed`, `keys.unknown_scope` |
| 429 | `rate_limited` |

A key or a service account in another workspace answers 404, the same as one that does not exist.

## Rate limits

- 300 requests a minute for each key.
- 60 token requests a minute for each caller.

Over the limit you get 429 `rate_limited` and a `Retry-After` header with the number of seconds to wait.

## Swap a key for a 15-minute token

A token is a signed JWT. Other services can check it without calling Toolshed, and a leaked one is useless within 15 minutes.

```sh
curl -X POST http://127.0.0.1:8787/api/v1/token \
  -H "Authorization: Bearer $TOOLSHED_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "scopes": ["links:read"] }'
```

```json
{ "token": "eyJhbGciOiJFUzI1NiIs...", "tokenType": "Bearer", "expiresAt": 1768478400000, "expiresIn": 900, "role": "member", "scopes": ["links:read"] }
```

The body is optional. Without one, the token gets the key's own scopes and role. `scopes` and `role` can only narrow them: asking for more answers `token.scope_too_wide` or `token.role_too_high`.

Send the token the same way as a key, and get a new one with the key before it expires. A token cannot be swapped for another token.

## Check a token yourself

Public keys are at `/.well-known/jwks.json`. No sign-in is needed, and the answer can be cached for 5 minutes.

```sh
curl http://127.0.0.1:8787/.well-known/jwks.json
```

To accept a token, check all of these:

1. The header's `alg` is `ES256` (ECDSA with P-256 and SHA-256). Refuse every other value, `none` included.
2. The header's `kid` matches a key in the JWKS, and the signature is valid for that key. If the `kid` is unknown, fetch the JWKS again once.
3. `iss` is your install's address, for example `https://tools.example.com`.
4. `aud` is `toolshed`.
5. `exp` is in the future. Allow 30 seconds for clocks that disagree.
6. `kind` is `user` or `key`. Refuse anything else: embed tokens are signed by the same keys.

With the [jose](https://github.com/panva/jose) library:

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

const install = 'https://tools.example.com';
const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', install));

const { payload } = await jwtVerify(token, jwks, {
  issuer: install,
  audience: 'toolshed',
  algorithms: ['ES256'],
  clockTolerance: 30,
});
if (payload.kind !== 'user' && payload.kind !== 'key') throw new Error('Not an API token');
```

| Claim | Meaning |
|---|---|
| `sub` | The user id, or the key id when a key asked for the token |
| `kind` | `user` or `key` |
| `org` | The workspace id |
| `role` | `admin`, `member` or `viewer` |
| `scopes` | List of scopes |
| `iat`, `exp` | Made at and expires at, in seconds |
| `jti` | Unique id of the token, for logs |

The signing key is replaced every 90 days. The old public key stays in the JWKS until every token it signed has expired, so read keys by `kid` and never pin one.

Set `APP_URL` to your install's public address. It is the `iss` of every token. Without it, Toolshed uses the address the request came in on.

## Embed tokens (for module authors)

A module that puts a widget on someone else's site can sign its own short token for it. Import from `src/core/jwt`.

```ts
const { token } = await signEmbedToken(env, {
  orgId: org.id,
  module: 'feedback',
  subject: `board:${board.id}`,
  scopes: ['feedback:vote'],
  ttlSeconds: 3600,
});
```

Hand the token to the widget. In the module's public route, check it and use the workspace it names:

```ts
const claims = await verifyEmbedToken(env, token, { module: 'feedback' });
if (!claims) throw errors.unauthorized();
```

An embed token is not an API token. The API refuses it, it has no role, and its scopes must be named scopes of its own module (`feedback:vote`, never `feedback:*`). It lives 15 minutes unless you set `ttlSeconds`, and a day at most. Treat it as public once it reaches a browser: give it the narrowest scope and the shortest life that works.
