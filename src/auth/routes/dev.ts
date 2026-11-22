/**
 * JSON doors to the account service, for end-to-end tests that need a workspace, a member, a
 * password or two-step sign-in without clicking through a screen. Dev and test mode only: anywhere else every path here
 * answers 404, the same as `/dev/outbox`. Each door runs the real service function with the
 * caller's own session, so every permission rule still applies, and no door can make someone
 * the owner of the install.
 */
import { Hono, type Context } from 'hono';
import { errors } from '../../core/errors';
import { sameOrigin } from '../../core/guards';
import type { AppEnv } from '../../env';
import { isDev } from '../../env';
import {
  changeMemberRole,
  confirmTwoStep,
  createWorkspace,
  getAccount,
  inviteMember,
  listInvites,
  listMembers,
  listPasskeys,
  listWorkspaces,
  removeMember,
  setPassword,
  startTwoStep,
  switchWorkspace,
} from '../service';

type Door = (c: Context<AppEnv>, body: Record<string, unknown>) => Promise<unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const doors: Record<string, Door> = {
  'list-workspaces': (c) => listWorkspaces(c),
  'create-workspace': (c, body) => createWorkspace(c, { name: text(body.name), slug: text(body.slug) || null }),
  'switch-workspace': (c, body) => switchWorkspace(c, text(body.workspaceId)),
  'list-members': (c) => listMembers(c),
  'list-invites': (c) => listInvites(c),
  invite: (c, body) => inviteMember(c, { email: text(body.email), role: text(body.role) }),
  'change-role': (c, body) => changeMemberRole(c, text(body.userId), text(body.role)),
  'remove-member': (c, body) => removeMember(c, text(body.userId)),
  account: (c) => getAccount(c),
  'set-password': (c, body) => setPassword(c, { password: text(body.password) }),
  'start-two-step': (c, body) => startTwoStep(c, text(body.password) ? { password: text(body.password) } : {}),
  'confirm-two-step': (c, body) => confirmTwoStep(c, { code: text(body.code) }),
  'list-passkeys': (c) => listPasskeys(c),
};

export const devAuthRoutes = new Hono<AppEnv>();

devAuthRoutes.use('/dev/auth/*', async (c, next) => {
  if (!isDev(c.env)) throw errors.not_found();
  await next();
});
devAuthRoutes.use('/dev/auth/*', sameOrigin);

devAuthRoutes.post('/dev/auth/:door', async (c) => {
  const door = Object.hasOwn(doors, c.req.param('door')) ? doors[c.req.param('door')] : undefined;
  if (!door) throw errors.not_found();
  const body: unknown = await c.req.json().catch(() => ({}));
  const result = await door(c, body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {});
  return c.json({ result: result ?? null });
});
