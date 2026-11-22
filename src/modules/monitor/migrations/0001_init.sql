-- Monitor: uptime checks, heartbeats, alerts, incidents, maintenance and public status pages.
-- Check results are stored one row per minute per chunk (JSON), then rolled up per hour and per day.

CREATE TABLE mon_monitors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'http',            -- http | heartbeat
  url TEXT,
  method TEXT NOT NULL DEFAULT 'GET',
  headers TEXT,                                 -- JSON object
  body TEXT,
  expected_status TEXT NOT NULL DEFAULT '200-299',
  keyword TEXT,
  keyword_mode TEXT NOT NULL DEFAULT 'none',    -- none | present | absent
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  follow_redirects INTEGER NOT NULL DEFAULT 1,
  interval_min INTEGER NOT NULL DEFAULT 1,
  slot INTEGER NOT NULL DEFAULT 0,              -- which minute of the interval this monitor runs in
  fail_after INTEGER NOT NULL DEFAULT 2,        -- failed checks in a row before it counts as down
  slow_ms INTEGER,                              -- slow-response threshold, null = off
  slow_after INTEGER NOT NULL DEFAULT 3,
  auto_incident INTEGER NOT NULL DEFAULT 1,
  channel_ids TEXT,                             -- JSON array of channel ids, null = every channel
  hb_token TEXT,
  hb_period_sec INTEGER,
  hb_grace_sec INTEGER NOT NULL DEFAULT 300,
  hb_last_ping_at INTEGER,
  hb_last_kind TEXT,                            -- success | start | fail
  hb_last_code INTEGER,
  hb_last_note TEXT,
  hb_started_at INTEGER,
  hb_win_start INTEGER NOT NULL DEFAULT 0,
  hb_win_count INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | up | down
  slow INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  slow_streak INTEGER NOT NULL DEFAULT 0,
  since_at INTEGER,
  last_error TEXT,
  last_code INTEGER,
  incident_id TEXT,
  notified TEXT,                                -- JSON: channel id -> last time a down alert was sent
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mon_monitors_org ON mon_monitors (org_id, created_at);
CREATE INDEX mon_monitors_active ON mon_monitors (paused, type);
CREATE UNIQUE INDEX mon_monitors_token ON mon_monitors (hb_token) WHERE hb_token IS NOT NULL;

CREATE TABLE mon_minutes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  chunk TEXT NOT NULL,
  results TEXT NOT NULL,                        -- JSON array of [monitorId, ok, ms, statusCode, flags, error]
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mon_minutes_chunk ON mon_minutes (org_id, minute, chunk);
CREATE INDEX mon_minutes_minute ON mon_minutes (minute);

CREATE TABLE mon_hourly (
  org_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  up INTEGER NOT NULL,
  down INTEGER NOT NULL,
  avg_ms INTEGER,
  p95_ms INTEGER,
  PRIMARY KEY (monitor_id, hour)
) WITHOUT ROWID;
CREATE INDEX mon_hourly_org ON mon_hourly (org_id, hour);

CREATE TABLE mon_daily (
  org_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  day TEXT NOT NULL,
  up INTEGER NOT NULL,
  down INTEGER NOT NULL,
  avg_ms INTEGER,
  p95_ms INTEGER,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID;
CREATE INDEX mon_daily_org ON mon_daily (org_id, day);

CREATE TABLE mon_state_changes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  status TEXT NOT NULL,                         -- up | down
  at INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT
);
CREATE INDEX mon_state_changes_monitor ON mon_state_changes (monitor_id, at);

CREATE TABLE mon_failures (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status_code INTEGER,
  ms INTEGER,
  error TEXT
);
CREATE INDEX mon_failures_monitor ON mon_failures (monitor_id, at);

CREATE TABLE mon_channels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- email | slack | discord | teams | telegram | webhook
  config TEXT NOT NULL,                         -- JSON, shape depends on kind
  enabled INTEGER NOT NULL DEFAULT 1,
  notify_recovery INTEGER NOT NULL DEFAULT 1,
  notify_slow INTEGER NOT NULL DEFAULT 0,
  repeat_min INTEGER NOT NULL DEFAULT 0,        -- remind again every X minutes while down, 0 = never
  quiet_from TEXT,                              -- HH:MM in the workspace time zone
  quiet_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mon_channels_org ON mon_channels (org_id, created_at);

CREATE TABLE mon_alerts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  monitor_id TEXT,
  channel_id TEXT,
  channel_name TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- down | up | slow | repeat | test | maintenance
  outcome TEXT NOT NULL,                        -- sent | failed | skipped
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX mon_alerts_monitor ON mon_alerts (org_id, monitor_id, at);
CREATE INDEX mon_alerts_org ON mon_alerts (org_id, at);

CREATE TABLE mon_incidents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'investigating', -- investigating | identified | monitoring | resolved
  impact TEXT NOT NULL DEFAULT 'minor',         -- minor | major | critical
  monitor_id TEXT,                              -- set when a monitor opened it
  auto INTEGER NOT NULL DEFAULT 0,
  component_ids TEXT,                           -- JSON array, empty = shown on every page
  postmortem TEXT,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mon_incidents_org ON mon_incidents (org_id, started_at);
CREATE INDEX mon_incidents_monitor ON mon_incidents (monitor_id);

CREATE TABLE mon_incident_updates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  author TEXT
);
CREATE INDEX mon_incident_updates_incident ON mon_incident_updates (incident_id, at);

CREATE TABLE mon_maintenance (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  starts_at INTEGER NOT NULL,                   -- first occurrence
  duration_min INTEGER NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none',      -- none | daily | weekly | monthly
  recur_until INTEGER,
  monitor_ids TEXT,                             -- JSON array, empty = every monitor
  notify INTEGER NOT NULL DEFAULT 1,
  started_for INTEGER,                          -- occurrence start we already announced
  ended_for INTEGER,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mon_maintenance_org ON mon_maintenance (org_id, starts_at);

CREATE TABLE mon_pages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  website_url TEXT,
  custom_css TEXT,
  published INTEGER NOT NULL DEFAULT 1,
  hide_from_search INTEGER NOT NULL DEFAULT 0,
  allow_subscribe INTEGER NOT NULL DEFAULT 1,
  uptime_days INTEGER NOT NULL DEFAULT 90,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mon_pages_slug ON mon_pages (slug);
CREATE INDEX mon_pages_org ON mon_pages (org_id, created_at);

CREATE TABLE mon_groups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mon_groups_page ON mon_groups (page_id, position);

CREATE TABLE mon_components (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  group_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  monitor_id TEXT,
  manual_status TEXT,                           -- operational | degraded | partial | major, used when no monitor
  position INTEGER NOT NULL DEFAULT 0,
  show_uptime INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX mon_components_page ON mon_components (page_id, position);
CREATE INDEX mon_components_monitor ON mon_components (monitor_id);

CREATE TABLE mon_subscribers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | confirmed | unsubscribed
  token TEXT NOT NULL,
  component_ids TEXT,                           -- JSON array, empty = everything on the page
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  sample INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX mon_subscribers_email ON mon_subscribers (page_id, email);
CREATE UNIQUE INDEX mon_subscribers_token ON mon_subscribers (token);
