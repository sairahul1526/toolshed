/** Form settings: name and address, access, dates, notifications, privacy and look. */
import { Hono } from 'hono';
import { orgDb } from '../../core/db';
import { AppError } from '../../core/errors';
import { emailReady } from '../../core/email';
import type { AppEnv } from '../../env';
import { Button, Callout, Card, Checkbox, Field, Input, PageHeader, Select, Textarea, renderPage, setFlash } from '../../ui';
import { BASE, CSS, FormTabs, act, body, crumbs, str, type C } from './dash-common';
import { ctxOf } from './http';
import { allFields, type FormSettings } from './schema';
import { getDraft, getForm, renameForm, updateSettings, type Form } from './service';
import { saveBrandImage } from './uploads';

export const settingsRoutes = new Hono<AppEnv>();

const stamp = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 16) : '');
const parseStamp = (v: string): number | null => (v ? (Number.isFinite(Date.parse(`${v}Z`)) ? Date.parse(`${v}Z`) : null) : null);
const HEX = /^#[0-9a-fA-F]{6}$/;

interface Errors { [key: string]: string }

async function page(c: C, form: Form, errors: Errors = {}, status: 200 | 422 = 200, v?: Record<string, string>) {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const def = await getDraft(db, form);
  const s = form.settings;
  const emailFields = allFields(def).filter((f) => f.type === 'email');
  const val = (k: string, d: string) => (v && k in v ? v[k]! : d);
  const mailOk = await emailReady(c.env);
  const id = form.id;
  const e = (k: string) => errors[k];
  return renderPage(
    c,
    { title: `Settings for ${form.name}`, crumbs: crumbs(form, 'Settings'), status },
    <>
      {CSS}
      <PageHeader title={form.name} description="How the form behaves, who can open it and what it looks like." />
      <FormTabs form={form} active="settings" />
      {Object.keys(errors).length ? <Callout tone="bad" title="Some settings need fixing">Check the fields marked below. Nothing was saved.</Callout> : null}
      <form method="post" action={`${BASE}/${id}/settings`} class="fm-stack">
        <Card title="Name and address">
          <div class="fm-stack">
            <Field id="s-name" label="Name" error={e('name')}><Input id="s-name" name="name" value={val('name', form.name)} maxlength={120} required invalid={!!e('name')} /></Field>
            <Field id="s-slug" label="Address" hint="Letters, numbers and hyphens. Addresses are unique across this install." error={e('slug')}><Input id="s-slug" name="slug" prefix="/f/" value={val('slug', form.slug)} maxlength={60} required invalid={!!e('slug')} /></Field>
          </div>
        </Card>
        <Card title="Who can respond">
          <div class="fm-stack">
            <Field id="s-access" label="Access">
              <Select id="s-access" name="access" value={val('access', s.access)} options={[{ value: 'public', label: 'Anyone with the link' }, { value: 'password', label: 'People with the password' }]} />
            </Field>
            <Field id="s-password" label={s.passwordHash ? 'New password' : 'Password'} optional hint={s.passwordHash ? 'Leave empty to keep the current password. Choose "Anyone with the link" above to remove it.' : 'Needed when access is by password. 4 to 100 characters.'} error={e('password')}>
              <Input id="s-password" name="password" type="password" autocomplete="new-password" maxlength={100} invalid={!!e('password')} />
            </Field>
            <div class="fm-colors">
              <Field id="s-opens" label="Opens (UTC)" optional hint="Empty means open now." error={e('opensAt')}><Input id="s-opens" name="opensAt" type="datetime-local" value={val('opensAt', stamp(s.opensAt))} /></Field>
              <Field id="s-closes" label="Closes (UTC)" optional error={e('closesAt')}><Input id="s-closes" name="closesAt" type="datetime-local" value={val('closesAt', stamp(s.closesAt))} invalid={!!e('closesAt')} /></Field>
              <Field id="s-cap" label="Response limit" optional hint="The form closes at this many." error={e('cap')}><Input id="s-cap" name="cap" type="number" min={1} value={val('cap', s.cap ? String(s.cap) : '')} /></Field>
            </div>
            <Field id="s-closed" label="Message when closed" optional><Textarea id="s-closed" name="closedMessage" rows={2} maxlength={500}>{val('closedMessage', s.closedMessage)}</Textarea></Field>
            <Checkbox id="s-direct" name="allowDirectPosts" value="1" checked={v ? 'allowDirectPosts' in v : s.allowDirectPosts} label="Accept plain HTML posts from other sites" description="Lets an ordinary HTML form on your own site post here. Off by default, because it skips the timing check that stops simple bots." />
          </div>
        </Card>
        <Card title="Email" description="Tell your team about each response, and thank the person who sent it. Each address gets at most a few autoresponders an hour.">
          {!mailOk ? <Callout tone="warn" title="Email is not set up yet" actions={<a class="btn sm" href="/app/email">Set up email</a>}>You can switch these on now. Nothing is sent until the workspace can send email.</Callout> : null}
          <div class="fm-stack">
            <Checkbox id="s-notify" name="notifyEnabled" value="1" checked={v ? 'notifyEnabled' in v : s.notify.enabled} label="Email my team about each response" />
            <Field id="s-emails" label="Team addresses" optional hint="One per line, up to 10." error={e('notify.emails')}><Textarea id="s-emails" name="notifyEmails" rows={3}>{val('notifyEmails', s.notify.emails.join('\n'))}</Textarea></Field>
            <Checkbox id="s-auto" name="autoEnabled" value="1" checked={v ? 'autoEnabled' in v : s.autoresponder.enabled} label="Send the respondent a thank you email" description={emailFields.length ? undefined : 'Add an email question to the form first.'} />
            {emailFields.length ? (
              <Field id="s-autofield" label="Send it to the address in">
                <Select id="s-autofield" name="autoField" value={val('autoField', s.autoresponder.fieldId ?? emailFields[0]!.id)} options={emailFields.map((f) => ({ value: f.id, label: f.label || f.key }))} />
              </Field>
            ) : null}
            <Field id="s-autosub" label="Subject" error={e('autoresponder.subject')}><Input id="s-autosub" name="autoSubject" maxlength={200} value={val('autoSubject', s.autoresponder.subject)} /></Field>
            <Field id="s-autobody" label="Message" hint="Use {{key}} to include an answer." error={e('autoresponder.body')}><Textarea id="s-autobody" name="autoBody" rows={4} maxlength={2000}>{val('autoBody', s.autoresponder.body)}</Textarea></Field>
          </div>
        </Card>
        <Card title="Privacy" description="No IP addresses are stored. These two switches go further.">
          <div class="fm-stack">
            <Checkbox id="s-meta" name="collectMeta" value="1" checked={v ? 'collectMeta' in v : s.privacy.collectMeta} label="Keep browser and device details with each response" description="Turn off to store only the answers and the time." />
            <Checkbox id="s-partial" name="partial" value="1" checked={v ? 'partial' in v : s.privacy.partial} label="Save answers from people who do not finish" description="Off by default. When on, the form tells people their answers are saved as they type, and these show in a Partial folder." />
          </div>
        </Card>
        <Card title="Look" description="Colours apply to this form only. Leave a colour empty to keep the workspace look.">
          <div class="fm-stack">
            <Field id="s-preset" label="Style"><Select id="s-preset" name="preset" value={val('preset', s.theme.preset)} options={[{ value: 'workspace', label: 'Same as the workspace' }, { value: 'paper', label: 'Paper' }, { value: 'warm', label: 'Warm' }, { value: 'cobalt', label: 'Cobalt' }, { value: 'dusk', label: 'Dusk' }]} /></Field>
            <div class="fm-colors">
              <Field id="s-ac" label="Accent" optional hint="For example #1a73e8" error={e('theme.accent')}><Input id="s-ac" name="accent" value={val('accent', s.theme.accent ?? '')} maxlength={7} placeholder="#1a73e8" invalid={!!e('theme.accent')} /></Field>
              <Field id="s-bg" label="Background" optional error={e('theme.background')}><Input id="s-bg" name="background" value={val('background', s.theme.background ?? '')} maxlength={7} placeholder="#ffffff" invalid={!!e('theme.background')} /></Field>
              <Field id="s-tx" label="Text" optional error={e('theme.text')}><Input id="s-tx" name="text" value={val('text', s.theme.text ?? '')} maxlength={7} placeholder="#111111" invalid={!!e('theme.text')} /></Field>
            </div>
          </div>
        </Card>
        <div class="fm-actions"><Button type="submit" variant="primary">Save settings</Button></div>
      </form>
      <Card title="Logo and cover" description="PNG, JPG, WebP or GIF under 3 MB. There is no Toolshed badge on your form.">
        {(['logo', 'cover'] as const).map((kind) => {
          const key = kind === 'logo' ? s.theme.logoKey : s.theme.coverKey;
          return (
            <form method="post" action={`${BASE}/${id}/settings/image/${kind}`} enctype="multipart/form-data" class="fm-themeprev">
              {key ? <img src={`/f/${form.slug}/img/${kind}`} alt={`Current ${kind}`} /> : null}
              <label class="sr-only" for={`img-${kind}`}>{kind === 'logo' ? 'Logo file' : 'Cover file'}</label>
              <input id={`img-${kind}`} class="input" type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required />
              <Button size="sm" type="submit">{key ? 'Replace' : 'Upload'} {kind}</Button>
              {key ? <Button size="sm" variant="ghost" type="submit" name="remove" value="1">Remove</Button> : null}
            </form>
          );
        })}
      </Card>
    </>,
  );
}

settingsRoutes.get('/:id/settings', async (c: C) => page(c, await getForm(orgDb(c.env.DB, c.get('org')!.id), c.req.param('id') ?? '')));

settingsRoutes.post('/:id/settings', async (c: C) => {
  const ctx = ctxOf(c);
  const form = await getForm(ctx.db, c.req.param('id') ?? '');
  const b = await body(c);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string') flat[k] = v;
  const emails = str(b.notifyEmails).split(/[\s,;]+/).filter(Boolean);
  const cap = str(b.cap);
  const hex = (k: string) => { const t = str(b[k]); return t === '' ? null : t; };
  const errors: Errors = {};
  for (const [k, field] of [['accent', 'theme.accent'], ['background', 'theme.background'], ['text', 'theme.text']] as const) {
    const t = hex(k);
    if (t && !HEX.test(t)) errors[field] = 'Use a six digit colour like #1a73e8.';
  }
  const opens = parseStamp(str(b.opensAt));
  const closes = parseStamp(str(b.closesAt));
  const patch: Partial<FormSettings> & { password?: string | null } = {
    access: str(b.access) === 'password' ? 'password' : 'public',
    opensAt: opens,
    closesAt: closes,
    cap: cap ? Number.parseInt(cap, 10) || null : null,
    closedMessage: str(b.closedMessage),
    allowDirectPosts: 'allowDirectPosts' in b,
    notify: { enabled: 'notifyEnabled' in b, emails },
    autoresponder: { enabled: 'autoEnabled' in b, fieldId: str(b.autoField) || form.settings.autoresponder.fieldId || null, subject: str(b.autoSubject), body: str(b.autoBody) },
    privacy: { collectMeta: 'collectMeta' in b, partial: 'partial' in b },
    theme: { ...form.settings.theme, preset: (['workspace', 'paper', 'warm', 'cobalt', 'dusk'].includes(str(b.preset)) ? str(b.preset) : 'workspace') as FormSettings['theme']['preset'], accent: hex('accent'), background: hex('background'), text: hex('text') },
  };
  const pw = str(b.password);
  if (pw) patch.password = pw;
  if (Object.keys(errors).length === 0) {
    try {
      await updateSettings(ctx, form.id, patch as never);
      const name = str(b.name);
      const slug = str(b.slug).toLowerCase();
      if ((name && name !== form.name) || (slug && slug !== form.slug)) await renameForm(ctx, form.id, { name, slug });
      setFlash(c, { kind: 'ok', message: 'Settings saved.' });
      return c.redirect(`${BASE}/${form.id}/settings`, 303);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      Object.assign(errors, e.fields ?? {});
      if (Object.keys(errors).length === 0) errors._ = e.message;
      if (e.code.endsWith('bad_password')) errors.password = e.message;
      if (e.code.endsWith('slug_taken') || e.code.endsWith('invalid_slug')) errors.slug = e.message;
    }
  }
  return page(c, form, errors, 422, flat);
});

settingsRoutes.post('/:id/settings/image/:kind', async (c: C) => {
  const kind = c.req.param('kind');
  const id = c.req.param('id') ?? '';
  if (kind !== 'logo' && kind !== 'cover') return c.redirect(`${BASE}/${id}/settings`, 303);
  const b = await body(c);
  return act(c, `${BASE}/${id}/settings`, async () => {
    const ctx = ctxOf(c);
    const form = await getForm(ctx.db, id);
    const prop = kind === 'logo' ? 'logoKey' : 'coverKey';
    const old = form.settings.theme[prop];
    if (str(b.remove) === '1') {
      await updateSettings(ctx, id, { theme: { ...form.settings.theme, [prop]: null } });
      if (old) await c.env.FILES.delete(old);
      return `The ${kind} was removed.`;
    }
    const file = b.file;
    if (!(file instanceof File) || file.size === 0) throw new AppError('forms.file_missing', 400, 'Choose an image to upload.');
    const key = await saveBrandImage(ctx, id, kind, file);
    await updateSettings(ctx, id, { theme: { ...form.settings.theme, [prop]: key } });
    if (old) await c.env.FILES.delete(old);
    return `The ${kind} was updated.`;
  });
});
