import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { errors } from '../../core/errors';
import { baseUrl } from '../../core/net';
import { enforceRateLimit } from '../../core/ratelimit';
import type { LinksCtx } from './types';

/** The workspace, address and person behind a signed-in request. */
export function ctxOf(c: Context<AppEnv>): LinksCtx {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return { env: c.env, orgId: org.id, base: baseUrl(c), actorId: c.get('user')?.id ?? c.get('auth').keyId ?? null };
}

/** 120 new links a minute per workspace is far above normal use and far below abuse. */
export function limitCreate(c: Context<AppEnv>, weight = 1): Promise<void> {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return enforceRateLimit(c.env, `links:create:${org.id}`, { limit: 120 / weight, windowSec: 60 }, 'You are creating links very fast. Wait a moment and try again.');
}
