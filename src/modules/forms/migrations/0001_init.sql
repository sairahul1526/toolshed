-- Forms. Add-only: never edit this file after release, add a new numbered file instead.

CREATE TABLE forms_forms (
  id                   TEXT    PRIMARY KEY,
  org_id               TEXT    NOT NULL,
  -- Public address segment. Unique across the whole install because /f/<slug> has no workspace in it.
  slug                 TEXT    NOT NULL UNIQUE,
  name                 TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'draft',
  draft_version_id     TEXT,
  published_version_id TEXT,
  -- Access, dates, cap, spam, notifications, autoresponder, privacy and theme. Applies at once, not versioned.
  settings             TEXT    NOT NULL DEFAULT '{}',
  response_count       INTEGER NOT NULL DEFAULT 0,
  last_response_at     INTEGER,
  -- Bumped on every autosave so two open editors cannot silently overwrite each other.
  rev                  INTEGER NOT NULL DEFAULT 1,
  sample               INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  published_at         INTEGER,
  trashed_at           INTEGER
);
CREATE INDEX forms_forms_org ON forms_forms (org_id, trashed_at, updated_at DESC);

-- One mutable draft per form, one immutable copy per publish, and occasional snapshots for history.
CREATE TABLE forms_versions (
  id          TEXT    PRIMARY KEY,
  org_id      TEXT    NOT NULL,
  form_id     TEXT    NOT NULL,
  number      INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  definition  TEXT    NOT NULL,
  label       TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX forms_versions_form ON forms_versions (form_id, kind, created_at DESC);

CREATE TABLE forms_submissions (
  id                TEXT    PRIMARY KEY,
  org_id            TEXT    NOT NULL,
  form_id           TEXT    NOT NULL,
  version_id        TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'complete',
  answers           TEXT    NOT NULL DEFAULT '{}',
  score             REAL,
  calcs             TEXT    NOT NULL DEFAULT '{}',
  ending_id         TEXT,
  respondent_email  TEXT,
  search_text       TEXT    NOT NULL DEFAULT '',
  meta              TEXT    NOT NULL DEFAULT '{}',
  visitor_id        TEXT,
  -- Chosen by the browser. Makes a retried post or a partial save land on one row.
  client_id         TEXT,
  content_hash      TEXT,
  starred           INTEGER NOT NULL DEFAULT 0,
  read_at           INTEGER,
  sample            INTEGER NOT NULL DEFAULT 0,
  started_at        INTEGER,
  completed_at      INTEGER,
  duration_ms       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX forms_sub_form ON forms_submissions (form_id, status, created_at DESC);
CREATE INDEX forms_sub_email ON forms_submissions (org_id, respondent_email);
CREATE INDEX forms_sub_hash ON forms_submissions (form_id, content_hash, created_at);
CREATE UNIQUE INDEX forms_sub_client ON forms_submissions (form_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE forms_notes (
  id             TEXT    PRIMARY KEY,
  org_id         TEXT    NOT NULL,
  submission_id  TEXT    NOT NULL,
  body           TEXT    NOT NULL,
  author_id      TEXT,
  author_label   TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX forms_notes_sub ON forms_notes (submission_id, created_at);

-- Files uploaded to R2. submission_id stays null until the submit claims the file.
CREATE TABLE forms_files (
  id             TEXT    PRIMARY KEY,
  org_id         TEXT    NOT NULL,
  form_id        TEXT    NOT NULL,
  submission_id  TEXT,
  field_id       TEXT    NOT NULL,
  r2_key         TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  size           INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX forms_files_sub ON forms_files (submission_id);
CREATE INDEX forms_files_form ON forms_files (form_id, created_at);

-- Daily counters: views, starts, completions, per-question reach and answer tallies. Read instead of scanning submissions.
CREATE TABLE forms_stats (
  org_id   TEXT    NOT NULL,
  form_id  TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  metric   TEXT    NOT NULL,
  key      TEXT    NOT NULL DEFAULT '',
  n        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, day, metric, key)
);
CREATE INDEX forms_stats_org ON forms_stats (org_id);
