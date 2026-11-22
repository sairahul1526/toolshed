/** Limits and shapes shared by the webhooks files. */

export const MAX_ENDPOINTS = 20;
export const MAX_HEADERS = 10;
/** The largest request body. A bigger `data` is replaced by `{ "truncated": true }`. */
export const MAX_BODY_BYTES = 256 * 1024;
export const TIMEOUT_MS = 10_000;
/** How much of a receiver's answer is read, and how much of that is kept in the log. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const SNIPPET_BYTES = 2048;
export const USER_AGENT = 'Toolshed-Webhooks/1';

/** Seconds to wait before attempt 2, 3 ... 7. After the seventh failure the delivery is marked failed. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 6 * 3600, 24 * 3600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** Queues delay a message by 12 hours at most, so a longer wait is made of several hops. */
export const MAX_QUEUE_DELAY_SECONDS = 12 * 3600;

/** How long the old secret keeps signing after a rotation. */
export const SECRET_OVERLAP_MS = 24 * 3600 * 1000;
/** An endpoint that has failed this long with no success in between is turned off. */
export const AUTO_DISABLE_AFTER_MS = 72 * 3600 * 1000;
export const DELIVERY_KEEP_DAYS = 30;

export type EndpointStatus = 'active' | 'paused' | 'disabled';
export type DeliveryStatus = 'pending' | 'success' | 'failed';

export interface WebhookEndpoint {
  id: string;
  name: string;
  description: string | null;
  url: string;
  events: string[];
  /** Names only. Header values are never sent back. */
  headerNames: string[];
  status: EndpointStatus;
  disabledReason: string | null;
  createdBy: string;
  createdByLabel: string | null;
  createdAt: number;
  updatedAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  /** While set and in the future, the previous secret still signs deliveries next to the new one. */
  previousSecretExpiresAt: number | null;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  messageId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WebhookAttempt {
  attempt: number;
  statusCode: number | null;
  durationMs: number;
  errorCode: string | null;
  responseSnippet: string | null;
  at: number;
}

/** What one try at a receiver came to. */
export interface AttemptResult {
  deliveryId: string;
  messageId: string;
  ok: boolean;
  statusCode: number | null;
  durationMs: number;
  /** `fetch_timeout`, `url_not_allowed`, `http_500` and so on. Null on success. */
  errorCode: string | null;
  responseSnippet: string | null;
}

export interface Actor {
  userId: string;
  label?: string | null;
}

export interface DeliveryDetail extends WebhookDelivery {
  /** The event as it was sent, parsed. */
  payload: unknown;
  attempts: WebhookAttempt[];
}
