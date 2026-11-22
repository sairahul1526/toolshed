/** The workspace behind a signed-in request, and the public address of the install. */
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { errors } from '../../core/errors';
import { baseUrl } from '../../core/net';
import { getMailSettings, saveMailSettings } from './settings';
import { ctxOf, type Ctx } from './types';

export function reqCtx(c: Context<AppEnv>): Ctx {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return ctxOf(c.env, org.id);
}

/** Remember the address people use, so jobs (which have no request) can build links in emails. */
export async function rememberBase(c: Context<AppEnv>): Promise<string> {
  const base = baseUrl(c);
  const org = c.get('org');
  if (org && !c.env.APP_URL?.trim()) {
    const s = await getMailSettings(c.env, org.id);
    if (s.baseUrl !== base) await saveMailSettings(c.env, org.id, { baseUrl: base });
  }
  return base;
}
