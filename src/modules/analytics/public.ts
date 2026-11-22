/**
 * The endpoints a visitor's browser talks to. They answer before any work is done, never set a
 * cookie, and never tell the browser whether the hit was kept: a refused hit is counted for the
 * site's data health panel instead.
 *
 *   POST /a/e       one hit as a small JSON text body (what `navigator.sendBeacon` sends)
 *   GET  /a/p.gif   a page view for pages where scripts cannot run
 *
 * Public dashboards (/a/share/...) are mounted here too; see share.tsx.
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../env';
import { collect, type HitInput, type HitKind } from './ingest';
import share from './share';

/** A real hit is a few hundred bytes. Anything much larger is not from the script. */
const MAX_BODY = 8192;
const MAX_URL = 2000;

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));

const CORS = { 'access-control-allow-origin': '*' };

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** Run `work` after the response has gone out. Where there is nothing to wait with (some tests), run it now. */
function later(c: Context<AppEnv>, work: Promise<unknown>): Promise<unknown> | void {
  const quiet = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(quiet);
  } catch {
    return quiet;
  }
}

/** The body as text, or null when it is longer than a hit can be. Stops reading at the limit instead of buffering it all. */
async function cappedText(req: Request): Promise<string | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const bytes = new Uint8Array(MAX_BODY);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    bytes.set(value, size);
    size += value.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, size));
}

function read(raw: string | null): HitInput | null {
  if (!raw) return null;
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const key = text(o.k, 64);
  const url = text(o.u, MAX_URL);
  if (!key || !url || (o.t !== 'p' && o.t !== 'e' && o.t !== 'g')) return null;
  return {
    key,
    kind: o.t as HitKind,
    name: text(o.n, 400),
    url,
    referrer: text(o.r, MAX_URL),
    props: o.p,
    engagedMs: typeof o.e === 'number' ? o.e : 0,
    hash: o.h === 1 || o.h === true,
  };
}

const app = new Hono<AppEnv>();

app.options('/a/e', (c) =>
  c.body(null, 204, { ...CORS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }),
);

app.post('/a/e', async (c) => {
  const input = read(await cappedText(c.req.raw).catch(() => null));
  if (input) await later(c, collect(c.env, input, { req: c.req.raw }));
  return c.body(null, 202, CORS);
});

app.get('/a/p.gif', async (c) => {
  const key = text(c.req.query('k'), 64);
  // Without a script the page's address comes from the Referer header of the image request.
  const url = text(c.req.query('u'), MAX_URL) ?? text(c.req.header('referer'), MAX_URL);
  if (key && url) await later(c, collect(c.env, { key, kind: 'p', url, referrer: text(c.req.query('r'), MAX_URL) }, { req: c.req.raw }));
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'content-length': String(GIF.byteLength), 'cache-control': 'no-store, max-age=0', ...CORS } });
});

app.route('/', share);

export default app;
