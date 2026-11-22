-- Links: short links, bio pages, click stats, abuse reports.
-- Short codes and bio slugs share one namespace (links_slugs), unique across the install.

CREATE TABLE links_slugs (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL
);
CREATE UNIQUE INDEX links_slugs_target ON links_slugs (target_id);
CREATE INDEX links_slugs_org ON links_slugs (org_id);

CREATE TABLE links_folders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX links_folders_name ON links_folders (org_id, lower(name));

CREATE TABLE links_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  code TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  redirect_type INTEGER NOT NULL DEFAULT 302,
  status TEXT NOT NULL DEFAULT 'active',
  disabled_reason TEXT,
  folder_id TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  click_cap INTEGER,
  password_hash TEXT,
  expired_url TEXT,
  forward_query INTEGER NOT NULL DEFAULT 1,
  rules TEXT NOT NULL DEFAULT '[]',
  preview_title TEXT NOT NULL DEFAULT '',
  preview_description TEXT NOT NULL DEFAULT '',
  preview_image TEXT NOT NULL DEFAULT '',
  expired_notified INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX links_links_org ON links_links (org_id, status, id);
CREATE INDEX links_links_folder ON links_links (org_id, folder_id);
CREATE INDEX links_links_expiry ON links_links (expires_at) WHERE expires_at IS NOT NULL AND expired_notified = 0;

CREATE TABLE links_link_tags (
  org_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (link_id, tag)
);
CREATE INDEX links_link_tags_tag ON links_link_tags (org_id, tag);

-- Domains no link may point to, per workspace.
CREATE TABLE links_blocked_domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX links_blocked_domains_domain ON links_blocked_domains (org_id, domain);

CREATE TABLE links_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX links_reports_org ON links_reports (org_id, status, id);

CREATE TABLE links_bios (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'workspace',
  colors TEXT NOT NULL DEFAULT '{}',
  published INTEGER NOT NULL DEFAULT 0,
  noindex INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  seo_image TEXT NOT NULL DEFAULT '',
  sample INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX links_bios_org ON links_bios (org_id, id);

CREATE TABLE links_bio_blocks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bio_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX links_bio_blocks_bio ON links_bio_blocks (bio_id, position);

-- One row per target (link or bio page), kind and day. Written on every visit: this is the cheap total.
-- kind: 'click' (short link), 'view' (bio page view), 'block' (bio block click).
CREATE TABLE links_daily (
  org_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  qr INTEGER NOT NULL DEFAULT 0,
  bots INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target_id, kind, day)
);
CREATE INDEX links_daily_org ON links_daily (org_id, kind, day);

-- A short window of raw human visits. Rolled up by day, then trimmed.
CREATE TABLE links_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  block_id TEXT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  visitor TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  qr INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX links_clicks_day ON links_clicks (day);
CREATE INDEX links_clicks_target ON links_clicks (target_id, day);
CREATE INDEX links_clicks_org ON links_clicks (org_id, day);

-- Per day breakdowns of the raw visits, kept long term. dim is country, city, device, browser,
-- os, referrer, utm_source, utm_medium, utm_campaign, source (qr or link), block, or 'all' (uniques).
CREATE TABLE links_rollups (
  org_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  value TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  uniques INTEGER NOT NULL,
  PRIMARY KEY (target_id, kind, day, dim, value)
);
CREATE INDEX links_rollups_org ON links_rollups (org_id, kind, day);
