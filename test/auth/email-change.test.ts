import { beforeEach, describe, expect, it } from 'vitest';
import { CODE_MAX_ATTEMPTS, LIMITS } from '../../src/auth/config';
import { cancelEmailChange, confirmEmailChange, pendingEmailChange, startEmailChange } from '../../src/auth/service';
import { devOutbox } from '../../src/core/email';
import type { Env } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastCode, lastEmail, signInByCode, testApp } from './browser';
import { codeOf, must } from './harness';

const OLD = 'ada@example.com';
const NEW = 'ada@new.example.com';
const app = testApp();

let env: Env;
let ada: TestSession;
let b: Browser;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const emailOf = (userId: string) => env.DB.prepare('SELECT "email" FROM "user" WHERE "id" = ?1').bind(userId).first<string>('email');
const sentTo = async (to: string) => (await devOutbox(env, { to, limit: 20 })).length;
const makeStale = () => env.DB.prepare('UPDATE "session" SET "createdAt" = ?1').bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
/** A 6-digit code that is not the right one. */
const wrong = (right: string) => (right === '000000' ? '000001' : '000000');

beforeEach(async () => {
  env = createTestEnv().env;
  ada = await createTestSession(env, { email: OLD, name: 'Ada' });
  b = adopt(new Browser(app, env), ada.cookie);
});

describe('changing the email an account signs in with', () => {
  it('changes nothing until the new address proves itself with the code', async () => {
    const phone = await createTestSession(env, { email: OLD });
    const pending = await must(env, b, (c) => startEmailChange(c, { email: ' Ada@New.Example.com ' }));
    expect(pending.email).toBe(NEW);
    expect(await must(env, b, (c) => pendingEmailChange(c))).toEqual(pending);
    expect((await lastEmail(env, NEW))?.template).toBe('email-change');
    expect(await emailOf(ada.user.id)).toBe(OLD);

    const code = await lastCode(env, NEW);
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code: wrong(code) }))).toBe('auth.code_wrong');
    expect(await emailOf(ada.user.id)).toBe(OLD);

    expect(await must(env, b, (c) => confirmEmailChange(c, { code }))).toEqual({ email: NEW });
    expect(await emailOf(ada.user.id)).toBe(NEW);
    expect(await must(env, b, (c) => pendingEmailChange(c))).toBeNull();
    expect(await audits('user.email_changed')).toBe(1);

    // This device stays signed in, the others do not, and the old address hears about it.
    expect(await b.signedIn()).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', phone.sessionId)).toBe(0);
    const notice = await lastEmail(env, OLD);
    expect(notice?.subject).toContain('email address was changed');
    expect(notice?.text).toContain(NEW);

    // The code is spent, and the new address is now the one that signs in.
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code }))).toBe('auth.code_expired');
    const fresh = new Browser(app, env);
    expect((await signInByCode(fresh, env, NEW)).status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM "user"')).toBe(1);
  });

  it('gives a taken address the same answer, sends it nothing, and never applies', async () => {
    const bob = await createTestSession(env, { email: 'bob@example.com' });
    const before = await sentTo('bob@example.com');
    const pending = await must(env, b, (c) => startEmailChange(c, { email: 'bob@example.com' }));
    expect(pending.email).toBe('bob@example.com');
    expect(await must(env, b, (c) => pendingEmailChange(c))).toEqual(pending);
    expect(await sentTo('bob@example.com')).toBe(before);

    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code: '123456' }))).toBe('auth.code_wrong');
    expect(await emailOf(ada.user.id)).toBe(OLD);
    expect(await emailOf(bob.user.id)).toBe('bob@example.com');
  });

  it('refuses the address when someone took it after the code went out', async () => {
    await must(env, b, (c) => startEmailChange(c, { email: NEW }));
    const code = await lastCode(env, NEW);
    await createTestSession(env, { email: NEW });
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code }))).toBe('auth.email_taken');
    expect(await emailOf(ada.user.id)).toBe(OLD);
  });

  it('checks the address before anything is sent', async () => {
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: OLD }))).toBe('auth.email_same');
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: 'not an address' }))).toBe('validation_failed');
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: undefined as unknown as string }))).toBe('validation_failed');
    expect(await count(`SELECT COUNT(*) AS n FROM auth_codes WHERE purpose = 'email-change'`)).toBe(0);
  });

  it('lets a newer change replace the one that was waiting, and lets it be cancelled', async () => {
    await must(env, b, (c) => startEmailChange(c, { email: NEW }));
    const first = await lastCode(env, NEW);
    await must(env, b, (c) => startEmailChange(c, { email: 'ada@other.example.com' }));
    expect((await must(env, b, (c) => pendingEmailChange(c)))?.email).toBe('ada@other.example.com');
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code: first }))).toBe('auth.code_wrong');

    const second = await lastCode(env, 'ada@other.example.com');
    await must(env, b, (c) => cancelEmailChange(c));
    expect(await must(env, b, (c) => pendingEmailChange(c))).toBeNull();
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code: second }))).toBe('auth.code_expired');
    expect(await emailOf(ada.user.id)).toBe(OLD);
  });

  it('stops the code after too many wrong guesses', async () => {
    await must(env, b, (c) => startEmailChange(c, { email: NEW }));
    const code = await lastCode(env, NEW);
    const answers: string[] = [];
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) answers.push(await codeOf(env, b, (c) => confirmEmailChange(c, { code: wrong(code) })));
    expect(answers.slice(0, -1).every((a) => a === 'auth.code_wrong')).toBe(true);
    expect(answers.at(-1)).toBe('auth.code_limited');
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code }))).toBe('auth.code_limited');
    expect(await emailOf(ada.user.id)).toBe(OLD);
  });

  it('limits how many codes one address and one person can ask for', async () => {
    for (let i = 0; i < LIMITS.emailChangePerAddress.limit; i++) await must(env, b, (c) => startEmailChange(c, { email: NEW }));
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: NEW }))).toBe('rate_limited');
    expect(await sentTo(NEW)).toBe(LIMITS.emailChangePerAddress.limit);


    // The refused try counted for the person too.
    for (let i = LIMITS.emailChangePerAddress.limit + 1; i < LIMITS.emailChangePerUser.limit; i++) {
      await must(env, b, (c) => startEmailChange(c, { email: `ada${i}@new.example.com` }));
    }
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: 'ada-last@new.example.com' }))).toBe('rate_limited');
  });

  it('needs the person themselves and a recent sign-in', async () => {
    const anon = new Browser(app, env);
    expect(await codeOf(env, anon, (c) => startEmailChange(c, { email: NEW }))).toBe('unauthorized');
    expect(await codeOf(env, anon, (c) => confirmEmailChange(c, { code: '123456' }))).toBe('unauthorized');

    await must(env, b, (c) => startEmailChange(c, { email: NEW }));
    const code = await lastCode(env, NEW);
    const owner = await createTestSession(env, { email: 'install-owner@example.com', instanceOwner: true, orgId: 'org_install' });
    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1').bind(owner.user.id).run();
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: 'x@new.example.com' }))).toBe('auth.impersonating');
    expect(await codeOf(env, b, (c) => confirmEmailChange(c, { code }))).toBe('auth.impersonating');
    expect(await codeOf(env, b, (c) => cancelEmailChange(c))).toBe('auth.impersonating');

    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = NULL').run();
    await makeStale();
    expect(await codeOf(env, b, (c) => startEmailChange(c, { email: 'x@new.example.com' }))).toBe('auth.sign_in_again');
    expect(await emailOf(ada.user.id)).toBe(OLD);
  });

  it('cannot finish a change someone else started', async () => {
    await must(env, b, (c) => startEmailChange(c, { email: NEW }));
    const code = await lastCode(env, NEW);
    const bob = await createTestSession(env, { email: 'bob@example.com' });
    const asBob = adopt(new Browser(app, env), bob.cookie);
    expect(await must(env, asBob, (c) => pendingEmailChange(c))).toBeNull();
    expect(await codeOf(env, asBob, (c) => confirmEmailChange(c, { code }))).toBe('auth.code_expired');
    expect(await emailOf(bob.user.id)).toBe('bob@example.com');
  });
});
