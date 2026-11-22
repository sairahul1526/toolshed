/** Small request helpers shared by the API and the dashboard. */
import type { Context } from 'hono';
import { orgDb } from '../../core/db';
import { errors } from '../../core/errors';
import type { AppEnv } from '../../env';
import { publicSettings, type Actor, type Ctx, type Form } from './service';

export function ctxOf(c: Context<AppEnv>): Ctx {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return { env: c.env, db: orgDb(c.env.DB, org.id) };
}

export function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user');
  return { id: user?.id ?? c.get('auth').keyId ?? null, email: user?.email ?? null };
}

/** A form as the API and screens see it: the password hash never leaves the server. */
export function formView(form: Form) {
  return {
    id: form.id,
    slug: form.slug,
    name: form.name,
    status: form.status,
    settings: publicSettings(form.settings),
    responseCount: form.responseCount,
    lastResponseAt: form.lastResponseAt,
    rev: form.rev,
    sample: form.sample,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    publishedAt: form.publishedAt,
    trashedAt: form.trashedAt,
  };
}

export function intParam(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}
