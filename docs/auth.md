# Sign-in, workspaces and accounts

This page is for whoever runs a Toolshed install. It covers how people get in, who may do what, what is
stored, and the choices made to keep accounts safe.

## The short version

- Accounts are by invite. Nobody can sign up on their own.
- Everyone can sign in with a 6-digit code sent to their email. Passwords, passkeys and two-step sign-in
  are optional extras each person turns on for themselves.
- The first person in is the owner of the install. Only the address in `OWNER_EMAIL` can become that person.
- People belong to workspaces. Each workspace has its own data and its own roles.

## Settings you choose at deploy

| Name | Needed | What it does |
|---|---|---|
| `AUTH_SECRET` | Yes | Signs session cookies and keys every stored code. At least 32 random characters (`openssl rand -base64 32`). Changing it signs everyone out and voids open codes and two-step secrets. |
| `OWNER_EMAIL` | Yes | The only address that can claim a new install at `/setup`. |
| `EMAIL_FROM` | For email | The address emails come from until the owner picks one on the Email screen. See [email.md](email.md). |
| `APP_URL` | Optional | The install's address, for example `https://tools.example.com`. Without it Toolshed uses the address of each request. Set it when the Worker answers on more than one address, so links, cookies and passkeys all belong to one. |
| `TOOLSHED_PASSWORD_ITERATIONS` | Optional | Password hashing cost. See [passwords.md](passwords.md). |

## Claiming a new install

1. Deploy with `OWNER_EMAIL` set, then open `/setup`.
2. Toolshed emails a 6-digit code to that address. The page shows the address with most letters hidden.
3. Enter the code, name the first workspace, and pick what to turn on first.

The person who does this becomes the install owner and the owner of the first workspace.

Once an owner exists, `/setup` only says that the install is already claimed. It never sends another code.

**If email is not set up yet.** A new install that cannot send email would have no way in. In that one case,
and only for this claim code, Toolshed writes a single line to the Worker's log:

```
Toolshed claim code: 123456
```

The page tells you to look there. Read it with `npx wrangler tail` or in the Cloudflare dashboard under the
Worker's logs. The line holds the code and nothing else. Sign-in codes, sign-in links and invites are never
logged, and nothing is logged once the install has an owner. Anyone who can read the Worker's logs can
already change the Worker, so this gives away nothing new.

At most 5 claim codes are sent per 15 minutes for the whole install.

The owner signs in like everyone else, by a code sent to their email. Add a passkey or a password on the
Account screen soon after, so a lost inbox does not lock the owner out.

## Ways to sign in

### Emailed code and link

Type your email, get a 6-digit code, type the code. The code works once, for 10 minutes, and stops working
after 5 wrong guesses.

The same email has a sign-in link. Opening the link does not sign anyone in. It shows a page with the
device, IP address and time of the request, and a button. Only pressing the button finishes the sign-in, in
the browser that opened the link. Mail scanners that open every link therefore cannot use the link up or
sign themselves in.

The page looks the same whether or not the address has an account. An unknown address gets the same
"Check your email" page and no email.

### Password

Optional. Set one on the Account screen. It needs at least 10 characters. A person with a password can also
pick a username and sign in with either. A wrong password and an unknown account give the same message.
Setting or changing a password signs out that person's other devices.

Removing the password is always possible, because the emailed code still works.

### Passkey

Optional. Add one on the Account screen, then use "Sign in with a passkey". A passkey already proves two
things (the device and its lock), so a passkey sign-in skips the two-step check.

Passkeys are tied to the address of the install. Browsers refuse them on a bare IP address, so a local
install must be opened as `http://localhost:8787`, not `http://127.0.0.1:8787`. If the install's address
changes, old passkeys stop working and people add new ones after signing in by code.

### Two-step sign-in

Optional. A person scans a QR code with an authenticator app and confirms one code. After that, signing in
by emailed code, link or password also asks for a code from the app.

- 10 recovery codes are shown once when two-step is turned on. Each works once. They can be replaced.
- "Trust this device for 30 days" skips the app code on that browser for 30 days.
- Too many wrong app codes pause the check for a while.

## Workspaces and roles

A person can belong to several workspaces and switch between them. Data never crosses from one to another.

| | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| Look at tools and their data | Yes | Yes | Yes | Yes |
| Use tools and change what is in them | Yes | Yes | Yes | No |
| See the member list | Yes | Yes | Yes | Yes |
| Invite, remove and change roles of admins, members and viewers | Yes | Yes | No | No |
| Add, change or remove an owner | Yes | No | No | No |
| Rename the workspace | Yes | Yes | No | No |
| Delete the workspace | Yes | No | No | No |

Rules that hold for every role:

- Nobody changes their own role.
- A workspace always keeps at least one owner. The last owner cannot leave, be removed or be lowered.
- Every check runs on the server, for the dashboard and the API alike.
- When a person is removed, their API keys for that workspace stop working. When a person's role is lowered,
  their keys drop to the new role.

By default only the install owner can create more workspaces. The install setting
`auth.members_can_create_workspaces` lets everyone create them. One person can own at most 25.

Deleting a workspace deletes everything in it and cannot be undone. It asks for the workspace's short name,
typed out.

### Invites

An owner or admin invites an email address with a role. The invite email has a link that works for 7 days.
The invited person opens it, proves the address with an emailed code, and joins. An invite can be sent
again or cancelled. It can only be accepted by the address it was sent to.

One person can send at most 50 invites per hour.

## The install owner

The install owner sees a Users screen that covers every workspace:

- List people and workspaces.
- Suspend a person for 7 days, 30 days or until lifted. A suspended person is signed out at once, cannot
  sign in, and their API keys and tokens are refused.
- Delete a person or a workspace. This needs a sign-in from the last 30 minutes, and the person's email or
  the workspace's short name typed out. A person who is the only owner of a workspace cannot be deleted
  until that workspace has another owner or is deleted.
- Sign in as a person to see what they see. This lasts one hour and is written to the activity log with
  the owner's name, as is everything done during it. While signed in as someone, the owner cannot change how
  that account signs in (password, passkeys, two-step, email), delete their workspace or use the Users
  screen.

An install owner cannot be suspended, deleted or signed in as. API keys never reach the Users screen.

## Sessions

- A session lasts 30 days from its last use. "Sign in as" sessions last one hour and are never extended.
- The Account screen lists a person's devices with browser, system, IP address and last use. They can sign
  out one device or all the others.
- Changing the email address, password, passkeys or two-step settings needs a sign-in from the last 30
  minutes. Toolshed asks the person to sign in again when it is older.
- Changing the email address needs a code sent to the new address, signs out other devices, and tells the
  old address.
- Deleting your own account needs your email typed out. It is refused while you are the only owner of a
  workspace, or of the install. Give the workspace another owner or delete it first.

## What is stored

Everything lives in the install's own D1 database.

| Table | Holds |
|---|---|
| `user` | Email, name, optional username, suspension state, whether the person is an install owner. |
| `session` | One row per signed-in device: IP address, browser name, times, the active workspace. |
| `account` | The password hash, when a person has set a password. |
| `passkey` | Public keys of passkeys. The private key never leaves the person's device. |
| `twoFactor` | Authenticator secrets and recovery codes, encrypted with a key from `AUTH_SECRET`. |
| `organization`, `member`, `invitation` | Workspaces, who is in them with which role, and open invites. |
| `auth_codes` | Emailed codes and links, as keyed hashes only, with the IP address and browser that asked. |
| `verification` | Short-lived rows for a sign-in that is half way through. |

Codes and link tokens are never stored as sent. A copy of the database cannot be turned back into a working
code or link without `AUTH_SECRET`.

A daily job deletes codes a day after they end, sessions that have run out and old `verification` rows.

Sign-ins, sign-outs, pauses, role changes, invites, and every change to a password, passkey, two-step
setting or email address are written to the activity log.

## Limits on guessing and flooding

| What | Limit |
|---|---|
| Codes sent to one address | 5 per 15 minutes |
| Codes asked for from one IP address, across all addresses | 60 per hour |
| Wrong codes for one address | 5 per 15 minutes, then code sign-in for that address pauses |
| Code, password and two-step checks from one IP address | 120 per 15 minutes |
| Wrong passwords for one account | 10 per 15 minutes |
| Passkey sign-ins from one IP address | 60 per 15 minutes |
| Claim codes for the install | 5 per 15 minutes |
| Email changes started by one person | 5 per hour |
| Confirmation codes sent to one new address | 3 per 15 minutes |
| Invites sent by one person | 50 per hour |
| "Sign in as" sessions started by the owner | 30 per hour |
| Invalid API keys or tokens from one IP address | 30 per minute |

While code sign-in is paused for an address, the link in the email and a passkey still work. A stranger
typing wrong codes can slow the real person down, but cannot lock them out. The same holds for passwords:
when password sign-in pauses, an emailed code still works.

The counts live in D1, so they hold across every copy of the Worker.

## Safety choices

- **No way to tell who has an account.** Sign-in pages and messages are the same for known and unknown
  addresses, and an unknown address costs the same work (a password is still hashed, a code is still
  stored). Asking to change to an address that is already taken looks the same as any other.
- **Passwords** are hashed with PBKDF2-SHA256, once per request at most. See [passwords.md](passwords.md).
- **Codes** are single use, short lived and stored as keyed hashes. Comparisons take the same time whether
  the guess is close or not.
- **Cookies** are `HttpOnly`, `SameSite=Lax` and `Secure`. `Secure` is dropped only on plain
  `http://localhost` and `http://127.0.0.1`, where a browser would refuse the cookie. On `https` the names
  start with `__Secure-`. The session cookie is `toolshed.session_token`.
- **A new session on every sign-in.** A cookie from before the sign-in is never reused, so nobody can plant
  one in advance.
- **Forms only work from the install's own pages.** Every request that changes something must come from the
  install's own address.
- **No open redirects.** After sign-in, people are only ever sent to a path inside the install.
- **IP addresses** come from Cloudflare's own `CF-Connecting-IP` header. `X-Forwarded-For` is ignored.
- **No requests to other sites** from any sign-in page.

## Local development

With `ENVIRONMENT=dev`:

- Emails are not sent. Read them, codes and links included, at `/dev/outbox`.
- The limits above are 20 times looser, so repeated test runs do not pause themselves. The pause after 5
  wrong codes is not loosened.
- `/dev/auth/*` offers JSON shortcuts for automated tests. They use the caller's own session and the same
  permission checks as the screens.

None of the `/dev/*` routes exist in production. They answer 404.
