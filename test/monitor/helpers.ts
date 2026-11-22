import { afterEach, beforeEach, vi } from 'vitest';
import { registerModules } from '../../src/core/registry';
import monitor from '../../src/modules/monitor/module';
import { moduleContext } from '../../src/core/registry';
import { runnerConfig } from '../../src/modules/monitor/runner';
import type { TestEnv } from '../helpers/d1';

export const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
export const MIN = 60_000;

/** Turn the one-and-a-half second second look off so tests run fast. */
runnerConfig.confirmDelayMs = 0;

export const ctxOf = (t: TestEnv) => moduleContext(t.env, t.org.id);

export interface FakeSite {
  status: number;
  body: string;
  fail: boolean;
  calls: string[];
}

/** Stand in for the network. Every call to any address answers with what `site` says. */
export function fakeSite(init: Partial<FakeSite> = {}): FakeSite {
  const site: FakeSite = { status: 200, body: 'ok', fail: false, calls: [], ...init };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Only the monitored site misbehaves; webhooks and chat services answer normally.
      if (new URL(url).hostname !== 'example.com') return new Response('ok');
      site.calls.push(url);
      if (site.fail) throw new Error('connect failed');
      return new Response(site.body, { status: site.status });
    }),
  );
  return site;
}

/** Register the module the way the app does, so queued jobs find their handlers. Call once at the top of a test file. */
export function useModule(): void {
  beforeEach(() => registerModules([monitor]));
  afterEach(() => {
    registerModules([]);
    vi.unstubAllGlobals();
  });
}
