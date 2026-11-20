# Passwords

Toolshed hashes passwords with **PBKDF2-SHA256** through the Web Crypto API built into Workers. No extra library is involved.

## Why not scrypt or bcrypt

The Workers Free plan allows about 10 ms of CPU per request. We measured on 2026-11-20 (`spikes/hash/`):

| Setting | CPU per hash (local workerd) | Fits Free? |
|---|---|---|
| scrypt N=16384, r=16 (Better Auth default) | ~34 ms native, ~53 ms pure JS | No |
| scrypt N=8192, r=8 | ~12 ms | No |
| PBKDF2-SHA256, 50,000 iterations (**default**) | ~3 ms | Yes, with room to spare |
| PBKDF2-SHA256, 100,000 iterations | ~6 ms | Tight |

Cloudflare's Web Crypto also refuses more than 100,000 PBKDF2 iterations, so that is the ceiling.

## Changing the cost

Set `TOOLSHED_PASSWORD_ITERATIONS` (10,000 to 100,000). On the Workers Paid plan you can raise it to `100000`. Each stored hash records its own cost, so old passwords keep working after a change. Once the sign-in flow lands, a password stored at the old cost will be re-hashed at the new cost the next time that person signs in (`needsRehash()` in `src/auth/hasher.ts`).

## Stored format

```
pbkdf2-sha256$<iterations>$<salt, base64url>$<hash, base64url>
```

It is a standard PBKDF2 hash, so an export can be imported by any other system that supports PBKDF2-SHA256.

## Limits

Passwords can be 1 to 256 characters (an emoji counts as one). Longer input is refused before any hashing, with error code `password_too_long`. Text with a broken character (a lone surrogate) is refused with `password_invalid`.
