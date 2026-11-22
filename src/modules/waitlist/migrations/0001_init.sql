-- Waitlist: waitlists, people on them, reward tiers, invite waves, broadcasts and page views.
-- Position is never stored. `score` is signup order adjusted by referrals; position is a count over it.

CREATE TABLE wl_waitlists (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  headline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  button_text TEXT NOT NULL DEFAULT 'Join the waitlist',
  success_message TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  show_count INTEGER NOT NULL DEFAULT 1,
  launch_at INTEGER,
  questions TEXT NOT NULL DEFAULT '[]',
  double_optin INTEGER NOT NULL DEFAULT 1,
  fraud_level TEXT NOT NULL DEFAULT 'balanced',
  blocked_domains TEXT NOT NULL DEFAULT '',
  allowed_domains TEXT NOT NULL DEFAULT '',
  disposable_domains TEXT NOT NULL DEFAULT '',
  skip_per_referral INTEGER NOT NULL DEFAULT 5,
  head_start INTEGER NOT NULL DEFAULT 0,
  leaderboard_on INTEGER NOT NULL DEFAULT 1,
  leaderboard_size INTEGER NOT NULL DEFAULT 10,
  invite_url TEXT,
  anon_count INTEGER NOT NULL DEFAULT 0,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX wl_waitlists_slug ON wl_waitlists (slug);
CREATE INDEX wl_waitlists_org ON wl_waitlists (org_id, created_at);

CREATE TABLE wl_signups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  answers TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT ',',
  source TEXT NOT NULL DEFAULT '',
  medium TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  visitor TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  token TEXT NOT NULL,
  seq INTEGER NOT NULL,
  adj REAL NOT NULL DEFAULT 0,
  score REAL GENERATED ALWAYS AS (seq + adj) STORED,
  manual_offset REAL NOT NULL DEFAULT 0,
  referral_count INTEGER NOT NULL DEFAULT 0,
  referred_by TEXT,
  referral_status TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'pending',
  email_verified INTEGER NOT NULL DEFAULT 0,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  flag_detail TEXT,
  flagged_at INTEGER,
  invite_code TEXT,
  invited_at INTEGER,
  wave_id TEXT,
  invite_email_at INTEGER,
  accepted_at INTEGER,
  processed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX wl_signups_email ON wl_signups (waitlist_id, email);
CREATE INDEX wl_signups_key ON wl_signups (waitlist_id, email_key);
CREATE UNIQUE INDEX wl_signups_seq ON wl_signups (waitlist_id, seq);
CREATE UNIQUE INDEX wl_signups_code ON wl_signups (waitlist_id, code);
CREATE UNIQUE INDEX wl_signups_token ON wl_signups (token);
CREATE INDEX wl_signups_queue ON wl_signups (waitlist_id, is_test, status, score, seq);
CREATE INDEX wl_signups_referrer ON wl_signups (waitlist_id, referred_by, created_at);
CREATE INDEX wl_signups_visitor ON wl_signups (waitlist_id, visitor, created_at);
CREATE INDEX wl_signups_invite ON wl_signups (invite_code);
CREATE INDEX wl_signups_wave ON wl_signups (wave_id, invite_email_at);
CREATE INDEX wl_signups_day ON wl_signups (waitlist_id, is_test, created_at);

CREATE TABLE wl_tiers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  referrals_required INTEGER NOT NULL,
  name TEXT NOT NULL,
  reward_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX wl_tiers_list ON wl_tiers (waitlist_id, referrals_required);

CREATE TABLE wl_reached (
  org_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  signup_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  reached_at INTEGER NOT NULL,
  PRIMARY KEY (signup_id, tier_id)
);
CREATE INDEX wl_reached_tier ON wl_reached (tier_id);

CREATE TABLE wl_waves (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at INTEGER,
  base TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX wl_waves_list ON wl_waves (waitlist_id, created_at);
CREATE INDEX wl_waves_due ON wl_waves (status, scheduled_at);

CREATE TABLE wl_broadcasts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  segment TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL DEFAULT '',
  test_hash TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX wl_broadcasts_list ON wl_broadcasts (waitlist_id, created_at);

CREATE TABLE wl_daily (
  org_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (waitlist_id, day)
);
