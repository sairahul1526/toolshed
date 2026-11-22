/**
 * Outgoing webhooks: a workspace gives us an https address and the events it wants, and we POST
 * each event there, signed, with retries and a delivery log. See docs/webhooks.md.
 *
 * Other code only needs `queueWebhooks` (called by `emit()`). The rest serves the REST API.
 */
export { eventCatalog, matchesEvent } from './webhooks/catalog';
export type { CatalogEvent } from './webhooks/catalog';
export { deliverWebhook, resendDelivery, sendTestEvent, sweepDeliveries } from './webhooks/delivery';
export { webhookErrors } from './webhooks/errors';
export { queueWebhooks } from './webhooks/fanout';
export { getDelivery, listDeliveries, purgeOldDeliveries } from './webhooks/log';
export { signPayload, verifySignature } from './webhooks/signing';
export {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  revealEndpointSecret,
  rotateEndpointSecret,
  updateEndpoint,
} from './webhooks/store';
export type { Actor, AttemptResult, DeliveryDetail, WebhookAttempt, WebhookDelivery, WebhookEndpoint } from './webhooks/types';
