/**
 * Email work that follows a response, run from the queue so a slow or failing mail provider never
 * delays the respondent and a retry never sends twice. The team note goes to each address on the
 * form's list; the thank-you goes only to an address the respondent typed into an email question.
 */
import { orgDb, parseJson } from '../../core/db';
import { emailReady, sendEmail } from '../../core/email';
import { resolveBrand } from '../../core/email-templates/brand';
import { once } from '../../core/jobs';
import { rateLimit } from '../../core/ratelimit';
import type { Env } from '../../env';
import { autoresponder, teamNotification } from './emails';
import { displayValue, pipe, type Answers } from './logic';
import { allFields, DISPLAY_TYPES } from './schema';
import { getFormRow, toForm } from './service';
import { definitionFor, type SubmissionRow } from './submissions';

export interface NotifyPayload {
  orgId: string;
  formId: string;
  submissionId: string;
}

/** At most this many thank-you emails to one address per form per hour, so a form cannot be used to mail-bomb someone. */
export const AUTO_PER_ADDRESS = 1;

export async function notifyJob(env: Env, raw: unknown, now = Date.now()): Promise<void> {
  const p = raw as NotifyPayload;
  if (!p?.orgId || !p.formId || !p.submissionId) return;
  const db = orgDb(env.DB, p.orgId);
  const row = await db.first<SubmissionRow>('SELECT * FROM forms_submissions WHERE org_id = :org AND id = ? AND status = ?', p.submissionId, 'complete');
  if (!row) return;
  const form = toForm(await getFormRow(db, p.formId));
  const def = await definitionFor(db, row.version_id);
  const answers = parseJson<Answers>(row.answers, {});
  const calcs = parseJson<Record<string, number>>(row.calcs, {});
  const brand = await resolveBrand(env, p.orgId);
  const base = (env.APP_URL ?? '').replace(/\/$/, '');
  const fields = allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type));

  const team = form.settings.notify;
  if (team.enabled && team.emails.length > 0 && (await emailReady(env))) {
    await once(env, `forms.notify:${p.submissionId}`, 86_400, async () => {
      const mail = teamNotification({
        brand,
        formName: form.name,
        lines: fields.filter((f) => answers[f.id] !== undefined).map((f) => ({ label: f.label || f.key, value: displayValue(f, answers[f.id]) })),
        score: row.score,
        link: `${base}/app/forms/${form.id}/responses/${row.id}`,
      });
      for (const to of team.emails.slice(0, 10)) {
        await sendEmail(env, { to, subject: mail.subject, html: mail.html, text: mail.text, template: 'forms.notify', tag: 'forms.notify', orgId: p.orgId });
      }
    });
  }

  const auto = form.settings.autoresponder;
  if (auto.enabled && row.respondent_email && (await emailReady(env))) {
    const ok = await rateLimit(env, `forms.auto:${form.id}:${row.respondent_email}`, { limit: AUTO_PER_ADDRESS, windowSec: 3600 }, now);
    if (!ok.ok) return;
    await once(env, `forms.auto:${p.submissionId}`, 86_400, async () => {
      const values = { ...answers, ...calcs };
      const mail = autoresponder({
        brand,
        formName: form.name,
        subject: pipe(auto.subject || `Thanks for filling in ${form.name}`, def, values),
        body: pipe(auto.body || 'We got your response. Thank you.', def, values),
      });
      await sendEmail(env, { to: row.respondent_email!, subject: mail.subject, html: mail.html, text: mail.text, template: 'forms.autoresponder', tag: 'forms.autoresponder', orgId: p.orgId });
    });
  }
}
