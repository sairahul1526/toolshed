import { describe, expect, it, vi } from 'vitest';
import { deliver } from '../../src/modules/monitor/alerts';
import { createChannel } from '../../src/modules/monitor/channels';
import { runCheck } from '../../src/modules/monitor/checks';
import type { ChannelRow } from '../../src/modules/monitor/schema';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, useModule } from './helpers';

useModule();

const base = { url: 'https://example.com/', method: 'GET', headers: '{}', body: null, expected_status: '200-299', keyword: null, keyword_mode: 'none', timeout_ms: 5000, follow_redirects: 1 } as const;
const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

/** example.com answers with `reply`; anything else is recorded and answers 200. */
function stubNet(reply: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => (new URL(String(input)).hostname === 'example.com' ? reply() : new Response('should not get here'))),
  );
}

describe('outbound requests go through the core network helper', () => {
  for (const target of ['http://169.254.169.254/', 'http://127.0.0.1/admin']) {
    it(`fails a check that redirects to ${target} without making that request`, async () => {
      stubNet(() => new Response(null, { status: 302, headers: { location: target } }));
      const res = await runCheck({ ...base });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not allowed|unsafe/i);
      expect(calls()).toEqual(['https://example.com/']);
    });
  }

  it('reports the redirect itself when following is off', async () => {
    stubNet(() => new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }));
    const res = await runCheck({ ...base, follow_redirects: 0 });
    expect(res.code).toBe(302);
    expect(calls()).toEqual(['https://example.com/']);
  });

  it('caps how much of the answer it reads', async () => {
    const big = `${'a'.repeat(600 * 1024)}NEEDLE`;
    stubNet(() => new Response(big, { status: 200 }));
    const res = await runCheck({ ...base, keyword: 'NEEDLE', keyword_mode: 'present' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it('refuses a private alert webhook at save', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    for (const url of ['http://127.0.0.1/hook', 'https://169.254.169.254/x', 'http://localhost:8080/']) {
      await expect(createChannel(ctx, { name: 'Bad', kind: 'webhook', config: { url } })).rejects.toMatchObject({ status: 422 });
    }
  });

  it('refuses a private alert webhook at send, with no request made', async () => {
    const t = createTestEnv();
    stubNet(() => new Response('ok'));
    const channel = { id: 'c1', org_id: t.org.id, name: 'Old', kind: 'webhook', config: JSON.stringify({ url: 'http://10.0.0.5/hook' }), enabled: 1, notify_recovery: 1, notify_slow: 0, repeat_min: 0, quiet_from: null, quiet_to: null, created_at: 0, updated_at: 0 } as ChannelRow;
    const res = await deliver(t.env, t.org.id, channel, { kind: 'test', monitor: { id: 'm', name: 'M', type: 'http', url: 'https://example.com' }, at: 0 });
    expect(res.ok).toBe(false);
    expect(calls()).toEqual([]);
  });
});
