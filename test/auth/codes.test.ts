/** The emailed code itself: how many guesses an address can take, however they arrive. */
import { beforeEach, describe, expect, it } from 'vitest';
import { issueCode, pausedFor, redeemCode } from '../../src/auth/codes';
import { CODE_MAX_ATTEMPTS, LIMITS } from '../../src/auth/config';
import type { Env } from '../../src/env';
import { createTestEnv } from '../helpers/d1';

const EMAIL = 'ada@example.com';
const NOW = Date.UTC(2026, 10, 22, 12, 0);

let env: Env;

const wrongGuesses = async () => Number(await env.DB.prepare('SELECT COALESCE(SUM(attempts), 0) AS n FROM auth_codes WHERE email = ?1').bind(EMAIL).first<number>('n'));
/** A 6-digit guess that is not the real code. */
const not = (code: string) => (code === '000000' ? '111111' : '000000');

beforeEach(() => {
  env = createTestEnv().env;
});

describe('wrong codes for one address', () => {
  it('stop at the limit when guesses arrive together on several codes', async () => {
    // Five browsers each ask for a code, then all guess at the same moment, five times each.
    const codes = await Promise.all(Array.from({ length: 5 }, () => issueCode(env, { purpose: 'sign-in', email: EMAIL, now: NOW })));
    const guesses = codes.flatMap((c) => Array.from({ length: CODE_MAX_ATTEMPTS }, () => redeemCode(env, { id: c.id, purpose: 'sign-in', code: not(c.code), now: NOW + 1000 })));
    const results = await Promise.all(guesses);

    expect(await wrongGuesses()).toBe(LIMITS.wrongPerEmail.limit);
    expect(results.every((r) => !r.ok)).toBe(true);
    // Every guess past the limit was refused before it was compared with anything.
    expect(results.filter((r) => !r.ok && r.reason === 'limited').length).toBeGreaterThanOrEqual(guesses.length - LIMITS.wrongPerEmail.limit);
    expect(await pausedFor(env, 'sign-in', EMAIL, NOW + 1000)).toBeGreaterThan(0);

    // Paused means paused: the right code does not get through either.
    const right = await redeemCode(env, { id: codes[0]!.id, purpose: 'sign-in', code: codes[0]!.code, now: NOW + 2000 });
    expect(right).toMatchObject({ ok: false, reason: 'limited' });
  });

  it('says the address is paused on the guess that uses the last try, whichever code it was typed for', async () => {
    const a = await issueCode(env, { purpose: 'sign-in', email: EMAIL, now: NOW });
    const b = await issueCode(env, { purpose: 'sign-in', email: EMAIL, now: NOW });
    for (let i = 1; i <= 3; i++) {
      expect(await redeemCode(env, { id: a.id, purpose: 'sign-in', code: not(a.code), now: NOW + i })).toMatchObject({ reason: 'wrong', triesLeft: CODE_MAX_ATTEMPTS - i });
    }
    expect(await redeemCode(env, { id: b.id, purpose: 'sign-in', code: not(b.code), now: NOW + 10 })).toMatchObject({ reason: 'wrong', triesLeft: CODE_MAX_ATTEMPTS - 1 });
    const last = await redeemCode(env, { id: b.id, purpose: 'sign-in', code: not(b.code), now: NOW + 11 });
    expect(last).toMatchObject({ ok: false, reason: 'limited' });
    expect(!last.ok && last.retryAfter).toBeGreaterThan(0);
  });

  it('do not count against another address or another kind of code', async () => {
    const mine = await issueCode(env, { purpose: 'sign-in', email: EMAIL, now: NOW });
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) await redeemCode(env, { id: mine.id, purpose: 'sign-in', code: not(mine.code), now: NOW + i });

    const theirs = await issueCode(env, { purpose: 'sign-in', email: 'mel@example.com', now: NOW });
    expect(await redeemCode(env, { id: theirs.id, purpose: 'sign-in', code: theirs.code, now: NOW + 100 })).toMatchObject({ ok: true });
    const invite = await issueCode(env, { purpose: 'invite', email: EMAIL, now: NOW });
    expect(await redeemCode(env, { id: invite.id, purpose: 'invite', code: invite.code, now: NOW + 100 })).toMatchObject({ ok: true });
  });

  it('leave a right code its try: it is used once and counts as no wrong guess', async () => {
    const c = await issueCode(env, { purpose: 'sign-in', email: EMAIL, now: NOW });
    const [first, second] = await Promise.all([1, 2].map(() => redeemCode(env, { id: c.id, purpose: 'sign-in', code: c.code, now: NOW + 1 })));
    expect([first!.ok, second!.ok].filter(Boolean)).toHaveLength(1);
    expect(await wrongGuesses()).toBeLessThanOrEqual(1);
  });
});
