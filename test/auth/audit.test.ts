/**
 * The account trail as a whole: who did it, from where, and that no secret ever lands in it.
 * Each action is also asserted beside the feature that writes it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  changeName,
  confirmEmailChange,
  confirmTwoStep,
  regenerateRecoveryCodes,
  removePassword,
  revokeOtherSessions,
  setPassword,
  setUsername,
  startEmailChange,
  startImpersonation,
  startTwoStep,
  stopImpersonation,
  turnOffTwoStep,
} from '../../src/auth/service';
import type { Env } from '../../src/env';
import { totp } from '../e2e/helpers/totp';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastCode, signInByCode, testApp } from './browser';
import { must } from './harness';

const PASSWORD = 'correct horse battery';
const app = testApp();

let env: Env;
let olive: TestSession;
let mel: TestSession;

interface Line {
  action: string;
  org_id: string | null;
  actor_id: string | null;
  actor_label: string | null;
  target_id: string | null;
  summary: string | null;
  meta: string | null;
  ip: string | null;
}
const trail = async () => (await env.DB.prepare('SELECT action, org_id, actor_id, actor_label, target_id, summary, meta, ip FROM audit_log ORDER BY created_at, id').all<Line>()).results;

beforeEach(async () => {
  env = createTestEnv().env;
  olive = await createTestSession(env, { email: 'olive@example.com', name: 'Olive', instanceOwner: true });
  mel = await createTestSession(env, { email: 'mel@example.com', name: 'Mel', role: 'member' });
});

describe('the account trail', () => {
  it('has a line for every change to how an account signs in, with who and from where', async () => {
    const b = adopt(new Browser(app, env, '198.51.100.44'), mel.cookie);
    await createTestSession(env, { email: mel.user.email });

    await must(env, b, (c) => changeName(c, { name: 'Melanie' }));
    await must(env, b, (c) => revokeOtherSessions(c));
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    await must(env, b, (c) => setPassword(c, { password: `${PASSWORD} two` }));
    await must(env, b, (c) => setUsername(c, { username: 'mel' }));
    const setup = await must(env, b, (c) => startTwoStep(c, { password: `${PASSWORD} two` }));
    await must(env, b, (c) => confirmTwoStep(c, { code: totp(setup.secret) }));
    const codes = await must(env, b, (c) => regenerateRecoveryCodes(c, { password: `${PASSWORD} two` }));
    await must(env, b, (c) => turnOffTwoStep(c, { password: `${PASSWORD} two` }));
    await must(env, b, (c) => removePassword(c));
    await must(env, b, (c) => startEmailChange(c, { email: 'mel@new.example.com' }));
    const emailCode = await lastCode(env, 'mel@new.example.com');
    await must(env, b, (c) => confirmEmailChange(c, { code: emailCode }));

    const lines = await trail();
    expect(lines.map((l) => l.action)).toEqual([
      'user.renamed',
      'session.revoked_others',
      'password.added',
      'password.changed',
      'username.changed',
      'two_step.turned_on',
      'two_step.codes_regenerated',
      'two_step.turned_off',
      'password.removed',
      'user.email_changed',
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ actor_id: mel.user.id, target_id: mel.user.id, ip: '198.51.100.44', org_id: null });
      expect(line.summary).toBeTruthy();
    }

    // Nothing that could sign anyone in is ever written down.
    const everything = JSON.stringify(lines);
    for (const secret of [PASSWORD, setup.secret, emailCode, ...setup.recoveryCodes, ...codes]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('records signing in and out, and names the owner behind a "sign in as" session', async () => {
    const b = new Browser(app, env, '198.51.100.45');
    await signInByCode(b, env, mel.user.email);
    const signInCode = await lastCode(env, mel.user.email);
    await b.post('/sign-out');

    const asOlive = adopt(new Browser(app, env, '198.51.100.46'), olive.cookie);
    await must(env, asOlive, (c) => startImpersonation(c, mel.user.id));
    await must(env, asOlive, (c) => stopImpersonation(c));

    const lines = await trail();
    expect(lines.map((l) => [l.action, l.actor_id, l.target_id, l.ip])).toEqual([
      ['user.signed_in', mel.user.id, mel.user.id, '198.51.100.45'],
      ['user.signed_out', mel.user.id, mel.user.id, '198.51.100.45'],
      ['impersonation.started', olive.user.id, mel.user.id, '198.51.100.46'],
      ['impersonation.stopped', olive.user.id, mel.user.id, '198.51.100.46'],
    ]);
    expect(lines.find((l) => l.action === 'impersonation.stopped')?.actor_label).toBe('olive@example.com');
    expect(JSON.stringify(lines)).not.toContain(signInCode);
    const tokens = (await env.DB.prepare('SELECT "token" FROM "session"').all<{ token: string }>()).results;
    for (const { token } of tokens) expect(JSON.stringify(lines)).not.toContain(token);
  });
});
