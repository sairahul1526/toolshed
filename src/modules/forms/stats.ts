/**
 * Per-form numbers, kept as daily counters so the Summary tab reads a few rows instead of
 * scanning every response. Days are UTC. Deleting a response or marking it as spam takes its
 * answers back out; views, starts and "reached" counts are not reversed because they are about
 * visits, not about the response.
 */
import type { OrgDb } from '../../core/db';
import type { Env } from '../../env';
import { CHOICE_TYPES, DISPLAY_TYPES, SCALE_TYPES, allFields, type Definition, type Field } from './schema';
import type { Answers } from './logic';

export type Entry = [metric: string, key: string, n: number];

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add to the day's counters in one batch. Negative numbers take counts back out and stop at zero. */
export async function bump(env: Env, orgId: string, formId: string, at: number, entries: Entry[]): Promise<void> {
  if (entries.length === 0) return;
  const day = dayOf(at);
  const merged = new Map<string, Entry>();
  for (const [m, k, n] of entries) {
    const id = `${m}\u0000${k}`;
    const prev = merged.get(id);
    merged.set(id, [m, k, (prev?.[2] ?? 0) + n]);
  }
  const stmt = env.DB.prepare(
    `INSERT INTO forms_stats (org_id, form_id, day, metric, key, n) VALUES (?1, ?2, ?3, ?4, ?5, MAX(0, ?6))
     ON CONFLICT (form_id, day, metric, key) DO UPDATE SET n = MAX(0, n + ?6)`,
  );
  const batch = [...merged.values()].filter((e) => e[2] !== 0).map(([m, k, n]) => stmt.bind(orgId, formId, day, m, k, n));
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
}

const BUCKETS = [5, 10, 20, 30, 45, 60, 90, 120, 180, 300, 600, 1800, 3600];

export function durBucket(ms: number): string {
  const s = Math.max(0, ms / 1000);
  return String(BUCKETS.find((b) => s < b) ?? 3600);
}

/** What one complete response adds to the counters (use `sign` -1 to take it back). */
export function responseEntries(def: Definition, answers: Answers, durationMs: number | null, sign: 1 | -1): Entry[] {
  const out: Entry[] = [['complete', '', sign]];
  for (const f of allFields(def)) {
    if (DISPLAY_TYPES.includes(f.type)) continue;
    const v = answers[f.id];
    if (v === undefined) continue;
    out.push(['answered', f.id, sign]);
    if (CHOICE_TYPES.includes(f.type) || SCALE_TYPES.includes(f.type) || f.type === 'yes_no') {
      for (const x of Array.isArray(v) ? v : [v]) out.push(['ans', `${f.id}|${x}`, sign]);
    }
  }
  if (durationMs !== null && durationMs >= 0) out.push(['dur', durBucket(durationMs), sign]);
  return out;
}

export interface Tally {
  value: string;
  label: string;
  n: number;
}

export interface QuestionStat {
  id: string;
  label: string;
  type: Field['type'];
  reached: number;
  answered: number;
  /** Reached this question but did not reach the next one (or finish). Never below zero. */
  leftHere: number;
  tallies?: Tally[];
  average?: number;
  /** NPS: promoters minus detractors, as a percentage. */
  nps?: number;
  /** CSAT: share of responses that picked the top two ratings. */
  csat?: number;
}

export interface Summary {
  from: string;
  to: string;
  views: number;
  starts: number;
  completes: number;
  partials: number;
  spam: number;
  /** Completed / started, as a percentage, or null before anyone has started. */
  rate: number | null;
  medianSeconds: number | null;
  daily: { day: string; views: number; completes: number }[];
  questions: QuestionStat[];
}

function median(hist: Map<number, number>): number | null {
  const total = [...hist.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const b of [...hist.keys()].sort((a, c) => a - c)) {
    seen += hist.get(b)!;
    if (seen >= total / 2) return b;
  }
  return null;
}

export function rangeDays(days: number, now = Date.now()): { from: string; to: string } {
  return { from: dayOf(now - (Math.max(1, days) - 1) * 86_400_000), to: dayOf(now) };
}

export async function summary(db: OrgDb, formId: string, def: Definition, range: { from: string; to: string }): Promise<Summary> {
  const totals = await db.all<{ metric: string; key: string; n: number }>(
    'SELECT metric, key, SUM(n) AS n FROM forms_stats WHERE org_id = :org AND form_id = ? AND day >= ? AND day <= ? GROUP BY metric, key',
    formId, range.from, range.to,
  );
  const daily = await db.all<{ day: string; metric: string; n: number }>(
    "SELECT day, metric, SUM(n) AS n FROM forms_stats WHERE org_id = :org AND form_id = ? AND day >= ? AND day <= ? AND metric IN ('view','complete') GROUP BY day, metric ORDER BY day",
    formId, range.from, range.to,
  );
  const get = (metric: string, key = '') => totals.find((t) => t.metric === metric && t.key === key)?.n ?? 0;
  const hist = new Map<number, number>();
  for (const t of totals) if (t.metric === 'dur') hist.set(Number(t.key), t.n);

  const days = new Map<string, { day: string; views: number; completes: number }>();
  for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += 86_400_000) {
    days.set(dayOf(t), { day: dayOf(t), views: 0, completes: 0 });
  }
  for (const d of daily) {
    const row = days.get(d.day);
    if (row) d.metric === 'view' ? (row.views = d.n) : (row.completes = d.n);
  }

  const completes = get('complete');
  const starts = Math.max(get('start'), completes);
  const qs = allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type));
  const questions: QuestionStat[] = qs.map((f, i) => {
    const reached = Math.max(get('reach', f.id), get('answered', f.id));
    const next = i + 1 < qs.length ? Math.max(get('reach', qs[i + 1]!.id), get('answered', qs[i + 1]!.id)) : completes;
    const q: QuestionStat = { id: f.id, label: f.label || '(no label)', type: f.type, reached, answered: get('answered', f.id), leftHere: Math.max(0, reached - Math.max(next, 0)) };
    if (CHOICE_TYPES.includes(f.type) || f.type === 'yes_no') {
      q.tallies = (f.type === 'yes_no' ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] : (f.options ?? [])).map((o) => ({ value: o.id, label: o.label, n: get('ans', `${f.id}|${o.id}`) }));
    } else if (SCALE_TYPES.includes(f.type)) {
      const lo = f.min ?? 1;
      const hi = f.max ?? 5;
      const tallies: Tally[] = [];
      let sum = 0;
      let count = 0;
      for (let v = lo; v <= hi; v++) {
        const n = get('ans', `${f.id}|${v}`);
        tallies.push({ value: String(v), label: String(v), n });
        sum += v * n;
        count += n;
      }
      q.tallies = tallies;
      if (count > 0) {
        q.average = Math.round((sum / count) * 100) / 100;
        if (f.type === 'nps') {
          const pct = (pred: (v: number) => boolean) => (tallies.filter((t) => pred(Number(t.value))).reduce((a, t) => a + t.n, 0) / count) * 100;
          q.nps = Math.round(pct((v) => v >= 9) - pct((v) => v <= 6));
        }
        if (f.type === 'csat') q.csat = Math.round((tallies.filter((t) => Number(t.value) >= hi - 1).reduce((a, t) => a + t.n, 0) / count) * 100);
      }
    }
    return q;
  });

  return {
    ...range,
    views: get('view'),
    starts,
    completes,
    partials: get('partial'),
    spam: get('spam'),
    rate: starts > 0 ? Math.round((completes / starts) * 1000) / 10 : null,
    medianSeconds: median(hist),
    daily: [...days.values()],
    questions,
  };
}

/** Delete counters older than 400 days, so the table stays small for forms that run for years. */
export async function purgeStats(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM forms_stats WHERE day < ?1').bind(dayOf(now - 400 * 86_400_000)).run();
}
