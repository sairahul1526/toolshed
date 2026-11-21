-- Core services: email delivery, audit protection, notifications, exports, job failures.
-- Add-only. Tables with org_id '' (or NULL where noted) belong to the whole install, not a workspace.

-- Email: how many sends it took, and the provider's message id.
ALTER TABLE email_log ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_log ADD COLUMN message_id TEXT;
CREATE INDEX email_log_status_time ON email_log (status, created_at DESC);

-- Addresses that hard-bounced or are suppressed by the provider. We stop sending to them.
CREATE TABLE email_suppressions (
  address    TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL DEFAULT '',
  reason     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Audit log protection. Rows can never be edited. Rows can only be deleted by the nightly cleanup,
-- which opens the gate for rows older than its cutoff (purge_before) inside one batch.
-- A workspace that is being deleted has no module_state rows left (they are removed first), which
-- lets purgeOrgData remove that workspace's log too.
CREATE TABLE audit_guard (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  purge_before INTEGER NOT NULL DEFAULT 0
);
INSERT INTO audit_guard (id, purge_before) VALUES (1, 0);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'Audit log entries cannot be edited.');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
WHEN OLD.created_at >= (SELECT purge_before FROM audit_guard WHERE id = 1)
  AND (OLD.org_id IS NULL OR EXISTS (SELECT 1 FROM module_state WHERE org_id = OLD.org_id))
BEGIN
  SELECT RAISE(ABORT, 'Audit log entries cannot be deleted.');
END;

-- Notifications: one row each. user_id NULL means "every admin of the workspace".
CREATE TABLE notifications (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  user_id    TEXT,
  kind       TEXT    NOT NULL DEFAULT 'info',
  title      TEXT    NOT NULL,
  body       TEXT,
  href       TEXT,
  dedupe_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_org_time ON notifications (org_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Read state per person: everything up to read_all_at is read, plus single items in notification_reads.
CREATE TABLE notification_marks (
  org_id      TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  read_all_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE notification_reads (
  org_id          TEXT    NOT NULL,
  user_id         TEXT    NOT NULL,
  notification_id TEXT    NOT NULL,
  read_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, notification_id)
);

-- Workspace exports. The file lives in R2 under exports/<org_id>/<id>.zip until expires_at.
CREATE TABLE exports (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL,
  requested_by    TEXT    NOT NULL,
  requested_email TEXT,
  base_url        TEXT,
  status          TEXT    NOT NULL,
  tables_done     INTEGER NOT NULL DEFAULT 0,
  tables_total    INTEGER NOT NULL DEFAULT 0,
  size            INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  expires_at      INTEGER
);
CREATE INDEX exports_org_time ON exports (org_id, created_at DESC);

-- Jobs that used up their retries. payload is kept only when it is safe and small enough to retry.
CREATE TABLE job_failures (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL DEFAULT '',
  name            TEXT    NOT NULL,
  payload_size    INTEGER NOT NULL,
  payload_preview TEXT    NOT NULL,
  payload         TEXT,
  error           TEXT    NOT NULL,
  attempts        INTEGER NOT NULL,
  failed_at       INTEGER NOT NULL,
  retried_at      INTEGER
);
CREATE INDEX job_failures_time ON job_failures (failed_at DESC);

-- Claimed keys for `once()`, so a retried job does not repeat a side effect.
CREATE TABLE once_keys (
  key        TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL
);
CREATE INDEX once_keys_expiry ON once_keys (expires_at);
