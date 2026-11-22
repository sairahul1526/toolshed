/** Small helpers every Monitor screen shares: form reading, error handling, status pills, uptime bars. */
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { auditFromRequest } from '../../../core/audit';
import { AppError } from '../../../core/errors';
import { moduleContext } from '../../../core/registry';
import type { AppEnv } from '../../../env';
import { Callout, Field, Icon, Input, Pill, setFlash, Textarea } from '../../../ui';
import { fmtPct } from '../fmt';
import { barLevel } from '../pages';
import type { Bucket } from '../uptime';
import type { MonitorRow } from '../schema';

export type C = Context<AppEnv>;
export type Values = Record<string, string | string[]>;
export type Errors = Record<string, string>;

export const BASE = '/app/monitor';
export const STYLE = '/m/monitor/monitor.css';
export const SCRIPT = '/m/monitor/monitor.js';

export const mctx = (c: C) => moduleContext(c.env, c.get('org')!);
export const record = (c: C, action: string, targetType: string, targetId: string, summary: string) => auditFromRequest(c, { action, targetType, targetId, summary });

/** Read a posted form. Names in `arrays` always come back as lists (checkbox groups); the rest take the last value sent. */
export async function readForm(c: C, arrays: string[] = []): Promise<Values> {
  const raw = await c.req.parseBody({ all: true });
  const out: Values = {};
  for (const [k, v] of Object.entries(raw)) {
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
    out[k] = arrays.includes(k) ? list : (list[list.length - 1] ?? '');
  }
  for (const k of arrays) out[k] ??= [];
  return out;
}

export const text = (v: Values | undefined, key: string, fallback = ''): string => {
  const x = v?.[key];
  return typeof x === 'string' ? x : fallback;
};
export const list = (v: Values | undefined, key: string): string[] => {
  const x = v?.[key];
  return Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : [];
};
export const on = (v: Values | undefined, key: string, fallback = false): boolean => {
  const x = v?.[key];
  return x === undefined ? fallback : x === '1' || x === 'on' || x === 'true';
};

/**
 * Answer a failed POST. A mistake in the form shows the form again with the messages next to the fields.
 * Anything else (a limit, a missing item) goes back with a message at the top.
 */
export function failed(c: C, err: unknown, back: string, show: (errors: Errors) => Promise<Response>): Promise<Response> | Response {
  if (err instanceof AppError && err.fields && Object.keys(err.fields).length > 0) return show(err.fields as Errors);
  if (err instanceof AppError) {
    setFlash(c, { kind: 'error', message: err.message });
    return c.redirect(back);
  }
  throw err;
}

export function done(c: C, message: string, to: string): Response {
  setFlash(c, { kind: 'ok', message });
  return c.redirect(to);
}

/** The box at the top of a form that did not save. */
export function Problems({ errors, shown }: { errors: Errors; shown: string[] }) {
  const keys = Object.keys(errors);
  if (keys.length === 0) return null;
  const loose = keys.filter((k) => !shown.includes(k));
  return (
    <Callout tone="bad" title="That didn’t save">
      {loose.length > 0 ? loose.map((k) => errors[k]).join(' ') : 'Fix the highlighted fields and try again.'}
    </Callout>
  );
}

interface FieldProps {
  id: string;
  label: Child;
  v?: Values;
  errors?: Errors;
  hint?: Child;
  optional?: boolean;
  fallback?: string;
  errorKey?: string;
}

export function TextField({ id, label, v, errors = {}, hint, optional, fallback = '', errorKey, ...rest }: FieldProps & { type?: string; placeholder?: string; maxlength?: number; inputmode?: 'numeric' | 'url' | 'email'; autocomplete?: string; required?: boolean; min?: number; max?: number; list?: string }) {
  const error = errors[errorKey ?? id];
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <Input id={id} name={id} value={text(v, id, fallback)} invalid={!!error} {...rest} />
    </Field>
  );
}

export function AreaField({ id, label, v, errors = {}, hint, optional, fallback = '', rows = 4, mono, placeholder }: FieldProps & { rows?: number; mono?: boolean; placeholder?: string }) {
  const error = errors[id];
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <Textarea id={id} name={id} rows={rows} value={text(v, id, fallback)} invalid={!!error} placeholder={placeholder} class={mono ? 'mono' : undefined} />
    </Field>
  );
}

/** A checkbox that still sends "0" when cleared, so an update can turn a setting off. */
export function Toggle({ name, label, description, checked }: { name: string; label: string; description?: Child; checked: boolean }) {
  return (
    <label class="check">
      <input type="hidden" name={name} value="0" />
      <input type="checkbox" name={name} value="1" checked={checked} />
      <span>
        <b>{label}</b>
        {description ? <span>{description}</span> : null}
      </span>
    </label>
  );
}

/** Link style stylesheet and script for Monitor screens. */
export function Assets() {
  return (
    <>
      <link rel="stylesheet" href={STYLE} />
      <script src={SCRIPT} defer></script>
    </>
  );
}

export function StatusPill({ m }: { m: Pick<MonitorRow, 'paused' | 'status' | 'slow' | 'type'> }) {
  if (m.paused) return <Pill>Paused</Pill>;
  if (m.status === 'down') return <Pill tone="bad">Down</Pill>;
  if (m.status === 'pending') return <Pill>{m.type === 'heartbeat' ? 'Waiting for first ping' : 'Waiting for first check'}</Pill>;
  if (m.slow) return <Pill tone="warn">Slow</Pill>;
  return <Pill tone="good">Up</Pill>;
}

export function pctOf(b: Bucket | null | undefined): number | null {
  return b && b.up + b.down > 0 ? (b.up / (b.up + b.down)) * 100 : null;
}

/** One thin bar per day, oldest first. Colour says how the day went; the title says the number. */
export function UptimeBars({ days, label }: { days: { day: string; b: Bucket | null }[]; label: string }) {
  return (
    <div class="mon-bars" role="img" aria-label={label}>
      {days.map((d) => {
        const p = pctOf(d.b);
        return <i class={`mon-bar ${barLevel(p)}`} title={`${d.day}: ${p === null ? 'no data' : fmtPct(p)}`} />;
      })}
    </div>
  );
}

export const KIND_LABEL: Record<string, string> = { email: 'Email', slack: 'Slack', discord: 'Discord', teams: 'Microsoft Teams', telegram: 'Telegram', webhook: 'Webhook' };

export function Back({ href, children }: { href: string; children: Child }) {
  return (
    <a class="mon-back" href={href}>
      <Icon name="left" />
      {children}
    </a>
  );
}

/** The same 4 option lists the forms use. */
export const INTERVAL_OPTIONS = [
  { value: '1', label: 'Every minute' },
  { value: '5', label: 'Every 5 minutes' },
  { value: '10', label: 'Every 10 minutes' },
  { value: '30', label: 'Every 30 minutes' },
];
