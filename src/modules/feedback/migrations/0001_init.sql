-- Feedback: boards, posts, votes, comments, changelog, subscribers and the mail queue.
-- Every table has org_id. Times are milliseconds. Rows made by "Add sample data" have sample = 1.

CREATE TABLE fb_portals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'paper',
  accent TEXT,
  show_powered INTEGER NOT NULL DEFAULT 0,
  vote_limit INTEGER NOT NULL DEFAULT 0,
  allow_anonymous INTEGER NOT NULL DEFAULT 1,
  hide_last_names INTEGER NOT NULL DEFAULT 0,
  roadmap_on INTEGER NOT NULL DEFAULT 1,
  changelog_on INTEGER NOT NULL DEFAULT 1,
  default_sort TEXT NOT NULL DEFAULT 'top',
  reply_to TEXT,
  digest_emails TEXT NOT NULL DEFAULT '',
  widget_seen_at INTEGER,
  widget_host TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_portals_slug ON fb_portals (slug);
CREATE UNIQUE INDEX fb_portals_org ON fb_portals (org_id);

CREATE TABLE fb_boards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  voting_on INTEGER NOT NULL DEFAULT 1,
  hide_votes INTEGER NOT NULL DEFAULT 0,
  moderate INTEGER NOT NULL DEFAULT 0,
  posting_on INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_boards_slug ON fb_boards (org_id, slug);

CREATE TABLE fb_categories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fb_categories_board ON fb_categories (org_id, board_id);

CREATE TABLE fb_statuses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'neutral',
  kind TEXT NOT NULL DEFAULT 'open',
  position INTEGER NOT NULL DEFAULT 0,
  in_roadmap INTEGER NOT NULL DEFAULT 0,
  is_initial INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fb_statuses_org ON fb_statuses (org_id, position);

CREATE TABLE fb_tags (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX fb_tags_name ON fb_tags (org_id, name);

CREATE TABLE fb_people (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT,
  name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'guest',
  external_id TEXT,
  visitor_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  mail_off INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_people_email ON fb_people (org_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX fb_people_ext ON fb_people (org_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX fb_people_visitor ON fb_people (org_id, visitor_id) WHERE visitor_id IS NOT NULL;

CREATE TABLE fb_posts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_id TEXT,
  created_by TEXT,
  category_id TEXT,
  status_id TEXT,
  review TEXT NOT NULL DEFAULT 'published',
  held_reason TEXT,
  merged_into TEXT,
  decline_reason TEXT,
  assignee TEXT,
  source TEXT NOT NULL DEFAULT 'portal',
  vote_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  trend REAL NOT NULL DEFAULT 0,
  voted_milestone INTEGER NOT NULL DEFAULT 0,
  first_reply_at INTEGER,
  status_changed_at INTEGER,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_posts_slug ON fb_posts (org_id, slug);
CREATE INDEX fb_posts_board_top ON fb_posts (org_id, board_id, review, vote_count DESC, id DESC);
CREATE INDEX fb_posts_board_new ON fb_posts (org_id, board_id, review, id DESC);
CREATE INDEX fb_posts_board_trend ON fb_posts (org_id, board_id, review, trend DESC, id DESC);
CREATE INDEX fb_posts_status ON fb_posts (org_id, status_id, review);
CREATE INDEX fb_posts_review ON fb_posts (org_id, review, created_at);
CREATE INDEX fb_posts_author ON fb_posts (org_id, author_id);

CREATE TABLE fb_post_tags (
  org_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX fb_post_tags_tag ON fb_post_tags (org_id, tag_id);

CREATE TABLE fb_votes (
  org_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'portal',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_votes_one ON fb_votes (post_id, person_id);
CREATE INDEX fb_votes_person ON fb_votes (org_id, person_id);
CREATE INDEX fb_votes_day ON fb_votes (org_id, created_at);

CREATE TABLE fb_comments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  author_id TEXT,
  staff_user TEXT,
  staff_name TEXT,
  body TEXT NOT NULL,
  review TEXT NOT NULL DEFAULT 'published',
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX fb_comments_post ON fb_comments (org_id, post_id, created_at);
CREATE INDEX fb_comments_day ON fb_comments (org_id, created_at);
CREATE INDEX fb_comments_review ON fb_comments (org_id, review);

CREATE TABLE fb_notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX fb_notes_post ON fb_notes (org_id, post_id, created_at);

CREATE TABLE fb_status_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX fb_status_log_org ON fb_status_log (org_id, at);
CREATE INDEX fb_status_log_post ON fb_status_log (org_id, post_id);

CREATE TABLE fb_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'draft',
  publish_at INTEGER,
  published_at INTEGER,
  mailed_at INTEGER,
  complete_posts INTEGER NOT NULL DEFAULT 1,
  author_name TEXT NOT NULL DEFAULT '',
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_entries_slug ON fb_entries (org_id, slug);
CREATE INDEX fb_entries_state ON fb_entries (org_id, state, published_at DESC);
CREATE INDEX fb_entries_due ON fb_entries (state, publish_at);

CREATE TABLE fb_entry_posts (
  org_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, post_id)
);
CREATE INDEX fb_entry_posts_post ON fb_entry_posts (org_id, post_id);

CREATE TABLE fb_images (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE fb_subscribers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  frequency TEXT NOT NULL DEFAULT 'each',
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_sent_at INTEGER
);
CREATE UNIQUE INDEX fb_subscribers_email ON fb_subscribers (org_id, email);
CREATE INDEX fb_subscribers_status ON fb_subscribers (org_id, status, frequency);

CREATE TABLE fb_codes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX fb_codes_email ON fb_codes (org_id, email, created_at);

-- One row per "tell people about this" job. The cursor makes a long send resumable.
CREATE TABLE fb_outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  post_id TEXT,
  entry_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  cursor TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',
  sent INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX fb_outbox_state ON fb_outbox (org_id, state, created_at);

CREATE TABLE fb_deliveries (
  outbox_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  to_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  at INTEGER NOT NULL,
  PRIMARY KEY (outbox_id, to_key)
);

-- Counters stay in step with the rows that cause them, inside the same statement, so no code path can forget.
CREATE TRIGGER fb_votes_added AFTER INSERT ON fb_votes BEGIN
  UPDATE fb_posts SET vote_count = vote_count + 1, trend = trend + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER fb_votes_removed AFTER DELETE ON fb_votes BEGIN
  UPDATE fb_posts SET vote_count = MAX(vote_count - 1, 0), trend = MAX(trend - 1, 0) WHERE id = OLD.post_id;
END;
CREATE TRIGGER fb_comments_added AFTER INSERT ON fb_comments WHEN NEW.review = 'published' BEGIN
  UPDATE fb_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER fb_comments_published AFTER UPDATE OF review ON fb_comments WHEN OLD.review <> 'published' AND NEW.review = 'published' BEGIN
  UPDATE fb_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER fb_comments_unpublished AFTER UPDATE OF review ON fb_comments WHEN OLD.review = 'published' AND NEW.review <> 'published' BEGIN
  UPDATE fb_posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = NEW.post_id;
END;
CREATE TRIGGER fb_comments_moved AFTER UPDATE OF post_id ON fb_comments WHEN OLD.review = 'published' AND OLD.post_id <> NEW.post_id BEGIN
  UPDATE fb_posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = OLD.post_id;
  UPDATE fb_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER fb_comments_removed AFTER DELETE ON fb_comments WHEN OLD.review = 'published' BEGIN
  UPDATE fb_posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = OLD.post_id;
END;
