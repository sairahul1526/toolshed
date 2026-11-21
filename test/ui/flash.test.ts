import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { setFlash, takeFlash } from '../../src/ui/flash';

const app = new Hono();
app.get('/set', (c) => {
  setFlash(c, { kind: 'ok', message: 'Saved.' });
  return c.text('ok');
});
app.get('/take', (c) => c.json({ flash: takeFlash(c) }));

describe('flash', () => {
  it('sets a short-lived HttpOnly cookie', async () => {
    const res = await app.request('http://x.example.com/set');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ts_flash=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=60');
  });
  it('reads it once and clears it', async () => {
    const value = encodeURIComponent(JSON.stringify({ kind: 'error', message: 'Nope' }));
    const res = await app.request('http://x.example.com/take', { headers: { cookie: `ts_flash=${value}` } });
    expect(await res.json()).toEqual({ flash: { kind: 'error', message: 'Nope' } });
    expect(res.headers.get('set-cookie')).toContain('ts_flash=;');
  });
  it('drops malformed values', async () => {
    for (const bad of ['%7Bnot json', encodeURIComponent('{"kind":"x","message":"a"}'), encodeURIComponent('[]')]) {
      const res = await app.request('http://x.example.com/take', { headers: { cookie: `ts_flash=${bad}` } });
      expect(await res.json()).toEqual({ flash: null });
    }
  });
});
