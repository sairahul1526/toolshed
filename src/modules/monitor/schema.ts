/** Row types and input validation for every Monitor table. Forms and the API share these schemas. */
import { z } from 'zod';
import { parseJson } from '../../core/db';

export const INTERVALS = [1, 5, 10, 30] as const;
export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const CHANNEL_KINDS = ['email', 'slack', 'discord', 'teams', 'telegram', 'webhook'] as const;
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const IMPACTS = ['minor', 'major', 'critical'] as const;
export const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'] as const;
export const MANUAL_STATUSES = ['operational', 'degraded', 'partial', 'major'] as const;

export type MonitorType = 'http' | 'heartbeat';
export type MonitorStatus = 'pending' | 'up' | 'down';
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type Impact = (typeof IMPACTS)[number];
export type Recurrence = (typeof RECURRENCES)[number];

export interface MonitorRow {
  id: string;
  org_id: string;
  name: string;
  type: MonitorType;
  url: string | null;
  method: string;
  headers: string | null;
  body: string | null;
  expected_status: string;
  keyword: string | null;
  keyword_mode: 'none' | 'present' | 'absent';
  timeout_ms: number;
  follow_redirects: number;
  interval_min: number;
  slot: number;
  fail_after: number;
  slow_ms: number | null;
  slow_after: number;
  auto_incident: number;
  channel_ids: string | null;
  hb_token: string | null;
  hb_period_sec: number | null;
  hb_grace_sec: number;
  hb_last_ping_at: number | null;
  hb_last_kind: string | null;
  hb_last_code: number | null;
  hb_last_note: string | null;
  hb_started_at: number | null;
  hb_win_start: number;
  hb_win_count: number;
  paused: number;
  status: MonitorStatus;
  slow: number;
  fail_streak: number;
  slow_streak: number;
  since_at: number | null;
  last_error: string | null;
  last_code: number | null;
  incident_id: string | null;
  notified: string | null;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface ChannelRow {
  id: string;
  org_id: string;
  name: string;
  kind: ChannelKind;
  config: string;
  enabled: number;
  notify_recovery: number;
  notify_slow: number;
  repeat_min: number;
  quiet_from: string | null;
  quiet_to: string | null;
  created_at: number;
  updated_at: number;
}

export interface IncidentRow {
  id: string;
  org_id: string;
  title: string;
  status: IncidentStatus;
  impact: Impact;
  monitor_id: string | null;
  auto: number;
  component_ids: string | null;
  postmortem: string | null;
  started_at: number;
  resolved_at: number | null;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface IncidentUpdateRow {
  id: string;
  org_id: string;
  incident_id: string;
  status: IncidentStatus;
  body: string;
  at: number;
  author: string | null;
}

export interface MaintenanceRow {
  id: string;
  org_id: string;
  title: string;
  body: string | null;
  starts_at: number;
  duration_min: number;
  recurrence: Recurrence;
  recur_until: number | null;
  monitor_ids: string | null;
  notify: number;
  started_for: number | null;
  ended_for: number | null;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface PageRow {
  id: string;
  org_id: string;
  slug: string;
  title: string;
  description: string | null;
  website_url: string | null;
  custom_css: string | null;
  published: number;
  hide_from_search: number;
  allow_subscribe: number;
  uptime_days: number;
  sample: number;
  created_at: number;
  updated_at: number;
}

export interface GroupRow {
  id: string;
  org_id: string;
  page_id: string;
  name: string;
  position: number;
  collapsed: number;
}

export interface ComponentRow {
  id: string;
  org_id: string;
  page_id: string;
  group_id: string | null;
  name: string;
  description: string | null;
  monitor_id: string | null;
  manual_status: (typeof MANUAL_STATUSES)[number] | null;
  position: number;
  show_uptime: number;
}

export interface SubscriberRow {
  id: string;
  org_id: string;
  page_id: string;
  email: string;
  status: 'pending' | 'confirmed' | 'unsubscribed';
  token: string;
  component_ids: string | null;
  created_at: number;
  confirmed_at: number | null;
  sample: number;
}

export const ids = (value: string | null): string[] => parseJson<string[]>(value, []).filter((v) => typeof v === 'string');

// ---------------------------------------------------------------------------------------------
// Input helpers. Dashboard forms send strings; the API sends real types. Both end up here.
// ---------------------------------------------------------------------------------------------

const truthy = new Set(['1', 'true', 'on', 'yes']);
const bool = z.preprocess((v) => (typeof v === 'string' ? truthy.has(v.toLowerCase()) : v), z.boolean());
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const int = (min: number, max: number, label: string) =>
  z.preprocess(blankToUndefined, z.coerce.number({ error: `${label} must be a number.` }).int(`${label} must be a whole number.`).min(min, `${label} must be at least ${min}.`).max(max, `${label} can’t be more than ${max}.`));
const optInt = (min: number, max: number, label: string) => z.preprocess((v) => (v === null ? undefined : blankToUndefined(v)), int(min, max, label).optional());
const optText = (max: number, label: string) =>
  z.preprocess((v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v), z.string().trim().max(max, `${label} is too long (most ${max} characters).`).optional());

/** Parse "200-299", "200,301" or "2xx" into a checker. Returns null when the text is not valid. */
export function parseStatusSpec(spec: string): ((code: number) => boolean) | null {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 20) return null;
  const tests: ((code: number) => boolean)[] = [];
  for (const part of parts) {
    let m = /^([1-5])xx$/i.exec(part);
    if (m) {
      const hundred = Number(m[1]);
      tests.push((c) => Math.floor(c / 100) === hundred);
      continue;
    }
    m = /^(\d{3})-(\d{3})$/.exec(part);
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (lo > hi || lo < 100 || hi > 599) return null;
      tests.push((c) => c >= lo && c <= hi);
      continue;
    }
    m = /^(\d{3})$/.exec(part);
    if (m) {
      const code = Number(m[1]);
      if (code < 100 || code > 599) return null;
      tests.push((c) => c === code);
      continue;
    }
    return null;
  }
  return (code) => tests.some((t) => t(code));
}

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'keep-alive', 'proxy-authorization']);

/** Accept `{ "X-Key": "v" }` or lines of `Name: value`. Returns a clean object or throws a message. */
export function parseHeaders(input: unknown): Record<string, string> {
  if (input === undefined || input === null || input === '') return {};
  let entries: [string, string][];
  if (typeof input === 'string') {
    entries = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(':');
        if (i < 1) throw new Error(`“${line.slice(0, 30)}” isn’t a header. Write one per line like Name: value.`);
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()] as [string, string];
      });
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    entries = Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string]);
  } else {
    throw new Error('Headers must be an object or lines like Name: value.');
  }
  if (entries.length > 20) throw new Error('Use at most 20 headers.');
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,60}$/.test(name)) throw new Error(`“${name.slice(0, 30)}” isn’t a valid header name.`);
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new Error(`The ${name} header is set for you and can’t be changed.`);
    if (value.length > 1000 || /[\r\n]/.test(value)) throw new Error(`The value of ${name} is too long or has a line break.`);
    out[name] = value;
  }
  return out;
}

export const monitorSchema = z.object({
  name: optText(100, 'The name'),
  type: z.enum(['http', 'heartbeat'], { error: 'Choose http or heartbeat.' }).optional(),
  url: optText(2000, 'The address'),
  method: z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(METHODS, { error: 'Choose a method like GET or POST.' })).optional(),
  headers: z.unknown().optional(),
  body: optText(10_000, 'The request body'),
  expectedStatus: optText(100, 'Expected status'),
  keyword: optText(200, 'The keyword'),
  keywordMode: z.enum(['none', 'present', 'absent'], { error: 'Choose none, present or absent.' }).optional(),
  timeoutMs: optInt(1000, 30_000, 'The timeout'),
  followRedirects: bool.optional(),
  intervalMin: z.preprocess(blankToUndefined, z.coerce.number().pipe(z.union(INTERVALS.map((n) => z.literal(n)) as unknown as [z.ZodLiteral<1>, z.ZodLiteral<5>, z.ZodLiteral<10>, z.ZodLiteral<30>], { error: 'Choose 1, 5, 10 or 30 minutes.' }))).optional(),
  failAfter: optInt(1, 10, 'Failed checks before down'),
  slowMs: z.preprocess((v) => (v === '' || v === 0 || v === '0' ? null : v), z.union([z.null(), int(50, 60_000, 'The slow threshold')]).optional()),
  slowAfter: optInt(1, 20, 'Slow checks in a row'),
  autoIncident: bool.optional(),
  channelIds: z.union([z.array(z.string()), z.null()]).optional(),
  hbPeriodSec: optInt(60, 31 * 86_400, 'The expected period'),
  hbGraceSec: optInt(0, 7 * 86_400, 'The grace period'),
});

export type MonitorInput = z.infer<typeof monitorSchema>;

export const channelSchema = z.object({
  name: z.string({ error: 'Give the channel a name.' }).trim().min(1, 'Give the channel a name.').max(80, 'Keep the name under 80 characters.'),
  kind: z.enum(CHANNEL_KINDS, { error: 'Choose email, Slack, Discord, Teams, Telegram or webhook.' }),
  config: z.record(z.string(), z.unknown()),
  enabled: bool.optional(),
  notifyRecovery: bool.optional(),
  notifySlow: bool.optional(),
  repeatMin: optInt(0, 10_080, 'Repeat reminder'),
  quietFrom: z.preprocess(blankToUndefined, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, like 22:00.').optional()),
  quietTo: z.preprocess(blankToUndefined, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, like 07:00.').optional()),
});

export const incidentSchema = z.object({
  title: z.string({ error: 'Give the incident a title.' }).trim().min(1, 'Give the incident a title.').max(150, 'Keep the title under 150 characters.'),
  status: z.enum(INCIDENT_STATUSES, { error: 'Choose investigating, identified, monitoring or resolved.' }).optional(),
  impact: z.enum(IMPACTS, { error: 'Choose minor, major or critical.' }).optional(),
  body: optText(5000, 'The message'),
  componentIds: z.array(z.string()).max(100).optional(),
  monitorId: z.string().optional(),
});

export const incidentUpdateSchema = z.object({
  status: z.enum(INCIDENT_STATUSES, { error: 'Choose investigating, identified, monitoring or resolved.' }),
  body: z.string({ error: 'Write what changed.' }).trim().min(1, 'Write what changed.').max(5000, 'Keep the update under 5000 characters.'),
});

const when = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' && !/^\d+$/.test(v.trim()) ? Date.parse(v.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`) : v),
  z.coerce.number({ error: 'Enter a date and time.' }).int().min(0, 'Enter a date and time.'),
);

export const maintenanceSchema = z.object({
  title: z.string({ error: 'Give the window a title.' }).trim().min(1, 'Give the window a title.').max(150, 'Keep the title under 150 characters.'),
  body: optText(2000, 'The note'),
  startsAt: when,
  durationMin: int(1, 14 * 24 * 60, 'The length'),
  recurrence: z.enum(RECURRENCES, { error: 'Choose none, daily, weekly or monthly.' }).optional(),
  recurUntil: z.preprocess((v) => (v === null || v === '' ? undefined : v), when.optional()),
  monitorIds: z.array(z.string()).max(500).optional(),
  notify: bool.optional(),
});

export const pageSchema = z.object({
  title: z.string({ error: 'Give the page a title.' }).trim().min(1, 'Give the page a title.').max(100, 'Keep the title under 100 characters.'),
  slug: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3 to 40 letters, numbers or dashes.').optional()),
  description: optText(500, 'The description'),
  websiteUrl: optText(500, 'The website address'),
  customCss: optText(20_000, 'The custom CSS'),
  published: bool.optional(),
  hideFromSearch: bool.optional(),
  allowSubscribe: bool.optional(),
  uptimeDays: z.preprocess(blankToUndefined, z.coerce.number().pipe(z.union([z.literal(30), z.literal(60), z.literal(90)], { error: 'Choose 30, 60 or 90 days.' }))).optional(),
});

export const componentSchema = z.object({
  name: z.string({ error: 'Give the component a name.' }).trim().min(1, 'Give the component a name.').max(100, 'Keep the name under 100 characters.'),
  description: optText(300, 'The description'),
  monitorId: z.preprocess(blankToUndefined, z.string().optional()),
  groupId: z.preprocess(blankToUndefined, z.string().optional()),
  manualStatus: z.preprocess(blankToUndefined, z.enum(MANUAL_STATUSES, { error: 'Choose operational, degraded, partial or major.' }).optional()),
  showUptime: bool.optional(),
});

export const groupSchema = z.object({
  name: z.string({ error: 'Give the group a name.' }).trim().min(1, 'Give the group a name.').max(100, 'Keep the name under 100 characters.'),
  collapsed: bool.optional(),
});

export const subscribeSchema = z.object({
  email: z.string({ error: 'Enter your email address.' }).trim().toLowerCase().email('Enter a full address, like you@example.com.').max(254),
  componentIds: z.array(z.string()).max(100).optional(),
});

export const moduleSettingsSchema = z.object({
  aliveUrl: z.preprocess((v) => (v === null ? '' : v), z.string().trim().max(2000, 'That address is too long.')).optional(),
  aliveEveryMin: z.preprocess(blankToUndefined, z.coerce.number().pipe(z.union([z.literal(1), z.literal(5), z.literal(10)], { error: 'Choose 1, 5 or 10 minutes.' }))).optional(),
  keepHourlyDays: optInt(2, 30, 'Hourly history'),
  keepDailyDays: optInt(30, 730, 'Daily history'),
});

export interface MonitorSettings extends Record<string, unknown> {
  aliveUrl: string;
  aliveEveryMin: number;
  keepHourlyDays: number;
  keepDailyDays: number;
}

export const DEFAULT_SETTINGS: MonitorSettings = { aliveUrl: '', aliveEveryMin: 1, keepHourlyDays: 8, keepDailyDays: 400 };
