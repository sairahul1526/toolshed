# Webhooks

A webhook tells another service that something happened in Toolshed, as soon as it happens. When a visitor submits a form or clicks a short link, Toolshed sends a small message to an address you choose. Use it to fill a spreadsheet, post to a chat, start an automation, or keep another system in step.

This page has two parts. The first is for the people who set webhooks up. The second is for the developer who writes the receiver.

## For admins

### What you need

Only workspace admins can use webhooks. You need an address that can receive messages (a URL that starts with `https://`). Your developer, or the tool you want to connect, gives you that address.

### Add an endpoint

An endpoint is one address plus the list of events you want sent to it.

1. Open Webhooks in the dashboard and choose Add endpoint.
2. Give it a name you will recognise, such as "Orders to the warehouse".
3. Paste the address.
4. Pick the events to send. Choose one event, a whole tool (`links.*`), or everything (`*`).
5. Save. Toolshed shows the signing secret once. Copy it and give it to whoever builds the receiver.

You can add up to 20 endpoints in a workspace.

The signing secret lets the receiver prove a message really came from your Toolshed. Keep it private, like a password. You can show it again later from the endpoint's page, and only while you are signed in.

### Send a test

Choose Send test on an endpoint. Toolshed sends a sample event and shows you what the receiver answered, right away. A test works even while the endpoint is paused. It is not counted as a failure and it is never retried.

### Pause, turn off and turn on

- Pause an endpoint to stop sending for a while. Events that happen while it is paused are never delivered later, not even when you turn the endpoint back on. A message that was waiting to be tried again is marked failed when its turn comes and the endpoint is still paused, and it is not retried after that. If you turn the endpoint on before its turn, it is sent as planned. You can send a failed message again from the delivery log once the endpoint is on.
- Toolshed turns an endpoint off by itself if it cannot get through for 3 days in a row, or if the receiver answers that it is gone (`410 Gone`). You get a notification and the reason is shown on the endpoint.
- To turn it back on, fix the receiver, then set the endpoint to active. That clears the failure count. Changing the address clears it too.

### Change the secret

Choose Make a new secret when a secret may have leaked or someone who knew it has left. The old secret keeps working for 24 hours, so you can update the receiver without losing a single message. Toolshed signs each message with both secrets during that time.

### See what was sent

The delivery log lists every message with its event, when it was sent, whether it worked and what the receiver answered. Open one to see each try. If a delivery failed, choose Send again after you fix the receiver. Deliveries are kept for 30 days.

## For developers

### The message

Toolshed sends a `POST` with a JSON body:

```json
{
  "id": "evt_01k8x4q2m7f3d9",
  "type": "links.link.clicked",
  "timestamp": "2026-01-15T12:00:00.000Z",
  "workspace_id": "org_01k8x...",
  "subject": "lnk_01k8x...",
  "data": { "slug": "sale" }
}
```

| Field | Meaning |
|---|---|
| `id` | The event's id. The same event always has the same id, also when it is sent again. Use it to ignore repeats. |
| `type` | What happened, as `<tool>.<event>`. See the event list below. |
| `timestamp` | When it happened, in ISO 8601, UTC. |
| `workspace_id` | The workspace it belongs to. |
| `subject` | The id of the thing it is about, or `null`. |
| `data` | Details. Each event documents its own. |

If the whole body would be over 256 KB, `data` is replaced by `{ "truncated": true }`. Fetch the details from the API instead.

These headers are always set:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | `Toolshed-Webhooks/1` |
| `webhook-id` | The event's id, the same as `id` in the body |
| `webhook-timestamp` | When this try was sent, in whole seconds since 1970 |
| `webhook-signature` | One or more signatures, separated by spaces. Each looks like `v1,<base64>` |

You can add up to 10 headers of your own to an endpoint, for example an `Authorization` header your receiver expects. Their values are stored encrypted and are never shown again. A value must be 1 to 1,024 characters on one line, using only Latin characters (up to `U+00FF`): emoji and other scripts cannot be sent in a header and are refused when you save. If the stored headers can no longer be read (the install's `AUTH_SECRET` changed), the try fails with `headers_unreadable` instead of going out without them. Save the headers again to fix it. These names are not allowed because Toolshed sets them: `host`, `content-length`, `content-type`, `content-encoding`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`, `keep-alive`, `expect`, `user-agent`, `cookie`, `set-cookie`, `via`, `forwarded`, `origin`, `referer`, and anything starting with `webhook-`, `cf-`, `sec-`, `proxy-`, `x-forwarded-` or `x-real-`.

### Check the signature

Signatures follow the [Standard Webhooks](https://www.standardwebhooks.com) rules, so any library for that standard works. The steps are:

1. Take the raw request body as text. Do not parse it and write it out again.
2. Build the string `{webhook-id}.{webhook-timestamp}.{body}`.
3. Make an HMAC with SHA-256 over that string. The key is the secret without its `whsec_` prefix, decoded from base64.
4. Encode the result as base64 and compare it with each `v1,` value in `webhook-signature`. Use a constant-time compare.
5. Refuse the message if `webhook-timestamp` is more than 5 minutes from your clock. That stops someone replaying an old message.

In Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, headers, rawBody) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (!id || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();

  return String(headers['webhook-signature'])
    .split(' ')
    .some((candidate) => {
      const [version, value] = candidate.split(',');
      const got = Buffer.from(value ?? '', 'base64');
      return version === 'v1' && got.length === expected.length && timingSafeEqual(got, expected);
    });
}
```

In a Cloudflare Worker, or anywhere Web Crypto is available:

```js
export async function verify(secret, headers, rawBody) {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  if (!id || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

  for (const candidate of (headers.get('webhook-signature') ?? '').split(' ')) {
    const [version, value] = candidate.split(',');
    if (version !== 'v1' || !value) continue;
    const sig = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    // crypto.subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`))) return true;
  }
  return false;
}
```

Toolshed's own check is `verifySignature(secret, headers, body)` in `src/core/webhooks.ts`, if you are writing a module that receives these.

To test your code, use the published vector from the standard. With the secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, the id `msg_p5jXN8AQM9LWM0D4loKWxJek`, the timestamp `1614265330` and the body `{"test": 2432232314}`, the signature is `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`.

### Answer quickly

Answer with any `2xx` status as soon as you have stored the message, then do the slow work afterwards. Toolshed waits 10 seconds for an answer. It does not follow redirects, so give the final address. It reads at most 64 KB of your answer and keeps the first 2 KB in the log, which helps when you debug.

### When it fails

Anything but a `2xx` counts as a failure, as does a timeout, a redirect or a refused connection. Toolshed tries again on this schedule, counted from the previous try:

| Try | Sent |
|---|---|
| 1 | At once |
| 2 | 30 seconds later |
| 3 | 2 minutes later |
| 4 | 10 minutes later |
| 5 | 1 hour later |
| 6 | 6 hours later |
| 7 | 24 hours later |

After the seventh try the delivery is marked failed. The whole schedule covers a little over 31 hours. Each try is saved in the log with its status, how long it took, an error code and the start of your answer.

Because of retries, the same event can arrive more than once, and in a different order from the order it happened. Use `id` to skip repeats and `timestamp` to order events.

A `410 Gone` answer means "stop sending". Toolshed turns the endpoint off at once, without more tries.

### When an endpoint is turned off

Each failed try is checked against the endpoint's streak. If the endpoint has had no success for 72 hours, counting from its first failure in this streak, Toolshed sets it to `disabled`, writes the reason on it, notifies the workspace's admins and adds an entry to the audit log. One success ends the streak. A failure that comes more than 31 hours after the previous one (a little longer than the whole retry schedule) starts a new streak, so a single failure after a quiet week never turns an endpoint off. A 410 turns it off straight away.

A disabled endpoint receives nothing, and what was still waiting for it is marked failed. Turning it back on is up to a person. Setting the status back to `active` clears the reason and the streak. So does changing the address, and so does turning a paused endpoint back on.

### Send again

A finished delivery (success or failed) can be sent again from the log or the API. It is the same event with the same `id`, and it gets a fresh set of 7 tries. It is refused while the delivery is still being tried, and when the endpoint is paused or turned off.

### Change the secret

`POST /api/v1/webhooks/:id/rotate` makes a new secret and returns it. For 24 hours Toolshed sends two signatures, one for the new secret and one for the old, so a receiver using either one accepts the message. Rotating again inside that day ends the first overlap. The secret is stored encrypted with a key derived from `AUTH_SECRET`, tied to the endpoint, and it never appears in lists, logs or the audit log.

### Limits

| Limit | Value |
|---|---|
| Endpoints per workspace | 20 |
| Events per endpoint | 50 patterns |
| Custom headers per endpoint | 10 |
| Message size | 256 KB, then `data` is dropped |
| Time to answer | 10 seconds |
| Redirects | Not followed |
| Address | `https://` only. Private, local and internal addresses, and the address of this Toolshed install itself, are refused when you save and again on every send |
| Delivery log | 30 days, cleaned up every hour |
| Making endpoints | 20 an hour for each workspace |
| Test events | 20 every 10 minutes for each workspace |
| Sending again | 60 every 10 minutes for each workspace |
| New secrets | 10 an hour for each workspace |

### Addresses Toolshed will not send to

An address is refused when it is not `https://`, when it carries a user name or password, or when it is local or private (`localhost`, `10.x.x.x`, `192.168.x.x`, `169.254.x.x`, names ending in `.local` or `.internal`, and so on). The address of this install is refused too, which is the host of `APP_URL`, because an event that sends a webhook to its own install could raise another event, and so on without end.

These checks read the text of the address. Toolshed does not look the name up in DNS, so a public name that points at a private address, or a second name that points at this install, is not caught. That makes no difference on Cloudflare, whose Workers cannot reach private networks. If you run Toolshed inside a private network, block those ranges at the network as well, for example with a firewall rule on the machine that runs it.

### Events

`GET /api/v1/webhooks/events` lists every event this install can send. Tools declare them in `events.emits`. An endpoint chooses patterns:

- `links.link.clicked` is one event.
- `links.*` is every event of the `links` tool.
- `*` is everything, including tools added later.

A test message has the type `webhook.test`. It is never sent to an endpoint's patterns, only when someone asks for it.

### API

All routes are under `/api/v1/webhooks` and are for workspace admins. Reading needs the `webhooks:read` scope, and changing needs `webhooks:write`. The `*` scope covers both, and so does being signed in. Showing or replacing a secret needs a signed-in person: a key or token cannot do it. See [api.md](./api.md) for keys and scopes.

| Route | What it does |
|---|---|
| `GET /events` | Every event an endpoint can subscribe to. |
| `GET /` | The endpoints, as `{ endpoints }`. |
| `POST /` | Add one. Body: `name`, `url`, `events`, and optionally `description` and `headers`. Answers 201 with `{ endpoint, secret }`. |
| `GET /:id` | One endpoint. Header names are shown, values and the secret are not. |
| `PATCH /:id` | Change `name`, `description`, `url`, `events`, `headers` (replaces them all) or `status` (`active` or `paused`). |
| `DELETE /:id` | Delete it and its delivery log. |
| `GET /:id/secret` | Show the secret again. Signed in only. |
| `POST /:id/rotate` | Make a new secret. Signed in only. Answers `{ endpoint, secret, previousSecretExpiresAt }`. |
| `POST /:id/test` | Send a test event now. Answers `{ delivery, result }`. A receiver that says no is still a 200 here: read `result`. |
| `GET /deliveries` | The log, newest first. Filters: `endpoint`, `status` (`pending`, `success`, `failed`), `event`. Page with `cursor` and `limit` (1 to 100, 50 if left out). Answers `{ deliveries, nextCursor }`. |
| `GET /deliveries/:id` | One delivery with its payload and every try. |
| `POST /deliveries/:id/resend` | Send it again. Answers 202. |

Every change is written to the audit log (`webhook.created`, `webhook.updated`, `webhook.deleted`, `webhook.secret_viewed`, `webhook.secret_rotated`, `webhook.tested`, `webhook.delivery_resent`, and `webhook.disabled` when Toolshed turns one off). The log shows the endpoint's name but never its address or secret.

An endpoint looks like this:

```json
{
  "id": "whe_01k8x...",
  "name": "Orders",
  "description": null,
  "url": "https://hooks.example.com/in",
  "events": ["links.*"],
  "headerNames": ["X-Api-Token"],
  "status": "active",
  "disabledReason": null,
  "createdBy": "usr_...",
  "createdByLabel": "Sam",
  "createdAt": 1768478400000,
  "updatedAt": 1768478400000,
  "lastSuccessAt": null,
  "lastFailureAt": null,
  "consecutiveFailures": 0,
  "previousSecretExpiresAt": null
}
```

### Error codes

These codes are in addition to the ones in [errors.md](./errors.md).

| Code | Status | Message | What to do |
| --- | --- | --- | --- |
| `webhooks.session_required` | 403 | Keys and tokens can’t read or replace a signing secret. Sign in to the dashboard to do that. | Sign in as an admin and do it there. |
| `webhooks.too_many` | 409 | This workspace has reached its limit of 20 webhook endpoints. Delete one you no longer use, then try again. | Delete an endpoint you do not use. |
| `webhooks.endpoint_disabled` | 409 | We stopped sending to this endpoint because it kept failing. Turn it back on first, then try again. | Fix the receiver, set the endpoint to active, then try again. |
| `webhooks.delivery_pending` | 409 | This delivery is still being tried. Wait until it succeeds or fails, then send it again. | Wait for the delivery to finish. |

Errors recorded on a try (`error_code` in the log) are `http_<status>` for any non-2xx answer, `fetch_timeout`, `fetch_failed`, `fetch_too_large`, `url_not_allowed`, `redirect_not_followed`, `secret_unreadable`, `headers_unreadable`, and `endpoint_paused`, `endpoint_disabled` or `endpoint_deleted` for a delivery that was stopped before sending. A test whose try was cut short, for example because the server restarted, is closed as `test_interrupted` after about 15 minutes.

### For module authors

Declare the events your tool raises in `events.emits`, and raise them with `emit()` as usual. Webhooks pick them up with no more work. `emit()` stays cheap: for a workspace with no active endpoint it costs one remembered check, and otherwise it adds one job to the queue. The job finds every matching endpoint with a single query and creates all the deliveries in one batch. A workspace that adds its first endpoint may wait up to 30 seconds before events start to flow, because the check is remembered for that long.

Keep `data` small and free of secrets and private details. It leaves the install.
