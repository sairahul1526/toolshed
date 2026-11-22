/** Database rows as stored, and how they become the objects the API returns. */
import { parseJson } from '../db';
import type { DeliveryStatus, EndpointStatus, WebhookDelivery, WebhookEndpoint } from './types';

export interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  url: string;
  events: string;
  header_names: string;
  headers_enc: string | null;
  status: EndpointStatus;
  disabled_reason: string | null;
  secret_enc: string;
  prev_secret_enc: string | null;
  prev_secret_expires_at: number | null;
  created_by: string;
  created_by_label: string | null;
  created_at: number;
  updated_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  consecutive_failures: number;
  failing_since: number | null;
}

export interface DeliveryRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  message_id: string;
  event_type: string;
  status: DeliveryStatus;
  attempt_count: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: number | null;
  payload: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** Secrets and header values are left out on purpose: only the names of custom headers are shown. */
export function toEndpoint(row: EndpointRow, now = Date.now()): WebhookEndpoint {
  const overlapping = row.prev_secret_expires_at !== null && row.prev_secret_expires_at > now;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    events: parseJson<string[]>(row.events, []),
    headerNames: parseJson<string[]>(row.header_names, []),
    status: row.status,
    disabledReason: row.disabled_reason,
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    consecutiveFailures: row.consecutive_failures,
    previousSecretExpiresAt: overlapping ? row.prev_secret_expires_at : null,
  };
}

export function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    messageId: row.message_id,
    eventType: row.event_type,
    status: row.status,
    attemptCount: row.attempt_count,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
