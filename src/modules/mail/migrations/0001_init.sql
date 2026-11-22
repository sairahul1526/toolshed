-- Mail: newsletters, welcome sequences, transactional email. Every table has org_id.

-- A newsletter (the thing people subscribe to). `slug` is public and unique across the install.
CREATE TABLE mail_lists (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  slug          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  double_opt_in INTEGER NOT NULL DEFAULT 1,
  reply_to      TEXT    NOT NULL DEFAULT '',
  thanks_text   TEXT    NOT NULL DEFAULT '',
  archive_public INTEGER NOT NULL DEFAULT 0,
  is_sample     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_lists_slug ON mail_lists (slug);
CREATE INDEX mail_lists_org ON mail_lists (org_id, created_at);

-- One person per workspace. `fields` holds custom field values as JSON.
CREATE TABLE mail_subscribers (
  id           TEXT    PRIMARY KEY,
  org_id       TEXT    NOT NULL,
  email        TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  fields       TEXT    NOT NULL DEFAULT '{}',
  source       TEXT    NOT NULL DEFAULT 'manual',
  consent_note TEXT    NOT NULL DEFAULT '',
  consent_at   INTEGER,
  opens        INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  is_sample    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_subscribers_email ON mail_subscribers (org_id, email);
CREATE INDEX mail_subscribers_created ON mail_subscribers (org_id, created_at DESC);

CREATE TABLE mail_subscriber_tags (
  org_id        TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  tag           TEXT NOT NULL,
  PRIMARY KEY (org_id, subscriber_id, tag)
);
CREATE INDEX mail_subscriber_tags_tag ON mail_subscriber_tags (org_id, tag);

-- Which newsletters a person is on. pending = waiting for the confirmation click.
CREATE TABLE mail_memberships (
  org_id          TEXT    NOT NULL,
  list_id         TEXT    NOT NULL,
  subscriber_id   TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  joined_at       INTEGER NOT NULL,
  confirmed_at    INTEGER,
  unsubscribed_at INTEGER,
  confirm_sent_at INTEGER,
  PRIMARY KEY (org_id, list_id, subscriber_id)
);
CREATE INDEX mail_memberships_list ON mail_memberships (org_id, list_id, status);
CREATE INDEX mail_memberships_sub ON mail_memberships (org_id, subscriber_id);

-- Addresses we must not mail. list_id '' means every newsletter in the workspace.
CREATE TABLE mail_suppressions (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  list_id    TEXT    NOT NULL DEFAULT '',
  reason     TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_suppressions_key ON mail_suppressions (org_id, email, list_id);

CREATE TABLE mail_fields (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_fields_key ON mail_fields (org_id, key);

CREATE TABLE mail_segments (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  filter     TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_segments_org ON mail_segments (org_id, created_at);

-- A one-off email to a newsletter (optionally narrowed by a segment filter).
CREATE TABLE mail_broadcasts (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  list_id       TEXT    NOT NULL,
  subject       TEXT    NOT NULL DEFAULT '',
  preheader     TEXT    NOT NULL DEFAULT '',
  format        TEXT    NOT NULL DEFAULT 'markdown',
  body          TEXT    NOT NULL DEFAULT '',
  filter        TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL DEFAULT 'draft',
  scheduled_at  INTEGER,
  started_at    INTEGER,
  finished_at   INTEGER,
  heartbeat_at  INTEGER,
  next_run_at   INTEGER,
  lock_until    INTEGER,
  total         INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  track_opens   INTEGER NOT NULL DEFAULT 0,
  track_clicks  INTEGER NOT NULL DEFAULT 0,
  in_archive    INTEGER NOT NULL DEFAULT 0,
  archive_slug  TEXT    NOT NULL DEFAULT '',
  last_test_at  INTEGER,
  last_error    TEXT    NOT NULL DEFAULT '',
  source        TEXT    NOT NULL DEFAULT 'manual',
  is_sample     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX mail_broadcasts_org ON mail_broadcasts (org_id, created_at DESC);
CREATE INDEX mail_broadcasts_status ON mail_broadcasts (status, scheduled_at);
CREATE INDEX mail_broadcasts_list ON mail_broadcasts (list_id, status, finished_at DESC);

-- One row per person per broadcast. UNIQUE (broadcast_id, subscriber_id) is what stops a double send.
CREATE TABLE mail_deliveries (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  broadcast_id  TEXT    NOT NULL,
  subscriber_id TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'queued',
  reason        TEXT    NOT NULL DEFAULT '',
  claimed_at    INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       INTEGER,
  opened_at     INTEGER,
  open_count    INTEGER NOT NULL DEFAULT 0,
  clicked_at    INTEGER,
  click_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_deliveries_once ON mail_deliveries (broadcast_id, subscriber_id);
CREATE INDEX mail_deliveries_queue ON mail_deliveries (broadcast_id, status, claimed_at);
CREATE INDEX mail_deliveries_org ON mail_deliveries (org_id, broadcast_id);

-- A link in a broadcast. The destination lives here, never in the email.
CREATE TABLE mail_links (
  id           TEXT    PRIMARY KEY,
  org_id       TEXT    NOT NULL,
  broadcast_id TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  clicks       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_links_url ON mail_links (broadcast_id, url);

CREATE TABLE mail_sequences (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  list_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_sequences_list ON mail_sequences (list_id);

CREATE TABLE mail_sequence_steps (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  sequence_id   TEXT    NOT NULL,
  position      INTEGER NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  subject       TEXT    NOT NULL DEFAULT '',
  preheader     TEXT    NOT NULL DEFAULT '',
  body          TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_sequence_steps_pos ON mail_sequence_steps (sequence_id, position);

CREATE TABLE mail_enrollments (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  sequence_id   TEXT    NOT NULL,
  subscriber_id TEXT    NOT NULL,
  next_position INTEGER NOT NULL DEFAULT 1,
  next_at       INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active',
  claimed_at    INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  enrolled_at   INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE UNIQUE INDEX mail_enrollments_once ON mail_enrollments (sequence_id, subscriber_id);
CREATE INDEX mail_enrollments_due ON mail_enrollments (status, next_at);

-- Transactional templates, sent one at a time through the API.
CREATE TABLE mail_templates (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_templates_key ON mail_templates (org_id, key);

-- A short log of transactional sends, and what makes Idempotency-Key work.
CREATE TABLE mail_sent (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL,
  template_key    TEXT    NOT NULL DEFAULT '',
  to_email        TEXT    NOT NULL,
  subject         TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  error           TEXT    NOT NULL DEFAULT '',
  idempotency_key TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_sent_idem ON mail_sent (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX mail_sent_org ON mail_sent (org_id, created_at DESC);

-- RSS to email.
CREATE TABLE mail_feeds (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL,
  list_id         TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  title           TEXT    NOT NULL DEFAULT '',
  mode            TEXT    NOT NULL DEFAULT 'draft',
  status          TEXT    NOT NULL DEFAULT 'active',
  last_checked_at INTEGER,
  last_error      TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);
CREATE INDEX mail_feeds_due ON mail_feeds (status, last_checked_at);

CREATE TABLE mail_feed_items (
  id           TEXT    PRIMARY KEY,
  org_id       TEXT    NOT NULL,
  feed_id      TEXT    NOT NULL,
  item_key     TEXT    NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  link         TEXT    NOT NULL DEFAULT '',
  broadcast_id TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_feed_items_key ON mail_feed_items (feed_id, item_key);
