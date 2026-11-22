/**
 * Small pieces that show a key the same way everywhere on the screen: its state, its
 * permissions, when it was last used and when it stops working.
 */
import { listScopes } from '../../core/apikeys';
import type { ApiKey, KeyRole } from '../../core/apikeys';
import { allModules } from '../../core/registry';
import { formatDate, Pill, plural, timeAgo } from '../../ui';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A key this close to its end shows a warning, so nobody is surprised by an outage. */
const EXPIRING_SOON_DAYS = 14;
/** A key nobody has used for this long is probably forgotten. */
const STALE_AFTER_DAYS = 60;
const MAX_TAGS_IN_TABLE = 3;

export type ShownStatus = 'active' | 'expiring' | 'expired' | 'revoked';

export function shownStatus(key: ApiKey, now: number): ShownStatus {
  if (key.status !== 'active') return key.status;
  if (key.expiresAt !== null && key.expiresAt - now <= EXPIRING_SOON_DAYS * DAY_MS) return 'expiring';
  return 'active';
}

const STATUS: Record<ShownStatus, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  active: { label: 'Active', tone: 'good' },
  expiring: { label: 'Expiring soon', tone: 'warn' },
  expired: { label: 'Expired', tone: 'bad' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

export function StatusPill({ status }: { status: ShownStatus }) {
  return <Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>;
}

export function roleLabel(role: KeyRole): string {
  return role === 'admin' ? 'Admin' : role === 'member' ? 'Member' : 'Viewer';
}

function moduleName(id: string): string {
  return allModules().find((m) => m.id === id)?.name ?? id;
}

/** Plain words for a scope. A scope no module declares any more is shown as it was saved. */
export function scopeText(scope: string): string {
  if (scope === '*') return 'Full access';
  if (scope.endsWith(':*')) return `Everything in ${moduleName(scope.slice(0, -2))}`;
  return listScopes().find((s) => s.scope === scope)?.label ?? scope;
}

/** The permissions as small tags. Full access is one loud tag, never a list. */
export function ScopeTags({ scopes, all }: { scopes: string[]; all?: boolean }) {
  if (scopes.includes('*')) return <Pill tone="warn">Full access</Pill>;
  const shown = all ? scopes : scopes.slice(0, MAX_TAGS_IN_TABLE);
  return (
    <div class="tags">
      {shown.map((s) => (
        <span class="tag" title={scopeText(s)}>
          {s}
        </span>
      ))}
      {shown.length < scopes.length ? <span class="tag">+{scopes.length - shown.length} more</span> : null}
    </div>
  );
}

export function LastUsed({ apiKey, now }: { apiKey: ApiKey; now: number }) {
  if (apiKey.lastUsedAt === null) return <span class="muted">Never used</span>;
  const days = Math.floor((now - apiKey.lastUsedAt) / DAY_MS);
  if (days >= STALE_AFTER_DAYS) return <Pill>Not in {plural(days, 'day')}</Pill>;
  const text = `${timeAgo(apiKey.lastUsedAt, now)}${apiKey.lastUsedIp ? ` from ${apiKey.lastUsedIp}` : ''}`;
  return (
    <span class="muted trunc" title={text}>
      {text}
    </span>
  );
}

export function Expiry({ apiKey, now }: { apiKey: ApiKey; now: number }) {
  if (apiKey.expiresAt === null) return <span class="muted">Never</span>;
  const status = shownStatus(apiKey, now);
  if (status === 'expired') return <Pill tone="bad">Expired {formatDate(apiKey.expiresAt)}</Pill>;
  if (status === 'expiring') {
    const days = Math.max(1, Math.ceil((apiKey.expiresAt - now) / DAY_MS));
    return <Pill tone="warn">In {plural(days, 'day')}</Pill>;
  }
  return <span class="muted">{formatDate(apiKey.expiresAt)}</span>;
}

export function MadeBy({ label, at }: { label: string | null; at: number }) {
  const name = label ?? 'Unknown';
  return (
    <div>
      <span class="trunc" title={name}>
        {name}
      </span>
      <div class="muted">{formatDate(at)}</div>
    </div>
  );
}

function stateNote(key: ApiKey, status: ShownStatus, now: number): string {
  if (status === 'revoked') return key.revokedAt === null ? 'Revoked' : `Revoked ${formatDate(key.revokedAt)}`;
  if (key.expiresAt === null) return 'Never expires';
  if (status === 'expired') return `Expired ${formatDate(key.expiresAt)}`;
  if (status === 'expiring') return `Stops in ${plural(Math.max(1, Math.ceil((key.expiresAt - now) / DAY_MS)), 'day')}`;
  return `Until ${formatDate(key.expiresAt)}`;
}

/** The state of a key in the table, with the date that matters for it underneath. */
export function StateCell({ apiKey, now }: { apiKey: ApiKey; now: number }) {
  const status = shownStatus(apiKey, now);
  return (
    <div>
      <div>
        <StatusPill status={status} />
      </div>
      <div class="muted">{stateNote(apiKey, status, now)}</div>
    </div>
  );
}
