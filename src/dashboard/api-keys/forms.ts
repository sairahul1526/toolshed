/**
 * Reading the forms on this screen, and turning a service's refusal into messages next to the
 * right field. The services check every value again, so nothing here is the only line of defence.
 */
import { z } from 'zod';
import { capRole, KEY_ROLES, listScopes, MAX_SCOPES } from '../../core/apikeys';
import type { CreateKeyInput, KeyActor, KeyRole } from '../../core/apikeys';
import { randomToken } from '../../core/db';
import { AppError, parse } from '../../core/errors';
import type { FieldErrors } from '../../core/errors';
import { rateLimit } from '../../core/ratelimit';
import { allModules } from '../../core/registry';
import type { Env } from '../../env';
import { roleAtLeast } from '../../env';

type Body = Record<string, string | File | (string | File)[]>;

/** The first text value sent under `name`, or an empty string. Files are never read. */
export function textField(body: Body, name: string): string {
  const value = body[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

export function listField(body: Body, name: string): string[] {
  const value = body[name];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v): v is string => typeof v === 'string');
}

/* ---------- Make a key ---------- */

export const EXPIRY_CHOICES = [
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
  { value: '365', label: 'In 1 year' },
  { value: 'never', label: 'Never' },
];

export interface NewKeyValues {
  name: string;
  /** A service account id, or an empty string for a key that acts as the person making it. */
  account: string;
  role: string;
  scopes: string[];
  expires: string;
}

export function emptyKeyValues(account = ''): NewKeyValues {
  return { name: '', account, role: 'member', scopes: [], expires: '90' };
}

export function readKeyValues(body: Body): NewKeyValues {
  return {
    name: textField(body, 'name'),
    account: textField(body, 'account'),
    role: textField(body, 'role'),
    scopes: listField(body, 'scopes'),
    expires: textField(body, 'expires'),
  };
}

const TOKEN = /^\d{1,6}\.[A-Za-z0-9_-]{16,64}$/;

const keyFormSchema = z.object({
  name: z.string().max(200, 'Keep the name under 80 characters.'),
  account: z.string().max(64, 'That service account doesn’t exist.'),
  role: z.enum(KEY_ROLES, 'Pick Admin, Member or Viewer.'),
  expires: z.enum(['30', '90', '365', 'never'], 'Pick when the key should stop working.'),
  scopes: z.array(z.string().max(100, 'That permission name is too long.')).max(MAX_SCOPES, `Pick at most ${MAX_SCOPES} permissions, or use full access.`),
});

/** What `createApiKey` takes. A key for a service account uses the account's role, so none is sent. */
export function toCreateInput(values: NewKeyValues): CreateKeyInput {
  const data = parse(keyFormSchema, values);
  return {
    name: data.name,
    scopes: data.scopes,
    ...(data.account ? { serviceAccountId: data.account } : { role: data.role }),
    expiresInDays: data.expires === 'never' ? null : Number(data.expires),
  };
}

export function allowedRoles(actor: KeyActor): KeyRole[] {
  return KEY_ROLES.filter((role) => roleAtLeast(capRole(actor.role), role));
}

/* ---------- Service accounts ---------- */

export interface AccountValues {
  name: string;
  role: string;
}

export function readAccountValues(body: Body): AccountValues {
  return { name: textField(body, 'name'), role: textField(body, 'role') };
}

const accountFormSchema = z.object({
  name: z.string().max(200, 'Keep the name under 80 characters.'),
  role: z.enum(KEY_ROLES, 'Pick Admin, Member or Viewer.'),
});

export function toAccountInput(values: AccountValues): { name: string; role: KeyRole } {
  return parse(accountFormSchema, values);
}

/* ---------- One-time form token ---------- */

const TOKEN_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * A token for the make-a-key form. The service cannot tell a refresh of the page that showed
 * the secret from a second request, so the form carries a token that works once: the first post
 * claims it, a repeat finds it spent and makes no second key. It lives for the UTC day it was
 * issued, which is also the window the claim is counted in.
 */
export function newFormToken(now = Date.now()): string {
  return `${Math.floor(now / (TOKEN_WINDOW_SECONDS * 1000))}.${randomToken(18)}`;
}

export type TokenClaim = 'claimed' | 'spent' | 'invalid';

export async function claimFormToken(env: Env, token: string, now = Date.now()): Promise<TokenClaim> {
  if (!TOKEN.test(token) || Number(token.split('.')[0]) !== Math.floor(now / (TOKEN_WINDOW_SECONDS * 1000))) return 'invalid';
  const claim = await rateLimit(env, `apikeys.form:${token}`, { limit: 1, windowSec: TOKEN_WINDOW_SECONDS }, now);
  return claim.ok ? 'claimed' : 'spent';
}

/* ---------- Permissions ---------- */

export interface ScopeGroup {
  module: string;
  name: string;
  scopes: { scope: string; label: string }[];
}

/** What a key can be allowed to do, one group per module, in module order. */
export function scopeGroups(): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const s of listScopes()) {
    let group = groups.get(s.module);
    if (!group) {
      group = { module: s.module, name: allModules().find((m) => m.id === s.module)?.name ?? s.module, scopes: [] };
      groups.set(s.module, group);
    }
    group.scopes.push({ scope: s.scope, label: s.label });
  }
  return [...groups.values()];
}

/** A request that the new key can make, so the example works the moment it is pasted. */
export function curlExample(origin: string, secret: string, scopes: string[], role: KeyRole): string {
  const named = scopes.find((s) => s !== '*')?.split(':')[0];
  const path = named ?? (role === 'admin' ? 'keys' : (listScopes()[0]?.module ?? 'keys'));
  return `curl ${origin}/api/v1/${path} \\\n  -H "Authorization: Bearer ${secret}"`;
}

/* ---------- Refusals ---------- */

const FORM_CODES = new Set(['validation_failed', 'keys.unknown_scope', 'keys.role_too_high', 'keys.too_many', 'keys.service_account_not_found', 'keys.name_taken']);
const FIELD_NAMES: Record<string, string> = { expiresInDays: 'expires', serviceAccountId: 'account' };

export interface FormFailure {
  fields: FieldErrors;
  /** A problem that belongs to no field, shown above the form. */
  message: string | null;
  status: number;
}

/** The refusals a person can fix by changing the form. Anything else is rethrown by the caller. */
export function formFailure(err: unknown): FormFailure | null {
  if (!(err instanceof AppError) || !FORM_CODES.has(err.code)) return null;
  const fields: FieldErrors = {};
  for (const [path, message] of Object.entries(err.fields ?? {})) {
    // A problem with one item of a list (`scopes.3`) is shown with the whole list.
    const name = path.split('.')[0] ?? path;
    fields[FIELD_NAMES[name] ?? name] ??= message;
  }
  if (err.code === 'keys.role_too_high') fields.role = err.message;
  if (err.code === 'keys.service_account_not_found') fields.account = err.message;
  const general = fields._;
  delete fields._;
  const message = general ?? (Object.keys(fields).length === 0 ? err.message : null);
  return { fields, message, status: err.status };
}
