/**
 * The public side of Forms, mounted at /f. No sign-in. Everything here is reachable by anyone, so
 * every handler checks the form's state first and every write goes through `submitResponse`.
 */
import { Hono, type Context } from 'hono';
import { AppError, errors } from '../../core/errors';
import { getSetting } from '../../core/settings';
import { parseAppearance, type Appearance } from '../../ui/appearance';
import { rateLimit } from '../../core/ratelimit';
import type { AppEnv } from '../../env';
import { formErrors } from './errors';
import { allFields } from './schema';
import { isBot, readSignedToken, visitorId } from './platform';
import { availability, findPublic, type PublicForm } from './service';
import { bump } from './stats';
import { hasAccess, issueLoadToken, readReceipt, submitResponse, unlock, type SubmitResult } from './submit';
import { getSubmission } from './submissions';
import { computeCalcs, type Answers } from './logic';
import { EndingPage, FormView, GateView, NoticeView, endingFor } from './render';
import { orgDb } from '../../core/db';
import { readBrandImage, uploadAnswerFile } from './uploads';
import { mapNames, type RawInput } from './validate';

export const publicApp = new Hono<AppEnv>();

/** Names the page and plain HTML forms may send besides answers. They are never stored as answers. */
const CONTROL = new Set(['_gotcha', '_token', '_access', '_cid', '_partial', '_beacon', 'password']);

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };

async function load(c: { env: AppEnv['Bindings'] }, slug: string): Promise<PublicForm> {
  const pf = await findPublic(c.env, slug);
  if (!pf) throw formErrors.not_found('We couldn’t find that form. Check the link.');
  return pf;
}

publicApp.options('/f/:slug/submit', (c) => c.body(null, 204, CORS));

publicApp.post('/f/:slug/submit', async (c) => {
  const pf = await load(c, c.req.param('slug'));
  const type = c.req.header('content-type') ?? '';
  const json = type.includes('application/json');
  let raw: RawInput = {};
  let control: Record<string, string> = {};
  if (json) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw errors.validation_failed('Send the answers as JSON.');
    const answers = body.answers && typeof body.answers === 'object' ? (body.answers as Record<string, unknown>) : body;
    raw = mapNames(pf.definition, Object.entries(answers).filter(([k]) => !CONTROL.has(k)));
    control = Object.fromEntries(Object.entries(body).filter(([k, v]) => CONTROL.has(k) && typeof v === 'string')) as Record<string, string>;
    if (body.partial === true) control._partial = '1';
  } else {
    const form = await c.req.formData().catch(() => null);
    if (!form) throw errors.validation_failed('Send the answers as a form.');
    const pairs: [string, unknown][] = [];
    for (const [k, v] of form.entries()) {
      if (typeof v !== 'string') continue;
      if (CONTROL.has(k)) control[k] = v;
      else pairs.push([k, v]);
    }
    raw = mapNames(pf.definition, pairs);
  }

  let res: SubmitResult;
  try {
    res = await submitResponse(c.env, pf, {
    raw,
    token: control._token ?? null,
    access: control._access ?? null,
    honeypot: control._gotcha ?? null,
    clientId: control._cid ?? null,
    beacon: control._beacon === '1',
    partial: control._partial === '1',
    req: c.req.raw,
    });
  } catch (e) {
    // A plain HTML post has no script to show the message, so the page is drawn again with it.
    if (json || !(e instanceof AppError)) throw e;
    return redraw(c, pf, e, raw, control);
  }
  c.executionCtx.waitUntil(res.after());
  return reply(c, pf, res, json);
});

function reply(c: { req: { raw: Request }; json: (b: unknown, s?: number, h?: Record<string, string>) => Response; redirect: (u: string, s?: 302 | 303) => Response }, pf: PublicForm, res: SubmitResult, json: boolean): Response {
  if (json) {
    return c.json({ ok: true, status: res.status, id: res.submissionId, ending: res.ending ?? null, redirect: res.redirect ?? null, receipt: res.receipt ?? null }, 200, CORS);
  }
  const slug = pf.form.slug;
  if (res.redirect) return c.redirect(res.redirect, 303);
  const back = new URL(`/f/${slug}/thanks`, c.req.raw.url);
  if (res.receipt) back.searchParams.set('r', res.receipt);
  if (res.ending) back.searchParams.set('e', res.ending.id);
  return c.redirect(back.pathname + back.search, 303);
}

publicApp.post('/f/:slug/upload', async (c) => {
  const pf = await load(c, c.req.param('slug'));
  const { form, definition } = pf;
  const avail = availability(form);
  if (!avail.open) throw avail.reason === 'full' ? formErrors.full() : formErrors.closed(form.settings.closedMessage || undefined);
  const data = await c.req.formData().catch(() => null);
  if (!data) throw errors.validation_failed('Send the file as a form.');
  const access = data.get('_access');
  if (!(await hasAccess(c.env, form, typeof access === 'string' ? access : null))) throw formErrors.password_needed();
  const token = data.get('_token');
  const t = typeof token === 'string' ? await readSignedToken(c.env, 'forms.load', token) : null;
  if (!t || t.f !== form.id) throw formErrors.link_expired();
  const file = data.get('file');
  const fieldId = data.get('field');
  const field = allFields(definition).find((f) => f.id === fieldId && f.type === 'file_upload');
  if (!(file instanceof File) || !field) throw errors.validation_failed(undefined, { file: 'Choose a file to upload.' });
  const who = await visitorId(c.env, form.id, c.req.raw);
  const rl = await rateLimit(c.env, `forms.upload:${form.id}:${who}`, { limit: 20, windowSec: 600 }, Date.now());
  if (!rl.ok) throw errors.rate_limited(formErrors.too_many().message);
  const ref = await uploadAnswerFile({ env: c.env, db: orgDb(c.env.DB, form.orgId) }, form.id, field, file);
  return c.json({ ok: true, file: ref });
});

/** Page beacons: a view, a first answer, a page reached. Counted only when the page's own token checks out. */
publicApp.post('/f/:slug/e', async (c) => {
  if (isBot(c.req.raw)) return c.body(null, 204);
  const pf = await findPublic(c.env, c.req.param('slug'));
  if (!pf) return c.body(null, 204);
  const body = (await c.req.json().catch(() => null)) as { t?: string; k?: string; token?: string } | null;
  const t = body?.token ? await readSignedToken(c.env, 'forms.load', body.token) : null;
  if (!body || !t || t.f !== pf.form.id) return c.body(null, 204);
  const known = new Set(pf.definition.pages.map((p) => p.id));
  const at = Date.now();
  if (body.t === 'view') await bump(c.env, pf.form.orgId, pf.form.id, at, [['view', '', 1]]);
  else if (body.t === 'start') await bump(c.env, pf.form.orgId, pf.form.id, at, [['start', '', 1]]);
  else if (body.t === 'page' && body.k && known.has(body.k)) await bump(c.env, pf.form.orgId, pf.form.id, at, [['reach', body.k, 1]]);
  return c.body(null, 204);
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Per-form colours as a stylesheet, because the CSP forbids inline styles. Values are checked hex only. */
publicApp.get('/f/:slug/theme.css', async (c) => {
  const pf = await findPublic(c.env, c.req.param('slug'));
  const th = pf?.form.settings.theme;
  const rules: string[] = [];
  if (th?.accent) rules.push(`--ac:${th.accent};--on:${luminance(th.accent) > 0.4 ? '#111111' : '#ffffff'};`);
  if (th?.background) rules.push(`--bg:${th.background};`);
  if (th?.text) rules.push(`--fg:${th.text};`);
  const css = rules.length ? `:root,html[data-preset]{${rules.join('')}}\n` : '';
  return c.body(css, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

publicApp.get('/f/:slug/img/:kind', async (c) => {
  const pf = await findPublic(c.env, c.req.param('slug'));
  const kind = c.req.param('kind');
  const key = kind === 'logo' ? pf?.form.settings.theme.logoKey : kind === 'cover' ? pf?.form.settings.theme.coverKey : null;
  const res = key ? await readBrandImage(c.env, key) : null;
  return res ?? c.body(null, 404);
});


const PAGE_CSP = (frames: string) => `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors ${frames}`;

type Ctx = Context<AppEnv>;

async function appearanceOf(c: Ctx, orgId: string): Promise<Appearance> {
  return parseAppearance(await getSetting<Record<string, unknown>>(c.env, orgId, 'appearance', {}));
}

function page(c: Ctx, body: unknown, status: 200 | 401 | 403 | 404 | 409 | 410 | 422 | 429, embed: boolean): Response {
  c.header('content-security-policy', PAGE_CSP(embed ? '*' : "'self'"));
  c.header('referrer-policy', 'no-referrer');
  c.header('cache-control', 'no-store');
  return c.html(body as string, status);
}

function paramsOf(c: Ctx): Record<string, string> {
  return Object.fromEntries(Object.entries(c.req.query()).slice(0, 40));
}

async function showForm(c: Ctx, pf: PublicForm, embed: boolean, extra: { access?: string | null; values?: Record<string, string | string[]>; errors?: Record<string, string>; banner?: string; status?: 200 | 422 } = {}): Promise<Response> {
  const { form, definition } = pf;
  const appearance = await appearanceOf(c, form.orgId);
  const avail = availability(form);
  if (!avail.open) {
    const full = avail.reason === 'full';
    const body = full ? 'This form has reached the number of responses it accepts.' : form.settings.closedMessage || 'This form is not taking responses right now.';
    return page(c, <NoticeView form={form} appearance={appearance} title={full ? 'This form is full' : 'This form is closed'} body={body} embed={embed} />, 410, embed);
  }
  if (form.settings.access === 'password' && !(await hasAccess(c.env, form, extra.access))) {
    return page(c, <GateView form={form} appearance={appearance} embed={embed} error={extra.banner} />, 401, embed);
  }
  const token = await issueLoadToken(c.env, form);
  return page(c, <FormView form={form} def={definition} appearance={appearance} token={token} access={extra.access} embed={embed} params={paramsOf(c)} values={extra.values} errors={extra.errors} banner={extra.banner} />, extra.status ?? 200, embed);
}

async function redraw(c: Ctx, pf: PublicForm, e: AppError, raw: RawInput, control: Record<string, string>): Promise<Response> {
  const embed = c.req.header('referer')?.includes('/embed') ?? false;
  if (e.code === 'forms.answers_invalid') {
    return showForm(c, pf, embed, { access: control._access, values: raw as Record<string, string | string[]>, errors: e.fields as Record<string, string>, banner: 'Some answers need another look.', status: 422 });
  }
  if (e.code === 'forms.link_expired' || e.code === 'forms.password_needed') {
    return showForm(c, pf, embed, { access: control._access, values: raw as Record<string, string | string[]>, banner: 'This page was open for a while. Check your answers and send again.', status: 422 });
  }
  const appearance = await appearanceOf(c, pf.form.orgId);
  return page(c, <NoticeView form={pf.form} appearance={appearance} title="We couldn’t send that" body={e.message} embed={embed} />, e.status === 429 ? 429 : 409, embed);
}

publicApp.get('/f/:slug', async (c) => showForm(c, await load(c, c.req.param('slug')), false));
publicApp.get('/f/:slug/embed', async (c) => showForm(c, await load(c, c.req.param('slug')), true));

publicApp.post('/f/:slug/unlock', async (c) => {
  const pf = await load(c, c.req.param('slug'));
  const json = c.req.header('content-type')?.includes('json') ?? false;
  const body = json ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : Object.fromEntries((await c.req.formData().catch(() => new FormData())).entries());
  const embed = body._embed === '1';
  try {
    const access = await unlock(c.env, pf, typeof body.password === 'string' ? body.password : '', c.req.raw);
    if (json) return c.json({ ok: true, access });
    return showForm(c, pf, embed, { access });
  } catch (e) {
    if (json || !(e instanceof AppError)) throw e;
    return showForm(c, pf, embed, { banner: e.message });
  }
});

publicApp.get('/f/:slug/thanks', async (c) => {
  const pf = await load(c, c.req.param('slug'));
  const { form, definition } = pf;
  const appearance = await appearanceOf(c, form.orgId);
  const embed = c.req.query('embed') === '1';
  const ending = definition.endings.find((x) => x.id === c.req.query('e')) ?? definition.endings[0];
  const receipt = await readReceipt(c.env, c.req.query('r'));
  let answers: Answers = {};
  let calcs: Record<string, number> = {};
  if (receipt && receipt.formId === form.id) {
    const got = await getSubmission(orgDb(c.env.DB, form.orgId), form.id, receipt.submissionId).catch(() => null);
    if (got) {
      answers = got.submission.answers;
      calcs = got.submission.calcs ?? computeCalcs(definition, answers);
    }
  }
  const view = ending
    ? endingFor(definition, ending, answers, calcs)
    : { id: 'default', title: 'Thank you', body: 'Your response was sent.' };
  return page(c, <EndingPage form={form} appearance={appearance} ending={view} embed={embed} />, 200, embed);
});

