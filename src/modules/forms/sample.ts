/**
 * Believable sample data, so a new workspace can see a summary and a responses list before any real
 * person has filled anything in. Every row is marked `sample`, the forms are never emailed or sent
 * to webhooks, and clearing removes the forms with everything under them.
 */
import { newId } from '../../core/db';
import { computeScore, type Answers } from './logic';
import { allFields, DISPLAY_TYPES, definitionSchema, type Definition, type Field } from './schema';
import { createForm, deleteForm, getDraft, listForms, publish, type Ctx } from './service';
import { bump, dayOf, responseEntries, type Entry } from './stats';
import { checkAnswers, searchText } from './validate';

const NAMES = ['Maya Chen', 'Tomas Alvarez', 'Priya Nair', 'Jonas Weber', 'Amara Okafor', 'Liam Murphy', 'Sofia Rossi', 'Kenji Tanaka', 'Hana Novak', 'Omar Haddad', 'Ines Duarte', 'Noah Kim'];
const MESSAGES = [
  'Hi, do you offer a team plan? We are six people.',
  'Our invoice shows the wrong company name. Can you fix it?',
  'Is there a way to export everything to a spreadsheet?',
  'Love the product. Any plans for a dark theme?',
  'We would like to move our data over from another tool. Can you help?',
  'Quick question about how long you keep responses.',
];
const REASONS = ['Setup took five minutes.', 'It does what the old tool did, without the bill.', 'Support answered the same day.', 'A few screens are slow on my phone.', 'I could not find where to change my password.', 'Great, but I miss integrations.'];
const NPS = [10, 9, 9, 10, 8, 7, 9, 10, 6, 8, 9, 3, 10, 9, 7, 8, 10, 9, 5, 9];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
}

function pick<T>(list: T[], i: number): T {
  return list[i % list.length]!;
}

/** A plausible answer to one question for respondent number `i`. */
function answerFor(f: Field, i: number): string | number | string[] | undefined {
  const name = pick(NAMES, i);
  switch (f.type) {
    case 'short_text':
      return /name/i.test(f.label) ? name : /use/i.test(f.label) ? pick(['A side project', 'Our support inbox', 'Event sign-ups'], i) : 'Sample answer';
    case 'long_text':
      return /reason|why/i.test(f.label) ? pick(REASONS, i) : pick(MESSAGES, i);
    case 'email':
      return i % 5 === 4 ? undefined : `${slug(name)}@example.com`;
    case 'phone':
      return `+1 555 010 ${String(1000 + i).slice(-4)}`;
    case 'url':
      return 'https://example.com';
    case 'number':
      return (i % 9) + 1;
    case 'date':
      return '2026-03-14';
    case 'nps':
      return pick(NPS, i);
    case 'csat':
      return pick([5, 4, 5, 3, 4, 5, 2, 5], i);
    case 'ces':
      return pick([6, 7, 5, 7, 4, 6, 7, 3], i);
    case 'rating':
    case 'scale':
      return pick([4, 5, 3, 5, 4], i);
    case 'yes_no':
      return i % 4 === 0 ? 'no' : 'yes';
    case 'consent':
      return 'yes';
    case 'single_choice':
    case 'dropdown':
      return f.options?.length ? pick(f.options, i).id : undefined;
    case 'multiple_choice':
      return f.options?.length && i % 3 !== 0 ? [pick(f.options, i).id] : undefined;
    default:
      return undefined;
  }
}

function makeAnswers(def: Definition, i: number): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const f of allFields(def)) {
    if (DISPLAY_TYPES.includes(f.type) || f.type === 'file_upload' || f.type === 'hidden') continue;
    const v = answerFor(f, i);
    if (v !== undefined) raw[f.id] = v;
  }
  return raw;
}

const DAY = 86_400_000;

async function fill(ctx: Ctx, formId: string, def: Definition, count: number, now: number): Promise<void> {
  const versionRow = await ctx.db.first<{ published_version_id: string }>('SELECT published_version_id FROM forms_forms WHERE org_id = :org AND id = ?', formId);
  const versionId = versionRow!.published_version_id;
  const statements: D1PreparedStatement[] = [];
  const perDay = new Map<string, { at: number; entries: Entry[] }>();
  let last = 0;
  for (let i = 0; i < count; i++) {
    // Oldest first, spread over two weeks, with a few quiet days.
    const age = Math.floor(((count - 1 - i) / count) * 14 * DAY) + (i % 7) * 60_000;
    const at = now - age;
    last = Math.max(last, at);
    const checked = checkAnswers(def, makeAnswers(def, i), new Map(), {});
    if (Object.keys(checked.errors).length) continue;
    const answers: Answers = checked.answers;
    const duration = (35 + ((i * 17) % 90)) * 1000;
    const email = allFields(def).filter((f) => f.type === 'email').map((f) => answers[f.id]).find((a) => typeof a === 'string');
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO forms_submissions (id, org_id, form_id, version_id, status, answers, calcs, score, respondent_email, search_text, meta, started_at, completed_at, duration_ms, sample, read_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'complete', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?12, ?12)`,
      ).bind(newId('sub', at), ctx.db.orgId, formId, versionId, JSON.stringify(answers), JSON.stringify(checked.calcs), computeScore(def, answers), typeof email === 'string' ? email : null, searchText(def, answers), JSON.stringify({ browser: pick(['Chrome', 'Safari', 'Firefox'], i), device: pick(['Desktop', 'Phone'], i) }), at - duration, at, duration, i < count - 3 ? at : null),
    );
    const day = dayOf(at);
    const bucket = perDay.get(day) ?? { at, entries: [] };
    bucket.entries.push(...responseEntries(def, answers, duration, 1), ['start', '', 1], ['view', '', 3]);
    for (const f of allFields(def)) if (!DISPLAY_TYPES.includes(f.type) && answers[f.id] !== undefined) bucket.entries.push(['reach', f.id, 1]);
    perDay.set(day, bucket);
  }
  for (let i = 0; i < statements.length; i += 50) await ctx.env.DB.batch(statements.slice(i, i + 50));
  for (const { at, entries } of perDay.values()) await bump(ctx.env, ctx.db.orgId, formId, at, entries);
  await ctx.db.run('UPDATE forms_forms SET response_count = ?, last_response_at = ? WHERE org_id = :org AND id = ?', statements.length, last, formId);
}

export async function addSampleForms(ctx: Ctx, now = Date.now()): Promise<void> {
  const existing = (await listForms(ctx.db, { limit: 200 })).filter((f) => f.sample);
  if (existing.length > 0) return;
  const quiet = { notify: { enabled: false, emails: [] }, autoresponder: { enabled: false, subject: 'We got your response', body: 'Thanks.' } };
  for (const [templateId, name, count] of [['contact', 'Sample: Contact us', 12], ['feedback-nps', 'Sample: Customer feedback', 20]] as const) {
    const form = await createForm(ctx, { templateId, name, sample: true, settings: quiet }, {}, now);
    await publish(ctx, form.id, {}, now);
    const def = definitionSchema.parse(await getDraft(ctx.db, form));
    await fill(ctx, form.id, def, count, now);
  }
}

export async function clearSampleForms(ctx: Ctx): Promise<void> {
  for (const f of (await listForms(ctx.db, { limit: 200, trashed: undefined })).filter((x) => x.sample)) await deleteForm(ctx, f.id);
  // Trashed sample forms are hidden from the list but still count as sample data.
  const trashed = await ctx.db.all<{ id: string }>('SELECT id FROM forms_forms WHERE org_id = :org AND sample = 1');
  for (const t of trashed) await deleteForm(ctx, t.id);
}
