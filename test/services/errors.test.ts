import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Importing the services registers the codes they define.
import '../../src/core/audit';
import '../../src/core/email';
import '../../src/core/export';
import '../../src/core/net';
import '../../src/core/notifications';
import { Hono } from 'hono';
import { defineErrors, errors, listErrorCodes, parse } from '../../src/core/errors';
import type { AppEnv } from '../../src/env';
import errorRoutes from '../../src/core/routes/errors';
import { createTestEnv } from '../helpers/d1';
import { routeApp } from './helpers';
import { z } from 'zod';

const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'errors.md'), 'utf8');

/** Rows of the form | `code` | 404 | message | advice | */
function docRows(): Map<string, { status: number; message: string; advice: string }> {
  const rows = new Map<string, { status: number; message: string; advice: string }>();
  for (const line of doc.split('\n')) {
    const m = line.match(/^\|\s*`([a-z_.]+)`\s*\|\s*(\d{3})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (m) rows.set(m[1]!, { status: Number(m[2]), message: m[3]!, advice: m[4]! });
  }
  return rows;
}

describe('docs/errors.md', () => {
  const rows = docRows();

  it('lists every registered code with its status and message', () => {
    const missing = listErrorCodes().filter((c) => !rows.has(c.code)).map((c) => c.code);
    expect(missing, `Add these codes to docs/errors.md: ${missing.join(', ')}`).toEqual([]);
    for (const c of listErrorCodes()) {
      const row = rows.get(c.code)!;
      expect(row.status, `${c.code} status`).toBe(c.status);
      expect(row.message, `${c.code} message`).toBe(c.message);
      expect(row.advice.length, `${c.code} needs advice`).toBeGreaterThan(20);
    }
  });

  it('has no rows for codes that no longer exist', () => {
    const known = new Set(listErrorCodes().map((c) => c.code));
    const stale = [...rows.keys()].filter((code) => !known.has(code));
    expect(stale).toEqual([]);
  });

  it('covers every core code the app defines', () => {
    const core = ['bad_request', 'validation_failed', 'unauthorized', 'forbidden', 'not_found', 'method_not_allowed', 'conflict', 'too_large', 'rate_limited', 'module_off', 'needs_setup', 'internal'];
    for (const code of core) expect(rows.has(code), code).toBe(true);
  });

  it('writes plain English: no em dashes, emoji or exclamation marks', () => {
    expect(doc).not.toMatch(/—/);
    expect(doc).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(doc).not.toMatch(/!/);
  });
});

describe('error codes', () => {
  it('are unique, sorted and shaped like <module>.<key> or a bare core name', () => {
    const codes = listErrorCodes().map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
    for (const code of codes) expect(code).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
  });

  it('use real HTTP error statuses', () => {
    for (const c of listErrorCodes()) {
      expect(c.status).toBeGreaterThanOrEqual(400);
      expect(c.status).toBeLessThan(600);
    }
  });

  it('refuse to register one code twice', () => {
    expect(() => defineErrors('export', { failed: { status: 409, message: 'again' } })).toThrow('registered twice');
  });

  it('turn into the documented JSON body', async () => {
    const t = createTestEnv();
    const routes = new Hono<AppEnv>();
    routes.get('/missing', () => {
      throw errors.not_found('No link with that name.');
    });
    routes.post('/check', async (c) => {
      parse(z.object({ name: z.string().min(1, 'Add a name.') }), await c.req.json());
      return c.json({ ok: true });
    });
    routes.get('/boom', () => {
      throw new Error('secret detail');
    });
    const app = routeApp(routes, t);
    expect(await app.json('/missing')).toMatchObject({ status: 404, body: { code: 'not_found', message: 'No link with that name.', requestId: 'req_test' } });
    const bad = await app.json('/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) });
    expect(bad).toMatchObject({ status: 422, body: { code: 'validation_failed', fields: { name: 'Add a name.' } } });
    const boom = await app.json('/boom');
    expect(boom.status).toBe(500);
    expect(boom.body.code).toBe('internal');
    expect(JSON.stringify(boom.body)).not.toContain('secret detail');
  });
});

describe('GET /api/v1/errors', () => {
  it('answers without signing in, with the same list as the code', async () => {
    const t = createTestEnv();
    const app = routeApp(errorRoutes.public!, t, { kind: 'anon', role: null });
    const res = await app.json('/api/v1/errors');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(listErrorCodes());
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const codes = res.body.items.map((i: { code: string }) => i.code);
    expect(codes).toContain('not_found');
    expect(codes).toContain('export.expired');
  });

  it('has no sign-in routes of its own', () => {
    expect((errorRoutes as { api?: unknown }).api).toBeUndefined();
  });
});
