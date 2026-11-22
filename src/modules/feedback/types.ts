export type Scalar = string | number | null;

export interface Portal {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  tagline: string;
  theme: string;
  accent: string | null;
  show_powered: number;
  vote_limit: number;
  allow_anonymous: number;
  hide_last_names: number;
  roadmap_on: number;
  changelog_on: number;
  default_sort: string;
  reply_to: string | null;
  digest_emails: string;
  widget_seen_at: number | null;
  widget_host: string | null;
  created_at: number;
  updated_at: number;
}

export interface Board {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
  position: number;
  visibility: 'public' | 'private';
  voting_on: number;
  hide_votes: number;
  moderate: number;
  posting_on: number;
  created_at: number;
}

export interface Category {
  id: string;
  org_id: string;
  board_id: string;
  name: string;
  position: number;
}

export type StatusKind = 'open' | 'active' | 'done' | 'closed';

export interface Status {
  id: string;
  org_id: string;
  name: string;
  tone: string;
  kind: StatusKind;
  position: number;
  in_roadmap: number;
  is_initial: number;
}

export interface Tag {
  id: string;
  org_id: string;
  name: string;
  is_public: number;
}

export type PersonSource = 'email' | 'sso' | 'guest' | 'admin' | 'import' | 'sample' | 'api';

export interface Person {
  id: string;
  org_id: string;
  email: string | null;
  name: string;
  source: PersonSource;
  external_id: string | null;
  visitor_id: string | null;
  verified: number;
  trusted: number;
  blocked: number;
  mail_off: number;
  sample: number;
  created_at: number;
  last_seen_at: number;
}

export type Review = 'published' | 'pending' | 'rejected' | 'merged';

export interface Post {
  id: string;
  org_id: string;
  board_id: string;
  slug: string;
  title: string;
  body: string;
  author_id: string | null;
  created_by: string | null;
  category_id: string | null;
  status_id: string | null;
  review: Review;
  held_reason: string | null;
  merged_into: string | null;
  decline_reason: string | null;
  assignee: string | null;
  source: string;
  vote_count: number;
  comment_count: number;
  trend: number;
  voted_milestone: number;
  first_reply_at: number | null;
  status_changed_at: number | null;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface Comment {
  id: string;
  org_id: string;
  post_id: string;
  author_id: string | null;
  staff_user: string | null;
  staff_name: string | null;
  body: string;
  review: 'published' | 'pending' | 'rejected';
  sample: number;
  created_at: number;
}

export interface Note {
  id: string;
  org_id: string;
  post_id: string;
  user_id: string | null;
  user_name: string;
  body: string;
  created_at: number;
}

export type EntryState = 'draft' | 'scheduled' | 'published';

export interface Entry {
  id: string;
  org_id: string;
  slug: string;
  title: string;
  body: string;
  labels: string;
  state: EntryState;
  publish_at: number | null;
  published_at: number | null;
  mailed_at: number | null;
  complete_posts: number;
  author_name: string;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface Subscriber {
  id: string;
  org_id: string;
  email: string;
  status: 'pending' | 'active' | 'unsubscribed';
  frequency: 'each' | 'weekly' | 'monthly';
  sample: number;
  created_at: number;
  confirmed_at: number | null;
  last_sent_at: number | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_STATUSES: { name: string; tone: string; kind: StatusKind; in_roadmap: number; is_initial: number }[] = [
  { name: 'Open', tone: 'neutral', kind: 'open', in_roadmap: 0, is_initial: 1 },
  { name: 'Under review', tone: 'warn', kind: 'open', in_roadmap: 0, is_initial: 0 },
  { name: 'Planned', tone: 'neutral', kind: 'active', in_roadmap: 1, is_initial: 0 },
  { name: 'In progress', tone: 'solid', kind: 'active', in_roadmap: 1, is_initial: 0 },
  { name: 'Complete', tone: 'good', kind: 'done', in_roadmap: 1, is_initial: 0 },
  { name: 'Closed', tone: 'bad', kind: 'closed', in_roadmap: 0, is_initial: 0 },
];
