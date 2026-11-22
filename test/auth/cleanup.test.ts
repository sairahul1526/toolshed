import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupAuth } from '../../src/auth/cleanup';
import { issueCode } from '../../src/auth/codes';
import { CODE_TTL_MS } from '../../src/auth/config';
import { runSchedules } from '../../src/core/jobs';
import type { Env } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { Browser, signInByCode, testApp } from './browser';

const app = testApp();
const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'ada@example.com';

let env: Env;

const count = async (sql: string) => Number(await env.DB.prepare(sql).first<number>('n'));
const sessions = () => count('SELECT COUNT(*) AS n FROM "session"');

beforeEach(() => {
  env = createTestEnv().env;
});

describe('the daily clean-up', () => {
  it('drops codes a day after they end and keeps the rest', async () => {
    const now = Date.now();
    await issueCode(env, { purpose: 'sign-in', email: EMAIL, now: now - DAY - CODE_TTL_MS - 1000 });
    const recent = await issueCode(env, { purpose: 'sign-in', email: EMAIL, now: now - DAY });
    const live = await issueCode(env, { purpose: 'sign-in', email: EMAIL, now });

    await cleanupAuth(env, now);
    const left = await env.DB.prepare('SELECT id FROM auth_codes ORDER BY created_at').all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual([recent.id, live.id]);
  });

  it('drops sessions that ran out and leaves a signed-in person signed in', async () => {
    await createTestSession(env, { email: EMAIL, instanceOwner: true });
    const b = new Browser(app, env);
    await signInByCode(b, env, EMAIL);
    // The clean-up compares text, so the format Better Auth writes is part of the contract.
    const stored = await env.DB.prepare('SELECT "expiresAt" AS at FROM "session" ORDER BY "createdAt" DESC').first<string>('at');
    expect(stored).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    const gone = await createTestSession(env, { email: EMAIL });
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ?1 WHERE "id" = ?2').bind(new Date(Date.now() - 1000).toISOString(), gone.sessionId).run();
    const before = await sessions();

    await cleanupAuth(env);
    expect(await sessions()).toBe(before - 1);
    expect(await count(`SELECT COUNT(*) AS n FROM "session" WHERE "id" = '${gone.sessionId}'`)).toBe(0);
    // The sign-in page sends a signed-in person on.
    expect((await b.get('/sign-in')).headers.get('location')).toBe('/app');
  });

  it('drops verification rows that ran out', async () => {
    const insert = 'INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, ?5, ?5)';
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(insert).bind('ver_old', 'old', 'x', new Date(now - 1000).toISOString(), new Date(now - 60_000).toISOString()),
      env.DB.prepare(insert).bind('ver_new', 'new', 'x', new Date(now + 60_000).toISOString(), new Date(now).toISOString()),
    ]);
    await cleanupAuth(env, now);
    const left = await env.DB.prepare('SELECT "id" AS id FROM "verification"').all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual(['ver_new']);
  });

  it('runs once a day with the other housekeeping', async () => {
    expect((await runSchedules(env, new Date('2026-01-02T00:00:00Z'))).ran).toContain('core.auth-cleanup');
    expect((await runSchedules(env, new Date('2026-01-02T00:01:00Z'))).ran).not.toContain('core.auth-cleanup');
  });
});
