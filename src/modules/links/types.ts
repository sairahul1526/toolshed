import { parseJson } from '../../core/db';

export type LinkStatus = 'active' | 'archived' | 'disabled';
export type RedirectType = 301 | 302 | 307;

export type LinkState = 'live' | 'scheduled' | 'expired' | 'capped' | 'archived' | 'disabled';

export function linkState(row: Pick<LinkRow, 'status' | 'starts_at' | 'expires_at' | 'click_cap'>, clicks: number, now = Date.now()): LinkState {
  if (row.status === 'archived') return 'archived';
  if (row.status === 'disabled') return 'disabled';
  if (row.starts_at !== null && row.starts_at > now) return 'scheduled';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  if (row.click_cap !== null && clicks >= row.click_cap) return 'capped';
  return 'live';
}

export interface RuleDef {
  kind: 'country' | 'device' | 'os';
  values: string[];
  url: string;
}

export interface LinkRow {
  id: string;
  org_id: string;
  code: string;
  url: string;
  title: string;
  notes: string;
  redirect_type: number;
  status: LinkStatus;
  disabled_reason: string | null;
  folder_id: string | null;
  starts_at: number | null;
  expires_at: number | null;
  click_cap: number | null;
  password_hash: string | null;
  expired_url: string | null;
  forward_query: number;
  rules: string;
  preview_title: string;
  preview_description: string;
  preview_image: string;
  expired_notified: number;
  sample: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface LinkView {
  id: string;
  code: string;
  shortUrl: string;
  url: string;
  title: string;
  notes: string;
  redirectType: number;
  status: LinkStatus;
  /** What visitors get right now: live, waiting for its start time, past its end time, over its click cap, or switched off. */
  state: LinkState;
  disabledReason: string | null;
  folderId: string | null;
  tags: string[];
  startsAt: string | null;
  expiresAt: string | null;
  clickCap: number | null;
  hasPassword: boolean;
  expiredUrl: string | null;
  forwardQuery: boolean;
  rules: RuleDef[];
  preview: { title: string; description: string; image: string };
  clicks: number;
  createdAt: string;
  updatedAt: string;
}

export interface LinksCtx {
  env: import('../../env').Env;
  orgId: string;
  /** Public base address of this install, no trailing slash. */
  base: string;
  actorId?: string | null;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function toView(row: LinkRow, base: string, tags: string[] = [], clicks = 0): LinkView {
  return {
    id: row.id,
    code: row.code,
    shortUrl: `${base}/${row.code}`,
    url: row.url,
    title: row.title,
    notes: row.notes,
    redirectType: row.redirect_type,
    status: row.status,
    state: linkState(row, clicks),
    disabledReason: row.disabled_reason,
    folderId: row.folder_id,
    tags,
    startsAt: iso(row.starts_at),
    expiresAt: iso(row.expires_at),
    clickCap: row.click_cap,
    hasPassword: !!row.password_hash,
    expiredUrl: row.expired_url,
    forwardQuery: row.forward_query === 1,
    rules: parseJson<RuleDef[]>(row.rules, []),
    preview: { title: row.preview_title, description: row.preview_description, image: row.preview_image },
    clicks,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
