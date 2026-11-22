/**
 * Segments: saved filters over subscribers. A filter is `{ match: 'all' | 'any', rules: [...] }`.
 * It compiles to a SQL condition on the alias `s` (mail_subscribers) with bound values, so a
 * stranger's text never lands in the query itself.
 */
import { z } from 'zod';
import { errors, parse } from '../../core/errors';

const FIELD_KEY = /^[a-z][a-z0-9_]{0,40}$/;

const ruleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), op: z.enum(['has', 'not']), value: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('email'), op: z.enum(['contains', 'ends_with']), value: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal('name'), op: z.enum(['set', 'empty']) }),
  z.object({ type: z.literal('source'), op: z.enum(['is', 'not']), value: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('joined'), op: z.enum(['after', 'before']), value: z.coerce.number().int().min(0) }),
  z.object({ type: z.literal('joined_days'), op: z.literal('within'), value: z.coerce.number().int().min(1).max(3650) }),
  z.object({ type: z.literal('opens'), op: z.literal('at_least'), value: z.coerce.number().int().min(1).max(100000) }),
  z.object({ type: z.literal('clicks'), op: z.literal('at_least'), value: z.coerce.number().int().min(1).max(100000) }),
  z.object({
    type: z.literal('field'),
    key: z.string().regex(FIELD_KEY),
    op: z.enum(['is', 'not', 'contains', 'set', 'empty']),
    value: z.string().trim().max(200).optional(),
  }),
]);

export const filterSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(ruleSchema).max(10).default([]),
});

export type Rule = z.infer<typeof ruleSchema>;
export type Filter = z.infer<typeof filterSchema>;

export const EMPTY_FILTER: Filter = { match: 'all', rules: [] };

export function parseFilter(raw: unknown): Filter {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  return parse(filterSchema, value ?? {});
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw errors.validation_failed('That filter isn’t valid. Rebuild it from the segment screen.');
  }
}

const like = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

function ruleSql(rule: Rule, now: number): { sql: string; params: (string | number)[] } {
  switch (rule.type) {
    case 'tag': {
      const exists = 'EXISTS (SELECT 1 FROM mail_subscriber_tags t WHERE t.org_id = s.org_id AND t.subscriber_id = s.id AND t.tag = ?)';
      return { sql: rule.op === 'has' ? exists : `NOT ${exists}`, params: [rule.value.toLowerCase()] };
    }
    case 'email':
      return rule.op === 'contains'
        ? { sql: "s.email LIKE ? ESCAPE '\\'", params: [like(rule.value.toLowerCase())] }
        : { sql: "s.email LIKE ? ESCAPE '\\'", params: [like(rule.value.toLowerCase()).slice(0, -1)] };
    case 'name':
      return { sql: rule.op === 'set' ? "s.name <> ''" : "s.name = ''", params: [] };
    case 'source':
      return { sql: rule.op === 'is' ? 's.source = ?' : 's.source <> ?', params: [rule.value] };
    case 'joined':
      return { sql: rule.op === 'after' ? 's.created_at >= ?' : 's.created_at < ?', params: [rule.value] };
    case 'joined_days':
      return { sql: 's.created_at >= ?', params: [now - rule.value * 86_400_000] };
    case 'opens':
      return { sql: 's.opens >= ?', params: [rule.value] };
    case 'clicks':
      return { sql: 's.clicks >= ?', params: [rule.value] };
    case 'field': {
      // The key passed FIELD_KEY, so it is safe inside the JSON path.
      const path = `json_extract(s.fields, '$."${rule.key}"')`;
      const v = rule.value ?? '';
      if (rule.op === 'set') return { sql: `(${path} IS NOT NULL AND ${path} <> '')`, params: [] };
      if (rule.op === 'empty') return { sql: `(${path} IS NULL OR ${path} = '')`, params: [] };
      if (rule.op === 'is') return { sql: `lower(${path}) = ?`, params: [v.toLowerCase()] };
      if (rule.op === 'not') return { sql: `(${path} IS NULL OR lower(${path}) <> ?)`, params: [v.toLowerCase()] };
      return { sql: `lower(${path}) LIKE ? ESCAPE '\\'`, params: [like(v.toLowerCase())] };
    }
  }
}

/** A SQL condition on `s` (mail_subscribers) and its values. An empty filter matches everyone. */
export function compileFilter(filter: Filter, now = Date.now()): { sql: string; params: (string | number)[] } {
  if (filter.rules.length === 0) return { sql: '1 = 1', params: [] };
  const parts = filter.rules.map((r) => ruleSql(r, now));
  return { sql: `(${parts.map((p) => p.sql).join(filter.match === 'any' ? ' OR ' : ' AND ')})`, params: parts.flatMap((p) => p.params) };
}

/** One plain sentence per rule, for the segment screen and the pre-send checklist. */
export function describeFilter(filter: Filter): string {
  if (filter.rules.length === 0) return 'Everyone on the newsletter';
  const words = filter.rules.map((r) => {
    switch (r.type) {
      case 'tag': return r.op === 'has' ? `has the tag ${r.value}` : `does not have the tag ${r.value}`;
      case 'email': return r.op === 'contains' ? `email contains ${r.value}` : `email ends with ${r.value}`;
      case 'name': return r.op === 'set' ? 'has a name' : 'has no name';
      case 'source': return r.op === 'is' ? `came from ${r.value}` : `did not come from ${r.value}`;
      case 'joined': return r.op === 'after' ? `joined on or after ${new Date(r.value).toISOString().slice(0, 10)}` : `joined before ${new Date(r.value).toISOString().slice(0, 10)}`;
      case 'joined_days': return `joined in the last ${r.value} days`;
      case 'opens': return `opened at least ${r.value} emails`;
      case 'clicks': return `clicked at least ${r.value} links`;
      case 'field': {
        const label = r.key.replace(/_/g, ' ');
        if (r.op === 'set') return `${label} is filled in`;
        if (r.op === 'empty') return `${label} is empty`;
        return `${label} ${r.op === 'is' ? 'is' : r.op === 'not' ? 'is not' : 'contains'} ${r.value ?? ''}`;
      }
    }
  });
  return words.join(filter.match === 'any' ? ', or ' : ', and ');
}
