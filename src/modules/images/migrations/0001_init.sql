-- Images: templates, uploaded pictures and fonts, the render cache index, usage and batches.

CREATE TABLE img_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- Public name in /i/<slug>.png. Unique across the whole install.
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The draft the editor saves. JSON.
  doc TEXT NOT NULL,
  -- What image URLs draw. NULL until the template is published for the first time.
  published_doc TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  -- 1 lets anyone render without a signature, using only the template's own fields.
  open INTEGER NOT NULL DEFAULT 0,
  -- 1 turns on the public page at /i/<slug>/make, where anyone can fill the fields and download.
  page INTEGER NOT NULL DEFAULT 0,
  -- Most new images this template may ever make. NULL means no limit.
  max_renders INTEGER,
  renders INTEGER NOT NULL DEFAULT 0,
  first_request_at INTEGER,
  starter TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE UNIQUE INDEX img_templates_slug ON img_templates (slug);
CREATE INDEX img_templates_org ON img_templates (org_id, id);

CREATE TABLE img_assets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- 'image' or 'font'
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  -- Fonts: family, style, weight and the characters the file covers. JSON.
  meta TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX img_assets_org ON img_assets (org_id, kind, id);

-- One row per finished image kept in file storage. The file is at images/<org>/renders/<hash>.<format>.
CREATE TABLE img_renders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  format TEXT NOT NULL,
  width INTEGER NOT NULL,
  version INTEGER NOT NULL,
  -- The query string that made it, without the signature, for the "top images" list.
  query TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL,
  -- 'url', 'api', 'batch' or 'bake'
  source TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER
);
CREATE UNIQUE INDEX img_renders_hash ON img_renders (hash);
CREATE INDEX img_renders_template ON img_renders (org_id, template_id, id);
CREATE INDEX img_renders_hits ON img_renders (org_id, hits);

-- Cache hits since the last hourly roll-up: one small row per image and day, so a hit costs one
-- write. The roll-up moves these counts into img_renders and img_daily and empties the table.
CREATE TABLE img_hits (
  org_id TEXT NOT NULL,
  day TEXT NOT NULL,
  hash TEXT NOT NULL,
  template_id TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, hash)
) WITHOUT ROWID;

-- New renders and failures, newest first. Cache hits are counted, not logged one by one.
CREATE TABLE img_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  template_id TEXT,
  -- 'rendered' or 'error'
  outcome TEXT NOT NULL,
  format TEXT,
  source TEXT NOT NULL,
  ms INTEGER,
  bytes INTEGER,
  code TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX img_log_org ON img_log (org_id, id);
CREATE INDEX img_log_created ON img_log (created_at);

-- Daily totals per template. Days are UTC.
CREATE TABLE img_daily (
  org_id TEXT NOT NULL,
  day TEXT NOT NULL,
  template_id TEXT NOT NULL,
  renders INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, template_id)
);

CREATE TABLE img_batches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  width INTEGER,
  -- The site address the finished image URLs start with, taken from the request that started the batch.
  base_url TEXT NOT NULL,
  -- 'queued', 'running', 'done' or 'failed'
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  -- The rows to render, as a JSON array of objects.
  input TEXT NOT NULL,
  -- One entry per row: { url } or { error }. JSON.
  results TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX img_batches_org ON img_batches (org_id, id);
