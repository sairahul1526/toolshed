/**
 * Taking a response, from the moment a browser or script posts it to the moment it is stored.
 *
 * Order matters: cheap checks first (status, password, token, honeypot, rate limits), then the
 * answers are validated against the published version, then the cap is claimed with one atomic
 * update, then the row is written. Stats, events and emails run afterwards through `after`, so a
 * slow email never makes a respondent wait, and a failed email never loses a response.
 */
import { verifyPassword } from '../../auth/hasher';
import { newId, orgDb, parseJson } from '../../core/db';
import { AppError } from '../../core/errors';
import { emit } from '../../core/events';
import { enqueue } from '../../core/jobs';
import { rateLimit } from '../../core/ratelimit';
import type { Env } from '../../env';
import { formErrors } from './errors';
import { computeScore, displayValue, pipe, pickEnding, type Answers } from './logic';
import { clientIp, readSignedToken, sha256, signedToken, visitorId } from './platform';
import { allFields, DISPLAY_TYPES, type Ending, type Field } from './schema';
import { availability, type Form, type PublicForm } from './service';
import { bump, responseEntries, type Entry } from './stats';
import { claimUploads, lookupUploads } from './uploads';
import { checkAnswers, searchText, type RawInput } from './validate';

export interface SubmitInput {
  raw: RawInput;
  token?: string | null;
  access?: string | null;
  honeypot?: string | null;
  clientId?: string | null;
  /** The page already sent its own start and page beacons, so the server need not guess. */
  beacon?: boolean;
  /** Save what is typed so far instead of finishing. Only when the form allows it. */
  partial?: boolean;
  req: Request;
  now?: number;
}

export interface EndingView {
  id: string;
  title: string;
  body: string;
  buttonLabel?: string;
  buttonUrl?: string;
}

export interface SubmitResult {
  status: 'complete' | 'partial' | 'spam';
  submissionId: string;
  ending?: EndingView;
  redirect?: string;
  /** A short-lived token the thank-you page uses to show this response's own answers. */
  receipt?: string;
  /** True when this exact response had already been stored (a retry or a double click). */
  duplicate?: boolean;
  /** Work to finish after the respondent has their answer: stats, events, emails. */
  after: () => Promise<void>;
}

export const SPAM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_FILL_MS = 1500;
const PER_FIELD_MS = 400;
const MAX_FILL_MS = 8000;

export async function issueLoadToken(env: Env, form: Form, now = Date.now()): Promise<string> {
  return signedToken(env, 'forms.load', { f: form.id, t: now }, 86_400, now);
}

export async function issueAccessToken(env: Env, form: Form, now = Date.now()): Promise<string> {
  return signedToken(env, 'forms.access', { f: form.id }, 86_400, now);
}

export async function hasAccess(env: Env, form: Form, token: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (form.settings.access !== 'password') return true;
  if (!token) return false;
  const data = await readSignedToken(env, 'forms.access', token, now);
  return data?.f === form.id;
}

/** Check a password and hand back the access token. Rate limited per visitor. */
export async function unlock(env: Env, pf: PublicForm, password: string, req: Request, now = Date.now()): Promise<string> {
  const { form } = pf;
  const who = await visitorId(env, form.id, req, now);
  await limit(env, `forms.pw:${form.id}:${who}`, 8, 600, now);
  const hash = form.settings.passwordHash;
  if (!hash || !(await verifyPassword(password, hash))) throw formErrors.bad_password();
  return issueAccessToken(env, form, now);
}

async function limit(env: Env, key: string, max: number, windowSec: number, now: number): Promise<void> {
  const res = await rateLimit(env, key, { limit: max, windowSec }, now);
  if (!res.ok) {
    throw new AppError('rate_limited', 429, formErrors.too_many().message, undefined, { 'Retry-After': String(res.retryAfter) });
  }
}

function summarise(req: Request): Record<string, string> {
  const ua = req.headers.get('user-agent') ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/.test(ua) ? 'Phone' : 'Desktop';
  let referrer = '';
  try {
    referrer = new URL(req.headers.get('referer') ?? '').hostname;
  } catch {
    // no referrer
  }
  const out: Record<string, string> = { browser, device };
  if (referrer) out.referrer = referrer;
  const country = req.headers.get('cf-ipcountry');
  if (country && country !== 'XX' && country !== 'T1') out.country = country;
  const lang = (req.headers.get('accept-language') ?? '').split(',')[0]?.trim().slice(0, 12);
  if (lang) out.lang = lang;
  return out;
}

function linkCount(answers: Answers, fields: Field[]): number {
  let n = 0;
  for (const f of fields) {
    if (f.type !== 'short_text' && f.type !== 'long_text') continue;
    const v = answers[f.id];
    if (typeof v === 'string') n += (v.match(/https?:\/\/|www\./gi) ?? []).length;
  }
  return n;
}

function respondentEmail(fields: Field[], answers: Answers, preferred?: string | null): string | null {
  const email = fields.filter((f) => f.type === 'email');
  const pick = email.find((f) => f.id === preferred) ?? email.find((f) => typeof answers[f.id] === 'string');
  const v = pick ? answers[pick.id] : undefined;
  return typeof v === 'string' && v ? v : null;
}

function endingView(e: Ending, def: PublicForm['definition'], values: Answers & Record<string, unknown>): EndingView {
  const v = values as Parameters<typeof pipe>[2];
  return {
    id: e.id,
    title: pipe(e.title, def, v),
    body: pipe(e.body, def, v),
    ...(e.buttonLabel && e.buttonUrl ? { buttonLabel: e.buttonLabel, buttonUrl: e.buttonUrl } : {}),
  };
}

/** The address to send the browser to when the form is done, or undefined. Only web addresses and paths are followed. */
export function redirectFor(e: Ending, def: PublicForm['definition'], values: Record<string, unknown>): string | undefined {
  if (!e.redirectUrl) return undefined;
  const filled = e.redirectUrl.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g, (_m, name: string) => {
    if (!e.passAnswers) return '';
    const f = allFields(def).find((x) => x.key === name || x.id === name);
    return f ? encodeURIComponent(displayValue(f, values[f.id] as never)) : '';
  });
  try {
    const u = new URL(filled, 'https://placeholder.invalid');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return filled;
  } catch {
    return undefined;
  }
}

interface ExistingRow {
  id: string;
  status: string;
  ending_id: string | null;
  answers: string;
  calcs: string;
}

export async function submitResponse(env: Env, pf: PublicForm, input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? Date.now();
  const { form, definition: def } = pf;
  const db = orgDb(env.DB, form.orgId);
  const fields = allFields(def);

  const avail = availability(form, now);
  if (!avail.open) throw avail.reason === 'full' ? formErrors.full() : formErrors.closed(form.settings.closedMessage || undefined);
  if (!(await hasAccess(env, form, input.access, now))) throw formErrors.password_needed();
  if (input.partial && !form.settings.privacy.partial) throw formErrors.closed('This form does not save answers before they are sent.');

  const visitor = await visitorId(env, form.id, input.req, now);
  const token = input.token ? await readSignedToken(env, 'forms.load', input.token, now) : null;
  const tokenOk = token?.f === form.id && typeof token.t === 'number';
  if (input.token && !tokenOk) throw formErrors.link_expired();
  if (!input.token && !form.settings.allowDirectPosts) throw formErrors.needs_token();

  // Rate limits. A direct post without the page's token gets a much smaller allowance.
  const scope = clientIp(input.req) || visitor;
  if (!input.partial) {
    await limit(env, `forms.submit:${form.id}:${tokenOk ? visitor : `d:${visitor}`}`, tokenOk ? 10 : 3, 600, now);
    await limit(env, `forms.submit:${form.id}`, 120, 60, now);
  } else {
    await limit(env, `forms.partial:${form.id}:${scope}`, 60, 600, now);
  }

  // Files named in the answers must be uploads this form received and nobody has claimed yet.
  const fileIds = fields.filter((f) => f.type === 'file_upload').flatMap((f) => (Array.isArray(input.raw[f.id]) ? (input.raw[f.id] as unknown[]) : [input.raw[f.id]])).filter((x): x is string => typeof x === 'string');
  const files = await lookupUploads(db, form.id, fileIds);
  const checked = checkAnswers(def, input.raw, files, { partial: input.partial });
  if (!input.partial && Object.keys(checked.errors).length > 0) throw formErrors.answers_invalid(undefined, checked.errors);
  const answers = checked.answers;
  if (input.partial) for (const id of Object.keys(checked.errors)) delete answers[id];

  const startedAt = tokenOk ? (token!.t as number) : null;
  const duration = startedAt ? Math.max(0, now - startedAt) : null;
  const questionCount = fields.filter((f) => !DISPLAY_TYPES.includes(f.type)).length;
  const minMs = Math.min(MAX_FILL_MS, MIN_FILL_MS + PER_FIELD_MS * questionCount);
  let spamReason: string | null = null;
  if (input.honeypot) spamReason = 'honeypot';
  else if (duration !== null && duration < minMs && !input.partial) spamReason = 'too_fast';
  else if (linkCount(answers, fields) > 2) spamReason = 'links';

  // Retry or double click: the same browser session id lands on the same row.
  if (input.clientId) {
    const existing = await db.first<ExistingRow>('SELECT id, status, ending_id, answers, calcs FROM forms_submissions WHERE org_id = :org AND form_id = ? AND client_id = ?', form.id, input.clientId);
    if (existing && existing.status !== 'partial') return replay(def, existing, env, form);
    if (existing && input.partial) return savePartial(env, pf, db, existing.id, answers, input, visitor, now);
  }
  if (input.partial) return savePartial(env, pf, db, null, answers, input, visitor, now);

  const hash = await sha256(`${visitor}|${JSON.stringify(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)))}`);
  if (!spamReason) {
    const dupe = await db.first<ExistingRow>("SELECT id, status, ending_id, answers, calcs FROM forms_submissions WHERE org_id = :org AND form_id = ? AND content_hash = ? AND created_at > ? AND status != 'partial' LIMIT 1", form.id, hash, now - 3_600_000);
    if (dupe) return replay(def, dupe, env, form);
  }

  const meta = form.settings.privacy.collectMeta ? summarise(input.req) : {};
  const email = respondentEmail(fields, answers, form.settings.autoresponder.fieldId);
  const values = { ...answers, ...checked.calcs };
  const ending = pickEnding(def, values, checked.path.forcedEnding);
  const id = newId('sub', now);
  const baseRow = {
    id, form_id: form.id, version_id: form.publishedVersionId!, answers: JSON.stringify(answers), calcs: JSON.stringify(checked.calcs),
    ending_id: ending.id, respondent_email: email, search_text: searchText(def, answers),
    meta: JSON.stringify(spamReason ? { ...meta, reason: spamReason } : meta), visitor_id: form.settings.privacy.collectMeta ? visitor : null,
    client_id: input.clientId ?? null, content_hash: hash, started_at: startedAt, duration_ms: duration, created_at: now, updated_at: now,
  };

  if (spamReason) {
    await db.insert('forms_submissions', { ...baseRow, status: 'spam', score: null });
    return {
      status: 'spam', submissionId: id, ...(await finish(env, def, form, id, ending, values)),
      after: async () => {
        await bump(env, form.orgId, form.id, now, [['spam', '', 1]]);
        await emit(env, { orgId: form.orgId, module: 'forms', name: 'submission.spam', subject: form.id, data: { formId: form.id, slug: form.slug, submissionId: id, reason: spamReason }, at: now });
      },
    };
  }

  // Claim a place under the cap with one atomic update, so two people cannot both take the last one.
  const claimed = await env.DB.prepare(
    `UPDATE forms_forms SET response_count = response_count + 1, last_response_at = ?3
     WHERE id = ?1 AND org_id = ?2 AND status = 'live' AND (json_extract(settings, '$.cap') IS NULL OR response_count < json_extract(settings, '$.cap'))
     RETURNING response_count`,
  )
    .bind(form.id, form.orgId, now)
    .first<{ response_count: number }>();
  if (!claimed) throw formErrors.full();

  const score = computeScore(def, answers);
  try {
    await db.insert('forms_submissions', { ...baseRow, status: 'complete', score, completed_at: now });
  } catch (err) {
    await env.DB.prepare('UPDATE forms_forms SET response_count = MAX(0, response_count - 1) WHERE id = ?1').bind(form.id).run();
    if (input.clientId && String(err).includes('UNIQUE')) {
      const again = await db.first<ExistingRow>('SELECT id, status, ending_id, answers, calcs FROM forms_submissions WHERE org_id = :org AND form_id = ? AND client_id = ?', form.id, input.clientId);
      if (again) return replay(def, again, env, form);
    }
    throw err;
  }
  await claimUploads(db, form.id, id, [...files.keys()].filter((fid) => Object.values(answers).some((v) => Array.isArray(v) && v.some((x) => typeof x === 'object' && (x as { id: string }).id === fid))));

  const reach: Entry[] = input.beacon ? [] : [['start', '', 1], ...fields.filter((f) => checked.path.visible.has(f.id) && !DISPLAY_TYPES.includes(f.type)).map((f): Entry => ['reach', f.id, 1])];
  return {
    status: 'complete', submissionId: id, ...(await finish(env, def, form, id, ending, values)),
    after: async () => {
      await bump(env, form.orgId, form.id, now, [...responseEntries(def, answers, duration, 1), ...reach]);
      await emit(env, { orgId: form.orgId, module: 'forms', name: 'form.submitted', subject: form.id, data: submittedData(pf, id, answers, checked.calcs, score, meta), at: now });
      if (form.settings.cap && claimed.response_count >= form.settings.cap) {
        await emit(env, { orgId: form.orgId, module: 'forms', name: 'form.closed', subject: form.id, data: { formId: form.id, slug: form.slug, name: form.name, reason: 'cap' }, at: now });
      }
      await enqueue(env, 'forms.notify', { orgId: form.orgId, formId: form.id, submissionId: id });
    },
  };
}

async function finish(env: Env, def: PublicForm['definition'], form: Form, id: string, ending: Ending, values: Record<string, unknown>): Promise<{ ending: EndingView; redirect?: string; receipt: string }> {
  const redirect = redirectFor(ending, def, values);
  return {
    ending: endingView(ending, def, values as Answers),
    ...(redirect ? { redirect } : {}),
    receipt: await signedToken(env, 'forms.receipt', { s: id, f: form.id }, 3600),
  };
}

async function replay(def: PublicForm['definition'], row: ExistingRow, env: Env, form: Form): Promise<SubmitResult> {
  const answers = parseJson<Answers>(row.answers, {});
  const calcs = parseJson<Record<string, number>>(row.calcs, {});
  const values = { ...answers, ...calcs };
  const ending = def.endings.find((e) => e.id === row.ending_id) ?? pickEnding(def, values);
  return { status: row.status === 'spam' ? 'spam' : 'complete', submissionId: row.id, duplicate: true, ...(await finish(env, def, form, row.id, ending, values)), after: async () => {} };
}

async function savePartial(env: Env, pf: PublicForm, db: ReturnType<typeof orgDb>, existingId: string | null, answers: Answers, input: SubmitInput, visitor: string, now: number): Promise<SubmitResult> {
  const { form, definition: def } = pf;
  const email = respondentEmail(allFields(def), answers, form.settings.autoresponder.fieldId);
  const patch = { answers: JSON.stringify(answers), respondent_email: email, search_text: searchText(def, answers), updated_at: now };
  let id = existingId;
  if (id) await db.update('forms_submissions', id, patch);
  else {
    id = newId('sub', now);
    await db.insert('forms_submissions', {
      ...patch, id, form_id: form.id, version_id: form.publishedVersionId!, status: 'partial', calcs: '{}', meta: JSON.stringify(form.settings.privacy.collectMeta ? summarise(input.req) : {}),
      visitor_id: form.settings.privacy.collectMeta ? visitor : null, client_id: input.clientId ?? null, started_at: now, created_at: now,
    });
  }
  const created = !existingId;
  const savedId = id;
  return {
    status: 'partial', submissionId: savedId,
    after: async () => {
      if (!created) return;
      await bump(env, form.orgId, form.id, now, [['partial', '', 1]]);
      await emit(env, { orgId: form.orgId, module: 'forms', name: 'form.partial', subject: form.id, data: { formId: form.id, slug: form.slug, submissionId: savedId }, at: now });
    },
  };
}

function submittedData(pf: PublicForm, submissionId: string, answers: Answers, calcs: Record<string, number>, score: number | null, meta: Record<string, string>) {
  return {
    formId: pf.form.id,
    slug: pf.form.slug,
    name: pf.form.name,
    submissionId,
    answers: allFields(pf.definition)
      .filter((f) => answers[f.id] !== undefined)
      .map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, value: displayValue(f, answers[f.id]).slice(0, 500) })),
    score,
    calcs,
    metadata: meta,
  };
}

/** A completed response's own thank-you page: the ending and the receipt that proves it was theirs. */
export async function readReceipt(env: Env, token: string | null | undefined): Promise<{ submissionId: string; formId: string } | null> {
  if (!token) return null;
  const data = await readSignedToken(env, 'forms.receipt', token);
  return data && typeof data.s === 'string' && typeof data.f === 'string' ? { submissionId: data.s, formId: data.f } : null;
}
