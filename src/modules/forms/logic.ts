/**
 * The rules engine: which blocks show, where pages jump, calculations, scores, endings and piping.
 *
 * This is the authority. The browser runs a hand-written copy in `public/m/forms/form.js` so the
 * page reacts as people type, and `logic.test.ts` loads that copy and checks it gives the same
 * answers as this file. Change one, change the other.
 */
import { CHOICE_TYPES, DISPLAY_TYPES, allFields, type Calc, type Condition, type Definition, type Ending, type Field, type Group } from './schema';

export interface FileRef {
  id: string;
  name: string;
  size: number;
  type: string;
}

export type Answer = string | number | string[] | FileRef[];
export type Answers = Record<string, Answer>;
/** Answers plus calculation results, which rules and formulas can read by id. */
export type Values = Record<string, Answer | number>;

const isNum = (v: unknown): boolean => v !== '' && v !== null && typeof v !== 'boolean' && Number.isFinite(Number(v));

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function norm(v: unknown): string {
  return String(v).trim().toLowerCase();
}

function items(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? String((x as FileRef).name) : String(x))) : [String(v)];
}

export function evalCondition(c: Condition, values: Values): boolean {
  const v = values[c.field];
  const want = c.value;
  switch (c.op) {
    case 'empty':
      return isEmpty(v);
    case 'not_empty':
      return !isEmpty(v);
    case 'is':
      if (isEmpty(v)) return false;
      if (Array.isArray(v)) return items(v).some((x) => norm(x) === norm(want));
      return isNum(v) && isNum(want) ? Number(v) === Number(want) : norm(v) === norm(want);
    case 'is_not':
      return !evalCondition({ ...c, op: 'is' }, values);
    case 'contains':
      return !isEmpty(v) && items(v).some((x) => norm(x).includes(norm(want)));
    case 'not_contains':
      return !evalCondition({ ...c, op: 'contains' }, values);
    case 'any_of': {
      const list = (Array.isArray(want) ? want : [want]).map(norm);
      return !isEmpty(v) && items(v).some((x) => list.includes(norm(x)));
    }
    case 'gt':
      return isNum(v) && isNum(want) && Number(v) > Number(want);
    case 'gte':
      return isNum(v) && isNum(want) && Number(v) >= Number(want);
    case 'lt':
      return isNum(v) && isNum(want) && Number(v) < Number(want);
    case 'lte':
      return isNum(v) && isNum(want) && Number(v) <= Number(want);
  }
}

/** No group, or a group with no rules, always passes. */
export function evalGroup(g: Group | null | undefined, values: Values): boolean {
  if (!g || g.rules.length === 0) return true;
  return g.mode === 'any' ? g.rules.some((r) => evalCondition(r, values)) : g.rules.every((r) => evalCondition(r, values));
}

// ---------------------------------------------------------------------------------------------
// Formulas: numbers, {field} references, + - * /, comparisons, parentheses, sum min max round abs if.
// ---------------------------------------------------------------------------------------------

type Tok = { t: 'num'; v: number } | { t: 'ref'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(src: string): Tok[] | null {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|\{([A-Za-z][A-Za-z0-9_-]*)\}|([a-z]+)|(>=|<=|==|!=|[-+*/(),<>]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return null;
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'ref', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
    else out.push({ t: 'op', v: m[4]! });
  }
  return out;
}

const FUNCS = new Set(['sum', 'min', 'max', 'round', 'abs', 'if']);

/** The number a reference stands for: option points for choices, the number itself otherwise. */
export function numericValue(field: Field | undefined, v: Answer | number | undefined): number {
  if (v === undefined || isEmpty(v)) return 0;
  if (field && CHOICE_TYPES.includes(field.type) && field.options) {
    const picked = Array.isArray(v) ? v.map(String) : [String(v)];
    return picked.reduce((sum, id) => sum + (field.options!.find((o) => o.id === id)?.points ?? 0), 0);
  }
  if (Array.isArray(v)) return v.length;
  if (v === 'yes') return 1;
  if (v === 'no') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Evaluates one formula. A formula that does not parse, or divides by zero, gives 0 rather than an error. */
export function evalFormula(formula: string, ref: (id: string) => number): number {
  const toks = lex(formula);
  if (!toks || toks.length === 0) return 0;
  let i = 0;
  let bad = false;
  const peek = () => toks[i];
  const eat = (v: string) => {
    const t = toks[i];
    if (t && t.t === 'op' && t.v === v) {
      i++;
      return true;
    }
    return false;
  };
  const compare = (): number => {
    let a = sumExpr();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !['>', '<', '>=', '<=', '==', '!='].includes(t.v)) return a;
      i++;
      const b = sumExpr();
      a = (t.v === '>' ? a > b : t.v === '<' ? a < b : t.v === '>=' ? a >= b : t.v === '<=' ? a <= b : t.v === '==' ? a === b : a !== b) ? 1 : 0;
    }
  };
  const sumExpr = (): number => {
    let a = term();
    for (;;) {
      if (eat('+')) a += term();
      else if (eat('-')) a -= term();
      else return a;
    }
  };
  const term = (): number => {
    let a = unary();
    for (;;) {
      if (eat('*')) a *= unary();
      else if (eat('/')) {
        const b = unary();
        a = b === 0 ? 0 : a / b;
      } else return a;
    }
  };
  const unary = (): number => (eat('-') ? -unary() : primary());
  const primary = (): number => {
    const t = toks[i++];
    if (!t) {
      bad = true;
      return 0;
    }
    if (t.t === 'num') return t.v;
    if (t.t === 'ref') return ref(t.v);
    if (t.t === 'op' && t.v === '(') {
      const v = compare();
      if (!eat(')')) bad = true;
      return v;
    }
    if (t.t === 'id' && FUNCS.has(t.v) && eat('(')) {
      const args: number[] = [];
      if (!eat(')')) {
        do args.push(compare());
        while (eat(','));
        if (!eat(')')) bad = true;
      }
      switch (t.v) {
        case 'sum':
          return args.reduce((a, b) => a + b, 0);
        case 'min':
          return args.length ? Math.min(...args) : 0;
        case 'max':
          return args.length ? Math.max(...args) : 0;
        case 'round':
          return Math.round(args[0] ?? 0);
        case 'abs':
          return Math.abs(args[0] ?? 0);
        default:
          return (args[0] ?? 0) !== 0 ? (args[1] ?? 0) : (args[2] ?? 0);
      }
    }
    bad = true;
    return 0;
  };
  const result = compare();
  if (bad || i < toks.length || !Number.isFinite(result)) return 0;
  return Math.round(result * 1e6) / 1e6;
}

/** Results of every calculation, in order, so a later one can use an earlier one. */
export function computeCalcs(def: Definition, answers: Answers): Record<string, number> {
  const fields = new Map(allFields(def).map((f) => [f.id, f]));
  const out: Record<string, number> = {};
  for (const c of def.calcs) {
    out[c.id] = evalFormula(c.formula, (id) => (id in out ? out[id]! : numericValue(fields.get(id), answers[id])));
  }
  return out;
}

/** The sum of option points across the answers given, or null when no choice carries points. */
export function computeScore(def: Definition, answers: Answers): number | null {
  let any = false;
  let total = 0;
  for (const f of allFields(def)) {
    if (!f.options?.some((o) => o.points !== undefined)) continue;
    any = true;
    total += numericValue(f, answers[f.id]);
  }
  return any ? total : null;
}

// ---------------------------------------------------------------------------------------------
// Paths through the pages
// ---------------------------------------------------------------------------------------------

export interface Path {
  /** Pages the respondent sees, in order. */
  pages: string[];
  /** Blocks that are shown. Only these are validated and stored. */
  visible: Set<string>;
  /** Set when a jump rule sent the respondent straight to an ending. */
  forcedEnding?: string;
}

/** Follow show rules and jump rules over the answers so far. Jumps only go forward, so a form cannot loop. */
export function walk(def: Definition, values: Values): Path {
  const pages: string[] = [];
  const visible = new Set<string>();
  let forcedEnding: string | undefined;
  let i = 0;
  while (i < def.pages.length) {
    const page = def.pages[i]!;
    if (!evalGroup(page.showIf, values)) {
      i++;
      continue;
    }
    pages.push(page.id);
    for (const f of page.fields) if (evalGroup(f.showIf, values)) visible.add(f.id);
    const jump = (page.jump ?? []).find((j) => evalGroup(j.when, values));
    if (!jump) {
      i++;
      continue;
    }
    if (jump.to.startsWith('end:')) {
      forcedEnding = jump.to.slice(4);
      break;
    }
    const target = def.pages.findIndex((p) => p.id === jump.to);
    i = target > i ? target : i + 1;
  }
  return { pages, visible, ...(forcedEnding ? { forcedEnding } : {}) };
}

/**
 * Answers and calculations settle each other (a rule can read a calculation, a calculation reads
 * answers), so run twice: once on everything, then only on what is visible.
 */
export function resolve(def: Definition, answers: Answers): { path: Path; answers: Answers; calcs: Record<string, number> } {
  const first = walk(def, { ...answers, ...computeCalcs(def, answers) });
  const kept: Answers = {};
  for (const [id, v] of Object.entries(answers)) if (first.visible.has(id)) kept[id] = v;
  const calcs = computeCalcs(def, kept);
  const path = walk(def, { ...kept, ...calcs });
  return { path, answers: kept, calcs };
}

export function pickEnding(def: Definition, values: Values, forced?: string): Ending {
  if (forced) {
    const hit = def.endings.find((e) => e.id === forced);
    if (hit) return hit;
  }
  const matched = def.endings.find((e) => e.when && e.when.rules.length > 0 && evalGroup(e.when, values));
  return matched ?? def.endings.find((e) => !e.when || e.when.rules.length === 0) ?? def.endings[def.endings.length - 1]!;
}

// ---------------------------------------------------------------------------------------------
// Piping and display
// ---------------------------------------------------------------------------------------------

/** What a respondent or a team member reads for an answer: option labels, not ids. */
export function displayValue(field: Field | undefined, v: Answer | number | undefined): string {
  if (v === undefined || isEmpty(v)) return '';
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object') return (v as FileRef[]).map((f) => f.name).join(', ');
    return (v as string[]).map((id) => field?.options?.find((o) => o.id === id)?.label ?? id).join(', ');
  }
  if (field && CHOICE_TYPES.includes(field.type)) return field.options?.find((o) => o.id === v)?.label ?? String(v);
  if (field?.type === 'yes_no' || field?.type === 'consent') return v === 'yes' ? 'Yes' : 'No';
  return String(v);
}

/** Fill `{{key}}` or `{{id}}` in a piece of copy. Unknown or empty names become an empty string. */
export function pipe(textIn: string, def: Definition, values: Values): string {
  if (!textIn.includes('{{')) return textIn;
  const fields = allFields(def);
  return textIn.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g, (_m, name: string) => {
    const f = fields.find((x) => x.key === name || x.id === name);
    if (f) return displayValue(f, values[f.id]);
    const c: Calc | undefined = def.calcs.find((x) => x.id === name);
    return c && values[c.id] !== undefined ? String(values[c.id]) : '';
  });
}

/** True for block types that never hold an answer. */
export function isDisplay(f: Field): boolean {
  return DISPLAY_TYPES.includes(f.type);
}
