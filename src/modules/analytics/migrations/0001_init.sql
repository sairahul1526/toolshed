-- Analytics: sites, raw hits, one row per visitor per day, daily totals, goals, share links, counters.
--
-- The three busy tables (an_hits, an_sessions, an_rollups) are WITHOUT ROWID and have no extra
-- index, so each insert or update is one row written. D1 bills an index entry as a row.

CREATE TABLE an_sites (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL,
  key             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  domain          TEXT    NOT NULL,
  domains         TEXT    NOT NULL DEFAULT '[]',
  timezone        TEXT    NOT NULL DEFAULT 'UTC',
  retention_days  INTEGER NOT NULL DEFAULT 30,
  engagement      INTEGER NOT NULL DEFAULT 1,
  respect_dnt     INTEGER NOT NULL DEFAULT 0,
  daily_cap       INTEGER NOT NULL DEFAULT 20000,
  exclude_paths   TEXT    NOT NULL DEFAULT '[]',
  exclude_ips     TEXT    NOT NULL DEFAULT '[]',
  pinned          INTEGER NOT NULL DEFAULT 0,
  weekly_report   INTEGER NOT NULL DEFAULT 0,
  report_emails   TEXT    NOT NULL DEFAULT '[]',
  spike_threshold INTEGER NOT NULL DEFAULT 0,
  last_spike_at   INTEGER,
  last_report_key TEXT,
  rolled_at       INTEGER NOT NULL DEFAULT 0,
  first_hit_at    INTEGER,
  sample          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX an_sites_key ON an_sites (key);
CREATE INDEX an_sites_org ON an_sites (org_id, domain);

-- One row per page view, custom event or engagement ping. The flags (nv, ns, np, ub) and dur are
-- what this hit added to the day's totals, so totals are plain sums and never need a second look
-- at earlier hits.
CREATE TABLE an_hits (
  org_id       TEXT    NOT NULL,
  site_id      TEXT    NOT NULL,
  at           INTEGER NOT NULL,
  id           TEXT    NOT NULL,
  day          TEXT    NOT NULL,
  hour         INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  name         TEXT,
  path         TEXT    NOT NULL,
  prev_path    TEXT,
  visitor      TEXT    NOT NULL,
  source       TEXT,
  channel      TEXT    NOT NULL DEFAULT 'Direct',
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  country      TEXT,
  region       TEXT,
  city         TEXT,
  device       TEXT,
  browser      TEXT,
  os           TEXT,
  props        TEXT,
  nv           INTEGER NOT NULL DEFAULT 0,
  ns           INTEGER NOT NULL DEFAULT 0,
  np           INTEGER NOT NULL DEFAULT 0,
  ub           INTEGER NOT NULL DEFAULT 0,
  dur          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, at, id)
) WITHOUT ROWID;

-- One row per visitor per site-local day. Each hit updates it in a single statement, which also
-- leaves the d_* columns behind for the hit insert that follows in the same batch.
CREATE TABLE an_sessions (
  org_id       TEXT    NOT NULL,
  site_id      TEXT    NOT NULL,
  visitor      TEXT    NOT NULL,
  day          TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  visit_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  visits       INTEGER NOT NULL DEFAULT 1,
  pageviews    INTEGER NOT NULL DEFAULT 0,
  vpv          INTEGER NOT NULL DEFAULT 0,
  events       INTEGER NOT NULL DEFAULT 0,
  hits         INTEGER NOT NULL DEFAULT 1,
  engaged      INTEGER NOT NULL DEFAULT 0,
  duration     INTEGER NOT NULL DEFAULT 0,
  entry_path   TEXT,
  exit_path    TEXT,
  source       TEXT,
  channel      TEXT    NOT NULL DEFAULT 'Direct',
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  paths        TEXT    NOT NULL DEFAULT '',
  d_at         INTEGER NOT NULL DEFAULT 0,
  d_nv         INTEGER NOT NULL DEFAULT 0,
  d_ns         INTEGER NOT NULL DEFAULT 0,
  d_np         INTEGER NOT NULL DEFAULT 0,
  d_ub         INTEGER NOT NULL DEFAULT 0,
  d_dur        INTEGER NOT NULL DEFAULT 0,
  d_prev       TEXT,
  PRIMARY KEY (site_id, visitor, day)
) WITHOUT ROWID;

-- Daily totals per site, per dimension, per value. The dashboard reads only this table unless a
-- filter is on.
CREATE TABLE an_rollups (
  org_id    TEXT    NOT NULL,
  site_id   TEXT    NOT NULL,
  dim       TEXT    NOT NULL,
  day       TEXT    NOT NULL,
  value     TEXT    NOT NULL,
  visitors  INTEGER NOT NULL DEFAULT 0,
  visits    INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events    INTEGER NOT NULL DEFAULT 0,
  unbounces INTEGER NOT NULL DEFAULT 0,
  duration  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, dim, day, value)
) WITHOUT ROWID;

CREATE TABLE an_goals (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  site_id       TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  match         TEXT    NOT NULL,
  emitted_day   TEXT,
  emitted_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX an_goals_site ON an_goals (org_id, site_id);

CREATE TABLE an_shares (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  site_id       TEXT    NOT NULL,
  token         TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  password_hash TEXT,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX an_shares_token ON an_shares (token);
CREATE INDEX an_shares_site ON an_shares (org_id, site_id);

-- Small per-site daily counters: an estimate of hits stored (for the daily cap) and hits dropped,
-- by reason, for the data health panel.
CREATE TABLE an_counters (
  org_id  TEXT    NOT NULL,
  site_id TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  name    TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, name)
) WITHOUT ROWID;
