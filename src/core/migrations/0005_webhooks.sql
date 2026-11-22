-- Outgoing webhooks: endpoints, the delivery log and each attempt.
-- Add-only: never edit this file after release, add a new numbered file instead.

-- Where a workspace sends events. Secrets and custom header values are stored encrypted
-- (AES-256-GCM under a key derived from AUTH_SECRET), never in clear text.
CREATE TABLE webhook_endpoints (
  id                     TEXT    PRIMARY KEY,
  org_id                 TEXT    NOT NULL,
  name                   TEXT    NOT NULL,
  description            TEXT,
  url                    TEXT    NOT NULL,
  events                 TEXT    NOT NULL,           -- JSON array of patterns: "links.link.clicked", "links.*", "*"
  header_names           TEXT    NOT NULL,           -- JSON array. Names only, so lists need no decryption
  headers_enc            TEXT,                       -- sealed JSON object of custom headers
  status                 TEXT    NOT NULL,           -- active | paused | disabled
  disabled_reason        TEXT,
  secret_enc             TEXT    NOT NULL,
  prev_secret_enc        TEXT,                       -- the secret before the last rotation, valid until the time below
  prev_secret_expires_at INTEGER,
  created_by             TEXT    NOT NULL,
  created_by_label       TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_success_at        INTEGER,
  last_failure_at        INTEGER,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  failing_since          INTEGER                     -- first failure of the current streak, null after a success
);
CREATE INDEX webhook_endpoints_org ON webhook_endpoints (org_id, created_at);
CREATE INDEX webhook_endpoints_active ON webhook_endpoints (org_id) WHERE status = 'active';

-- One row per event per endpoint. `payload` is the exact request body, kept so it can be sent again.
-- Ids sort by creation time, so lists page on the id alone.
CREATE TABLE webhook_deliveries (
  id               TEXT    PRIMARY KEY,
  org_id           TEXT    NOT NULL,
  endpoint_id      TEXT    NOT NULL,
  message_id       TEXT    NOT NULL,                 -- the webhook-id header, the same on every attempt
  event_type       TEXT    NOT NULL,
  status           TEXT    NOT NULL,                 -- pending | success | failed
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error       TEXT,
  next_attempt_at  INTEGER,
  payload          TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE UNIQUE INDEX webhook_deliveries_message ON webhook_deliveries (endpoint_id, message_id);
CREATE INDEX webhook_deliveries_org ON webhook_deliveries (org_id, id);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (org_id, endpoint_id, id);
CREATE INDEX webhook_deliveries_status ON webhook_deliveries (org_id, status, id);
CREATE INDEX webhook_deliveries_event ON webhook_deliveries (org_id, event_type, id);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_created ON webhook_deliveries (created_at);

CREATE TABLE webhook_attempts (
  id               TEXT    PRIMARY KEY,
  org_id           TEXT    NOT NULL,
  delivery_id      TEXT    NOT NULL,
  attempt          INTEGER NOT NULL,
  status_code      INTEGER,
  duration_ms      INTEGER NOT NULL,
  error_code       TEXT,
  response_snippet TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX webhook_attempts_delivery ON webhook_attempts (delivery_id, attempt);
