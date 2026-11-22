/** Endpoints: create, read, change, delete, and the signing secret. */
import { z } from 'zod';
import type { Env } from '../../env';
import { newId, orgDb } from '../db';
import { errors, parse } from '../errors';
import { assertPublicUrl } from '../net';
import { forgetActiveEndpoints } from './active';
import { eventPattern } from './catalog';
import { webhookErrors } from './errors';
import { headersField } from './headers';
import { type EndpointRow, toEndpoint } from './rows';
import { open, seal, headersAad, secretAad } from './seal';
import { generateSecret } from './signing';
import { type Actor, MAX_ENDPOINTS, SECRET_OVERLAP_MS, type WebhookEndpoint } from './types';

const name = z.string('Add a name.').trim().min(1, 'Add a name.').max(80, 'Keep the name under 80 characters.');
const description = z
  .string('The description must be text.')
  .trim()
  .max(300, 'Keep the description under 300 characters.')
  .transform((v) => v || null)
  .nullable();
const events = z
  .array(eventPattern, 'List the events to send.')
  .min(1, 'Pick at least one event, or * for everything.')
  .max(50, 'Pick up to 50 events. Use * to send everything.')
  .transform((v) => [...new Set(v)]);

const url = z
  .string('Enter the address to send events to.')
  .trim()
  .max(2000, 'Keep the address under 2,000 characters.')
  .superRefine((value, ctx) => {
    let parsed: URL | null = null;
    try {
      parsed = assertPublicUrl(value);
    } catch {
      // The message below says it for every kind of refusal.
    }
    if (!parsed || parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Enter a public address that starts with https://. Local, private and plain http addresses can’t be used.' });
    }
  });

const createSchema = z.strictObject({ name, description: description.optional(), url, events, headers: headersField.optional() });

const updateSchema = z.strictObject({
  name: name.optional(),
  description: description.optional(),
  url: url.optional(),
  events: events.optional(),
  headers: headersField.optional(),
  status: z.enum(['active', 'paused'], 'Use active or paused.').optional(),
});

export async function loadEndpointRow(env: Env, orgId: string, id: string): Promise<EndpointRow> {
  const row = await orgDb(env.DB, orgId).get<EndpointRow>('webhook_endpoints', id);
  if (!row) throw errors.not_found('We couldn’t find that webhook endpoint. It may have been deleted.');
  return row;
}

export async function createEndpoint(
  env: Env,
  orgId: string,
  actor: Actor,
  input: unknown,
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const data = parse(createSchema, input);
  const id = newId('whe');
  const now = Date.now();
  const secret = generateSecret();
  const headers = data.headers ?? {};
  const headerNames = Object.keys(headers);
  const [secretEnc, headersEnc] = await Promise.all([
    seal(env, secretAad(id), secret),
    headerNames.length > 0 ? seal(env, headersAad(id), JSON.stringify(headers)) : Promise.resolve(null),
  ]);
  // The limit is checked inside the insert, so two requests at once cannot both slip under it.
  const row = await env.DB.prepare(
    `INSERT INTO webhook_endpoints
       (id, org_id, name, description, url, events, header_names, headers_enc, status, secret_enc, created_by, created_by_label, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?12, ?12
     WHERE (SELECT COUNT(*) FROM webhook_endpoints WHERE org_id = ?2) < ${MAX_ENDPOINTS}
     RETURNING *`,
  )
    .bind(id, orgId, data.name, data.description ?? null, data.url, JSON.stringify(data.events), JSON.stringify(headerNames), headersEnc, secretEnc, actor.userId, actor.label ?? null, now)
    .first<EndpointRow>();
  if (!row) throw webhookErrors.too_many();
  forgetActiveEndpoints(env, orgId);
  return { endpoint: toEndpoint(row, now), secret };
}

export async function listEndpoints(env: Env, orgId: string): Promise<WebhookEndpoint[]> {
  const rows = await orgDb(env.DB, orgId).list<EndpointRow>('webhook_endpoints', { orderBy: 'created_at, id', limit: MAX_ENDPOINTS });
  return rows.map((r) => toEndpoint(r));
}

export async function getEndpoint(env: Env, orgId: string, id: string): Promise<WebhookEndpoint> {
  return toEndpoint(await loadEndpointRow(env, orgId, id));
}

/**
 * Change an endpoint. `headers`, when sent, replaces all the custom headers. Turning a disabled
 * endpoint back on (or pausing it) clears the reason and the failure streak.
 * Returns the endpoint and the names of the fields that changed.
 */
export async function updateEndpoint(
  env: Env,
  orgId: string,
  id: string,
  input: unknown,
  now = Date.now(),
): Promise<{ endpoint: WebhookEndpoint; changed: string[] }> {
  const data = parse(updateSchema, input);
  const row = await loadEndpointRow(env, orgId, id);
  const patch: Record<string, string | number | null> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.url !== undefined) patch.url = data.url;
  if (data.events !== undefined) patch.events = JSON.stringify(data.events);
  if (data.headers !== undefined) {
    const names = Object.keys(data.headers);
    patch.header_names = JSON.stringify(names);
    patch.headers_enc = names.length > 0 ? await seal(env, headersAad(id), JSON.stringify(data.headers)) : null;
  }
  if (data.status !== undefined) {
    patch.status = data.status;
    if (row.status === 'disabled') Object.assign(patch, { disabled_reason: null, consecutive_failures: 0, failing_since: null });
  }
  const changed = Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined);
  if (changed.length === 0) return { endpoint: toEndpoint(row, now), changed };
  patch.updated_at = now;
  const updated = await orgDb(env.DB, orgId).update<EndpointRow>('webhook_endpoints', id, patch);
  forgetActiveEndpoints(env, orgId);
  return { endpoint: toEndpoint(updated ?? row, now), changed };
}

/** Delete an endpoint with its deliveries and their attempts. */
export async function deleteEndpoint(env: Env, orgId: string, id: string): Promise<void> {
  await loadEndpointRow(env, orgId, id);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM webhook_attempts WHERE org_id = ?1 AND delivery_id IN (SELECT id FROM webhook_deliveries WHERE org_id = ?1 AND endpoint_id = ?2)`,
    ).bind(orgId, id),
    env.DB.prepare('DELETE FROM webhook_deliveries WHERE org_id = ?1 AND endpoint_id = ?2').bind(orgId, id),
    env.DB.prepare('DELETE FROM webhook_endpoints WHERE org_id = ?1 AND id = ?2').bind(orgId, id),
  ]);
  forgetActiveEndpoints(env, orgId);
}

/**
 * Make a new secret. The old one keeps signing next to it for 24 hours so the receiver can switch
 * without missing events. A second rotation inside that day ends the first overlap.
 */
export async function rotateEndpointSecret(
  env: Env,
  orgId: string,
  id: string,
  now = Date.now(),
): Promise<{ endpoint: WebhookEndpoint; secret: string; previousSecretExpiresAt: number }> {
  const row = await loadEndpointRow(env, orgId, id);
  const secret = generateSecret();
  const expiresAt = now + SECRET_OVERLAP_MS;
  const updated = await orgDb(env.DB, orgId).update<EndpointRow>('webhook_endpoints', id, {
    secret_enc: await seal(env, secretAad(id), secret),
    // Sealed under the same row and column, so it is copied as it is.
    prev_secret_enc: row.secret_enc,
    prev_secret_expires_at: expiresAt,
    updated_at: now,
  });
  return { endpoint: toEndpoint(updated ?? row, now), secret, previousSecretExpiresAt: expiresAt };
}

export async function revealEndpointSecret(env: Env, orgId: string, id: string): Promise<{ secret: string }> {
  const row = await loadEndpointRow(env, orgId, id);
  const secret = await open(env, secretAad(id), row.secret_enc);
  if (!secret) {
    throw errors.conflict('We can’t read this secret any more, because the install’s AUTH_SECRET has changed. Rotate the secret to make a new one.');
  }
  return { secret };
}
