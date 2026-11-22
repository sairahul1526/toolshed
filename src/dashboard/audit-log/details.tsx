/** The expanded part of a row: everything stored about one entry, as a key and value list. */
import type { Child } from 'hono/jsx';
import type { AuditRecord } from '../../core/audit';
import { KeyValueList, formatDateTime } from '../../ui';
import { describeAction, humanise } from './labels';

const MAX_TEXT = 1000;
const MAX_KEYS = 50;
const MAX_DEPTH = 3;

export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** Who did it, as one line. The stored label stays readable after the person is deleted. */
export function actorName(r: AuditRecord): string {
  if (r.actorLabel) return r.actorLabel;
  if (r.actorType === 'apikey') return 'An API key';
  if (r.actorType === 'system') return 'Toolshed';
  return r.actorId ?? 'Unknown';
}

export function actorKind(r: AuditRecord): string | null {
  if (r.actorType === 'apikey') return 'API key';
  if (r.actorType === 'system') return 'Automatic';
  return null;
}

/** Stored detail, shown the way a person would write it: no braces, no quotes, no raw JSON. */
function Value({ value, depth }: { value: unknown; depth: number }): Child {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value === '' ? 'Empty' : clip(value, MAX_TEXT);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
      return value.map((v) => (v === null ? 'None' : String(v))).join(', ');
    }
    if (depth >= MAX_DEPTH) return clip(JSON.stringify(value), MAX_TEXT);
    return <MetaList entries={value.map((v, i) => [`Item ${i + 1}`, v])} depth={depth + 1} />;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'None';
    if (depth >= MAX_DEPTH) return clip(JSON.stringify(value), MAX_TEXT);
    return <MetaList entries={entries} depth={depth + 1} />;
  }
  return clip(String(value), MAX_TEXT);
}

function MetaList({ entries, depth }: { entries: [string, unknown][]; depth: number }) {
  const shown = entries.slice(0, MAX_KEYS);
  return (
    <KeyValueList
      items={[
        ...shown.map(([key, value]) => ({ label: humanise(key), value: <Value value={value} depth={depth} /> })),
        ...(entries.length > shown.length ? [{ label: 'More', value: `${entries.length - shown.length} more not shown` }] : []),
      ]}
    />
  );
}

export function EntryDetails({ record, showWorkspace }: { record: AuditRecord; showWorkspace: boolean }) {
  const { text, known } = describeAction(record.action, record.targetId);
  const kind = actorKind(record);
  const meta = record.meta ? Object.entries(record.meta) : [];
  const rows: { label: string; value: Child }[] = [
    { label: 'When', value: <time datetime={new Date(record.at).toISOString()}>{formatDateTime(record.at)}</time> },
    { label: 'Who', value: kind ? `${actorName(record)} (${kind.toLowerCase()})` : actorName(record) },
    { label: 'What', value: known ? text : record.action },
    { label: 'Action code', value: <code class="mono">{record.action}</code> },
  ];
  if (record.summary) rows.push({ label: 'Note', value: record.summary });
  if (record.targetType) rows.push({ label: 'Target type', value: record.targetType });
  if (record.targetId) rows.push({ label: 'Target', value: <code class="mono">{record.targetId}</code> });
  if (record.ip) rows.push({ label: 'IP address', value: <code class="mono">{record.ip}</code> });
  if (showWorkspace) rows.push({ label: 'Workspace', value: record.orgId ? <code class="mono">{record.orgId}</code> : 'Whole install' });
  rows.push({ label: 'Entry', value: <code class="mono">{record.id}</code> });

  return (
    <div class="stack">
      <KeyValueList items={rows} />
      {meta.length > 0 ? (
        <div>
          <p class="section-label">More detail</p>
          <MetaList entries={meta} depth={1} />
        </div>
      ) : null}
    </div>
  );
}
