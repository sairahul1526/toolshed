# API keys

Keys let a script or another app use your workspace without a person signing in. Find them at **API keys** in the dashboard.

Only workspace owners and admins can open this page. Members and viewers see a message that says so.

## Make a key

1. Choose **Make a key**.
2. Give it a name that says where it is used, such as Zapier or Nightly backup.
3. Choose who it acts as: you (a personal key) or a service account. A personal key stops working if you leave the workspace. A service account's key does not.
4. Pick a role: Admin, Member or Viewer. A key can never be an owner. A key made for a service account uses that account's role.
5. Pick what it can do, or **Full access**, and when it stops working: 30 days, 90 days, 1 year or never.

The key is shown once, right after you make it. Copy it before you leave the page. If you lose it, revoke it and make a new one. Sending the form twice, for example by refreshing, does not make a second key.

## Manage a key

Open a key from the list to change it.

- **Rename** changes only the name.
- **Rotate** makes a new key with the same name and permissions, and shows its secret once. Choose whether the old key stops at once or keeps working for 1 hour, 1 day or 7 days while you update your apps. Rotate a key you made. Admins can't rotate someone else's personal key, but they can revoke it.
- **Revoke** stops a key right away. This can't be undone.

The list shows each key's state: active, expiring soon (within 14 days), expired or revoked. Revoked keys are hidden until you choose **Show revoked keys**.

## Service accounts

A service account is a name for an app or script, with its own role. Make one under the **Service accounts** tab. Deleting it revokes all of its keys, and that can't be undone.

## Signing key

The person who owns the install also sees the signing key. It signs the 15 minute tokens that apps get from `POST /api/v1/token`, and the public key list is at `/.well-known/jwks.json`. It is replaced every 90 days. **Rotate now** replaces it sooner. Tokens already issued keep working until they expire.

## Limits

- The list shows the newest 500 keys.
- Every change is written to the audit log.
- See [the API reference](api.md) for the routes a key can call.
