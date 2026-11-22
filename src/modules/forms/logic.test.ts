import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as ts from './logic';
import { definitionSchema, type Definition } from './schema';
import { TEMPLATES } from './templates';

/** The browser copy of the rules, loaded the way a page would load it (no document, so it only exports). */
function browser(): typeof ts {
  const ctx: Record<string, unknown> = { Math, Number, String, Array, Object, isFinite, JSON };
  ctx.globalThis = ctx;
  runInNewContext(readFileSync('public/m/forms/form.js', 'utf8'), ctx);
  return ctx.__toolshedFormLogic as typeof ts;
}

const js = browser();

function def(): Definition {
  return definitionSchema.parse({
    pages: [
      { id: 'p1', fields: [
        { id: 'q_plan', type: 'single_choice', label: 'Plan', key: 'plan', options: [{ id: 'a', label: 'Free', points: 1 }, { id: 'b', label: 'Pro', points: 5 }] },
        { id: 'q_n', type: 'number', label: 'Seats', key: 'seats' },
        { id: 'q_tags', type: 'multiple_choice', label: 'Tags', key: 'tags', options: [{ id: 'x', label: 'X', points: 2 }, { id: 'y', label: 'Y', points: 3 }] },
      ], jump: [{ when: { mode: 'all', rules: [{ field: 'q_plan', op: 'is', value: 'a' }] }, to: 'p3' }] },
      { id: 'p2', showIf: { mode: 'all', rules: [{ field: 'q_n', op: 'gt', value: 3 }] }, fields: [{ id: 'q_why', type: 'long_text', label: 'Why {{seats}}', key: 'why', showIf: { mode: 'any', rules: [{ field: 'q_plan', op: 'is', value: 'b' }] } }] },
      { id: 'p3', fields: [{ id: 'q_end', type: 'short_text', label: 'End', key: 'end' }], jump: [{ when: { mode: 'all', rules: [{ field: 'big', op: 'gte', value: 20 }] }, to: 'end:e2' }] },
    ],
    calcs: [{ id: 'big', name: 'Big', formula: 'round({q_n} * 2.5) + sum({q_plan}, 1) + if({q_n} > 2, 10, 0)' }, { id: 'broken', name: 'Broken', formula: '1 +' }],
    endings: [{ id: 'e1', title: 'Hi {{plan}}', body: 'Score {{big}}' }, { id: 'e2', title: 'Big', body: '', when: { mode: 'all', rules: [{ field: 'big', op: 'gte', value: 20 }] } }],
  });
}

const cases: ts.Answers[] = [{}, { q_plan: 'a', q_n: '2' }, { q_plan: 'b', q_n: '5', q_why: 'because', q_tags: ['x', 'y'] }, { q_plan: 'b', q_n: '1', q_end: 'x' }, { q_n: 'abc' }, { q_plan: 'b', q_n: '9' }];

describe('browser logic matches the server logic', () => {
  const d = def();
  for (const [i, a] of cases.entries()) {
    it(`case ${i}`, () => {
      expect(js.computeCalcs(d, a)).toEqual(ts.computeCalcs(d, a));
      expect(js.computeScore(d, a)).toEqual(ts.computeScore(d, a));
      const r = ts.resolve(d, a);
      const b = js.resolve(d, a);
      expect({ pages: b.path.pages, visible: [...(b.path.visible as unknown as string[])].sort(), forced: b.path.forcedEnding }).toEqual({ pages: r.path.pages, visible: [...r.path.visible].sort(), forced: r.path.forcedEnding });
      expect(b.answers).toEqual(r.answers);
      const values = { ...r.answers, ...r.calcs };
      expect(js.pickEnding(d, values, r.path.forcedEnding).id).toBe(ts.pickEnding(d, values, r.path.forcedEnding).id);
      for (const e of d.endings) expect(js.pipe(e.title, d, values)).toBe(ts.pipe(e.title, d, values));
    });
  }

  it('conditions agree for every operator and value shape', () => {
    const ops = ['is', 'is_not', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty', 'any_of'] as const;
    const vals: ts.Values[] = [{}, { f: '' }, { f: 'Yes' }, { f: '5' }, { f: 5 }, { f: ['a', 'b'] }, { f: [] }, { f: 'abc' }];
    const wants = ['yes', 5, '5', 'a', ['a', 'z'], 'ab'];
    for (const op of ops) for (const v of vals) for (const value of wants) {
      const c = { field: 'f', op, value } as never;
      expect(js.evalCondition(c, v), `${op} ${JSON.stringify(v)} ${JSON.stringify(value)}`).toBe(ts.evalCondition(c, v));
    }
  });

  it('formulas agree, including the ones that fail', () => {
    const ref = (id: string) => ({ a: 3, b: 0, c: -2 })[id as 'a'] ?? 0;
    for (const f of ['{a}+{b}', '{a}/{b}', 'max({a},{c},4)', 'min()', 'abs({c})*2', 'if({a}>2,1,0)', '(1+2', '1 +', 'foo(1)', '2 * (3 + 4) - 1', '{a} == 3', '', '10 / 4', '1.5 + 1.25', '-{a}']) {
      expect(js.evalFormula(f, ref), f).toBe(ts.evalFormula(f, ref));
    }
  });

  it('every template agrees on a blank response', () => {
    for (const t of TEMPLATES) {
      const d2 = t.build();
      expect(js.resolve(d2, {}).path.pages).toEqual(ts.resolve(d2, {}).path.pages);
    }
  });
});
