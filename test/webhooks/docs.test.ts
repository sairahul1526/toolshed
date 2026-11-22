import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listErrorCodes } from '../../src/core/errors';
// Importing the service registers its error codes.
import '../../src/core/webhooks';

const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'webhooks.md'), 'utf8');

/** Rows of the form | `webhooks.code` | 409 | message | advice | */
function rowsOf(): Map<string, { status: number; message: string }> {
  const out = new Map<string, { status: number; message: string }>();
  for (const line of doc.split('\n')) {
    const m = line.match(/^\|\s*`(webhooks\.[a-z_]+)`\s*\|\s*(\d{3})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (m) out.set(m[1]!, { status: Number(m[2]), message: m[3]! });
  }
  return out;
}

describe('docs/webhooks.md', () => {
  const rows = rowsOf();
  const codes = listErrorCodes().filter((c) => c.code.startsWith('webhooks.'));

  it('lists every webhooks error code with its status and message', () => {
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) {
      expect(rows.get(c.code), `Add ${c.code} to docs/webhooks.md`).toEqual({ status: c.status, message: c.message });
    }
  });

  it('has no rows for codes that no longer exist', () => {
    const known = new Set(codes.map((c) => c.code));
    expect([...rows.keys()].filter((code) => !known.has(code))).toEqual([]);
  });

  it('keeps the numbers it quotes in step with the code', async () => {
    const t = await import('../../src/core/webhooks/types');
    expect(t.MAX_ENDPOINTS).toBe(20);
    expect(t.MAX_HEADERS).toBe(10);
    expect(t.MAX_BODY_BYTES).toBe(256 * 1024);
    expect(t.TIMEOUT_MS).toBe(10_000);
    expect(t.MAX_RESPONSE_BYTES).toBe(64 * 1024);
    expect(t.SNIPPET_BYTES).toBe(2048);
    expect(t.RETRY_DELAYS_SECONDS).toEqual([30, 120, 600, 3600, 21600, 86400]);
    expect(t.MAX_ATTEMPTS).toBe(7);
    expect(t.DELIVERY_KEEP_DAYS).toBe(30);
    expect(t.AUTO_DISABLE_AFTER_MS).toBe(72 * 3600 * 1000);
    expect(t.SECRET_OVERLAP_MS).toBe(24 * 3600 * 1000);
    expect(doc).toContain('| Endpoints per workspace | 20 |');
    expect(doc).toContain('| Message size | 256 KB');
  });

  it('writes plain English: no em dashes or emoji', () => {
    expect(doc).not.toMatch(/—/);
    expect(doc).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
