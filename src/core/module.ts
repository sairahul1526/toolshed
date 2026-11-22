/**
 * The module contract. Each product (links, forms, status page…) is one folder under
 * `src/modules/<id>/` whose `module.ts` default-exports `defineModule({...})`.
 * Nothing else has to be edited to add a module: `scripts/prepare.mjs` finds it.
 */
import type { Context, Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import type { OrgDb } from './db';

/** What a module gets when it runs outside a request (jobs, schedules, sample data, export). */
export interface ModuleContext {
  env: Env;
  org: { id: string; name: string; slug: string };
  db: OrgDb;
}

export type ModuleCategory =
  | 'growth'
  | 'support'
  | 'product'
  | 'insights'
  | 'operations'
  | 'content'
  | 'messaging'
  | 'files';

export interface NavItem {
  label: string;
  /** Path under the module's dashboard root: '' is /app/<id>, 'settings' is /app/<id>/settings. */
  path: string;
}

export interface Permission {
  /** `<moduleId>:<verb>`, for example `links:write`. Used as API key scopes. */
  scope: string;
  label: string;
}

/** A usage event. Counted per day for stats, kept in a short recent log, and sent to subscribers. */
export interface AppEvent {
  orgId: string;
  /** Module id that emitted it. */
  module: string;
  /** `<noun>.<verb>`, for example `link.clicked`. The full name is `<module>.<name>`. */
  name: string;
  /** Id of the thing it happened to, when there is one. */
  subject?: string;
  data?: Record<string, unknown>;
  /** How many to count. Defaults to 1. */
  count?: number;
  /** When it happened (ms). Defaults to now. */
  at?: number;
}

export type JobHandler = (env: Env, payload: unknown, meta: { attempt: number }) => Promise<void>;
export type EventHandler = (ctx: ModuleContext, event: AppEvent) => Promise<void>;

export interface Schedule {
  name: string;
  every: 'minute' | '5min' | 'hour' | 'day';
  /** Runs once per period for the whole install, not per workspace. */
  run: (env: Env, at: Date) => Promise<void>;
}

export interface SetupStatus {
  status: 'ready' | 'needs_setup';
  /** Plain sentence shown on the Modules screen when setup is needed. */
  reason?: string;
  action?: { label: string; href: string };
}

export interface KpiStat {
  label: string;
  value: string;
  /** For example "+12% vs last week". */
  delta?: string;
  href?: string;
}

export interface ModuleDef {
  /** Lowercase letters, digits and dashes. Also the URL segment: /app/<id>, /api/v1/<id>. */
  id: string;
  name: string;
  /** One line for the Modules screen and the onboarding card. No full stop needed. */
  description: string;
  /** Icon name from the UI kit's sprite (src/ui/icons). */
  icon: string;
  category: ModuleCategory;
  version: string;

  /** Extra sidebar sub-pages. The module always gets one sidebar entry pointing at /app/<id>. */
  nav?: NavItem[];
  permissions?: Permission[];

  /** Dashboard screens, mounted at /app/<id>. Only reached by signed-in workspace members with the module on. */
  dashboard?: Hono<AppEnv>;
  /** REST API, mounted at /api/v1/<id>. Reached with a session, an API key or a JWT, with the module on. */
  api?: Hono<AppEnv>;
  /** Public pages, embeds and collect endpoints, mounted at /. No sign-in. Must stay under `publicPrefixes`. */
  public?: Hono<AppEnv>;
  /** Top-level paths this module owns, for example ['/status', '/s']. Checked for clashes at build time. */
  publicPrefixes?: string[];
  /** Last-chance handler for paths nothing else matched (short links live at /<code>). Return null to pass. */
  fallback?: (c: Context<AppEnv>) => Promise<Response | null>;

  /** Background jobs by short name. `enqueue(env, '<id>.<name>', payload)` runs `jobs[name]`. */
  jobs?: Record<string, JobHandler>;
  schedules?: Schedule[];
  events?: {
    /** Names this module emits, for docs and the automations module later. */
    emits?: string[];
    /** Handlers for other modules' events, keyed by full name `<module>.<name>`. */
    on?: Record<string, EventHandler>;
  };

  /** Is this module ready to use in this workspace? Defaults to ready. */
  setup?: (ctx: ModuleContext) => Promise<SetupStatus>;
  /** Number shown next to the sidebar entry (for example how many links). */
  count?: (ctx: ModuleContext) => Promise<number | null>;
  /** Up to 2 numbers for the Overview page. */
  overview?: (ctx: ModuleContext) => Promise<KpiStat[]>;
  /** The "What do you want to do first?" card. `href` is where the card's button goes (default /app/<id>). */
  onboarding?: { title: string; body: string; href?: string };

  /**
   * Every table this module owns. Each must have an `org_id` column. Used to delete a workspace's
   * data, and as the default export when `exportData` is not given.
   */
  tables?: string[];

  /** Fill the workspace with believable sample rows, every one marked so `clearSampleData` can find it. */
  sampleData?: (ctx: ModuleContext) => Promise<void>;
  clearSampleData?: (ctx: ModuleContext) => Promise<void>;
  /** Everything this module stores for the workspace, as table name → rows. Used by Export. */
  exportData?: (ctx: ModuleContext) => Promise<Record<string, unknown[]>>;
}

const ID = /^[a-z][a-z0-9-]{1,30}$/;

/** Names the core owns (dashboard screens, core API routes, top-level paths); a module id may not reuse one. */
export const RESERVED_IDS = [
  'overview', 'welcome', 'modules', 'members', 'appearance', 'api-keys', 'settings', 'account',
  'users', 'audit-log', 'updates', 'email', 'core', 'auth', 'app', 'api', 'assets', 'dev', 'setup',
  'sign-in', 'sign-up', 'sign-out', 'invite', 'healthz', 'm',
  'token', 'keys', 'export', 'me', 'workspace', 'events', 'audit', 'notifications', 'search', 'jobs', 'errors',
];

export function defineModule(def: ModuleDef): ModuleDef {
  if (!ID.test(def.id)) throw new Error(`Bad module id: ${def.id}`);
  if (RESERVED_IDS.includes(def.id)) throw new Error(`Module id is reserved: ${def.id}`);
  for (const table of def.tables ?? []) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Bad table name in ${def.id}: ${table}`);
  }
  for (const prefix of def.publicPrefixes ?? []) {
    if (!/^\/[a-z0-9][a-z0-9._-]*$/.test(prefix)) throw new Error(`Bad public prefix in ${def.id}: ${prefix}`);
  }
  return def;
}
