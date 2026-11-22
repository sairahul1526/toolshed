/** Helpers for Mail's tests only. Nothing in the app imports this file. */
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { registerModules } from '../../core/registry';
import mailModule from './module';
import { createList } from './lists';
import { saveMailSettings } from './settings';
import type { Outgoing, SendResult, Sender } from './sender';
import { joinList } from './subscribers';
import { ctxOf, type Ctx, type List } from './types';

export const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** A sender that records what it was asked to send. `script` decides each outcome; `crashAfter` throws mid-batch. */
export class FakeSender implements Sender {
  sent: Outgoing[] = [];
  attempts: Outgoing[] = [];
  crashAfter: number | null = null;
  script: (m: Outgoing, n: number) => SendResult | undefined = () => undefined;
  /** When true, a crash happens after the message left but before the database was told (the worst case). */
  async send(m: Outgoing): Promise<SendResult> {
    this.attempts.push(m);
    if (this.crashAfter !== null && this.sent.length >= this.crashAfter) {
      this.crashAfter = null;
      throw new Error('process killed');
    }
    const scripted = this.script(m, this.attempts.length);
    if (scripted) return scripted;
    this.sent.push(m);
    return { ok: true, dev: false };
  }
  async alreadySent(_org: string, to: string, template: string): Promise<boolean> {
    return this.sent.some((m) => m.to === to && m.template === template);
  }
  to(): string[] {
    return this.sent.map((m) => m.to);
  }
}

export interface Fixture {
  t: TestEnv;
  ctx: Ctx;
  list: List;
  sender: FakeSender;
}

export async function fixture(opts: { doubleOptIn?: boolean; postal?: boolean } = {}): Promise<Fixture> {
  registerModules([mailModule]);
  const t = createTestEnv();
  const ctx = ctxOf(t.env, t.org.id);
  if (opts.postal !== false) await saveMailSettings(t.env, t.org.id, { postalAddress: '1 Example Street, Springfield' });
  const list = await createList(ctx, { name: 'The Weekly', slug: 'weekly', double_opt_in: opts.doubleOptIn ?? true }, T0);
  return { t, ctx, list, sender: new FakeSender() };
}

/** Add n active subscribers without a confirmation step. */
export async function addPeople(f: Fixture, n: number, prefix = 'p', now = T0): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const email = `${prefix}${i}@example.com`;
    await joinList(f.ctx, f.list, { email, name: `Person ${i}`, confirmed: true }, { base: 'http://localhost', sender: f.sender, now });
    out.push(email);
  }
  return out;
}
