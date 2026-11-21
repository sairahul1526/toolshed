-- Core tables that every module can rely on. Add-only: never edit this file after release,
-- add a new numbered file instead.

-- Which modules a workspace has turned on, and each module's settings.
CREATE TABLE module_state (
  org_id     TEXT    NOT NULL,
  module_id  TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  settings   TEXT    NOT NULL DEFAULT '{}',
  sample     INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER,
  PRIMARY KEY (org_id, module_id)
);

-- Key/value settings. scope is 'instance' or a workspace id.
CREATE TABLE settings (
  scope      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Who did what. org_id is NULL for install-wide actions.
CREATE TABLE audit_log (
  id          TEXT    PRIMARY KEY,
  org_id      TEXT,
  actor_id    TEXT,
  actor_type  TEXT    NOT NULL DEFAULT 'user',
  actor_label TEXT,
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  summary     TEXT,
  meta        TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX audit_log_org_time ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_time ON audit_log (created_at DESC);

-- Every email the app tried to send. Bodies are stored only in dev (for the /dev/outbox page).
CREATE TABLE email_log (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT,
  to_addr    TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  template   TEXT,
  tag        TEXT,
  status     TEXT    NOT NULL,
  error      TEXT,
  body_text  TEXT,
  body_html  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_log_org_time ON email_log (org_id, created_at DESC);
CREATE INDEX email_log_time ON email_log (created_at DESC);

-- Fixed-window counters for rate limits.
CREATE TABLE rate_limits (
  key          TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- Daily totals per event, for charts and Overview numbers. day is 'YYYY-MM-DD' in UTC.
CREATE TABLE event_counts (
  org_id TEXT    NOT NULL,
  module TEXT    NOT NULL,
  name   TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, module, name, day)
);

-- A short log of the latest events, for activity feeds. Trimmed by a daily job.
CREATE TABLE events_recent (
  id      TEXT    PRIMARY KEY,
  org_id  TEXT    NOT NULL,
  module  TEXT    NOT NULL,
  name    TEXT    NOT NULL,
  subject TEXT,
  data    TEXT,
  at      INTEGER NOT NULL
);
CREATE INDEX events_recent_org_time ON events_recent (org_id, at DESC);
