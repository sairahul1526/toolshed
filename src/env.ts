/**
 * Bindings and per-request variables shared by every route.
 * See docs/architecture.md for what each one is for.
 */

/** A message on the jobs queue. `name` is `<moduleId>.<job>`, for example `links.rollup`. */
export interface JobMessage {
  name: string;
  payload: unknown;
}

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  FILES: R2Bucket;
  JOBS: Queue<JobMessage>;
  ASSETS: Fetcher;

  /** "dev" turns on the /dev routes (UI kitchen sink, email outbox). Anything else is production. */
  ENVIRONMENT?: string;
  /** Signs sessions, JWTs and one-time links. Set once at deploy. */
  AUTH_SECRET: string;
  /** Only this email may claim a fresh install. */
  OWNER_EMAIL?: string;
  /** Public base URL, for example https://tools.example.com. Read from the request when unset. */
  APP_URL?: string;
  /** The address emails come from until the owner picks one on the Email screen, for example hello@example.com. */
  EMAIL_FROM?: string;

  /** PBKDF2 rounds for new password hashes, 10000 to 100000. See docs/passwords.md. */
  TOOLSHED_PASSWORD_ITERATIONS?: string;

  /** Optional bindings. Features that need them show "Needs setup" until they exist. */
  EMAIL?: SendEmail;
  EVENTS?: AnalyticsEngineDataset;
  AI?: Ai;
}

/** Workspace roles, strongest first. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** True when `role` is at least as strong as `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) <= ROLES.indexOf(min);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  /** The person who claimed this install. Sees the Owner section (Users, Audit log, Updates). */
  isInstanceOwner: boolean;
}

/** The active workspace and the caller's role in it. */
export interface ActiveOrg {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

/** How this request proved who it is. */
export interface AuthInfo {
  kind: 'anon' | 'session' | 'apikey' | 'jwt';
  /** Module scopes such as `links:write`. A session has `*`; keys and JWTs list theirs. */
  scopes: string[];
  /** Set for API keys. */
  keyId?: string;
  /** The member behind a personal key, or behind a token a signed-in person asked for. Not set for service keys. */
  userId?: string;
  /**
   * Set on a "sign in as" session: the id of the install owner who is acting as this person.
   * Audit lines carry it, and nothing that would outlive the session (keys, tokens, webhook
   * secrets, exports) can be made while it is set.
   */
  impersonatedBy?: string;
}

export interface Vars {
  requestId: string;
  user: SessionUser | null;
  org: ActiveOrg | null;
  auth: AuthInfo;
}

export type AppEnv = { Bindings: Env; Variables: Vars };

export function isDev(env: Env): boolean {
  return env.ENVIRONMENT === 'dev' || env.ENVIRONMENT === 'test';
}
