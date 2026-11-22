/** Helpers shared by the admin screens. */
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { setFlash } from '../../../ui';
import { apiCtx } from '../api';
import { errorText } from '../pub/kit';
import { getPortal, type Ctx } from '../portal';
import type { Portal } from '../types';

export const A = '/app/feedback';

export interface Admin {
  c: Context<AppEnv>;
  ctx: Ctx;
  portal: Portal | null;
}

export async function loadAdmin(c: Context<AppEnv>): Promise<Admin> {
  const ctx = apiCtx(c);
  return { c, ctx, portal: await getPortal(ctx) };
}

export function publicUrl(c: Context<AppEnv>, portal: Portal, path = ''): string {
  return `${new URL(c.req.url).origin}/feedback/${portal.slug}${path}`;
}

/** Flash a message and go back. */
export function done(c: Context<AppEnv>, to: string, message: string) {
  setFlash(c, { kind: 'ok', message });
  return c.redirect(to);
}

export function fail(c: Context<AppEnv>, to: string, e: unknown) {
  setFlash(c, { kind: 'error', message: errorText(e).message });
  return c.redirect(to);
}

export function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

export function flag(body: Record<string, unknown>, key: string): boolean {
  return body[key] === 'on' || body[key] === '1';
}

export function tone(t: string | null | undefined): 'neutral' | 'good' | 'warn' | 'bad' | 'solid' {
  return t === 'good' || t === 'warn' || t === 'bad' || t === 'solid' ? t : 'neutral';
}

export function dateTimeLocal(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 16) : '';
}
