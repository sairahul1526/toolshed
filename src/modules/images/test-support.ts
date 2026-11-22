/** Test helpers: the bundled fonts read from disk, the way the assets binding serves them. */
import { readFile } from 'node:fs/promises';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { orgDb, type OrgDb } from '../../core/db';
import type { Env } from '../../env';
import images from './module';
import { setWasmSource } from './png';
import { createTemplate, type Template } from './templates';

const assets = {
  async fetch(input: RequestInfo | URL): Promise<Response> {
    const path = decodeURIComponent(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname);
    if (path.includes('..')) return new Response('Not found', { status: 404 });
    try {
      return new Response(await readFile(`public${path}`));
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
} as unknown as Fetcher;

/** A test workspace whose `ASSETS` binding serves `public/`, and a PNG renderer that works in Node. */
export function imagesTestEnv(vars: Partial<Env> = {}): TestEnv {
  setWasmSource(() => readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm'));
  return createTestEnv({ ASSETS: assets, ...vars });
}

/** A valid 1x1 PNG, or one that claims another size in its header (the pixels are not checked). */
export function tinyPng(width = 1, height = 1): Uint8Array {
  const bytes = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
    (ch) => ch.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export interface Mounted {
  t: TestEnv;
  /** An admin of the test workspace. */
  app: MountedModule;
  /** Someone who is not signed in. */
  visitor: MountedModule;
  db: OrgDb;
}

/** The module turned on for the test workspace, ready to call. */
export async function mounted(vars: Partial<Env> = {}): Promise<Mounted> {
  const t = imagesTestEnv(vars);
  const app = await mountModule(t, images);
  return { t, app, visitor: app.as({ kind: 'anon' }), db: orgDb(t.env.DB, t.org.id) };
}

/** A published copy of the blog starter. */
export function blogTemplate(m: Mounted, now = Date.now()): Promise<Template> {
  return createTemplate(m.t.env, m.db, { starter: 'blog', publish: true }, {}, now);
}

/** The path and query of a full URL, which is what the test app is called with. */
export function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}
