/** The link form: every field of a short link in sections, and the code that turns a posted form into API input. */
import type { FieldErrors } from '../../core/errors';
import { Card, Checkbox, Field, Input, Select, Textarea } from '../../ui';
import { checked, text, type Form } from './dash-shared';
import type { Folder } from './folders';
import type { LinkView } from './types';

export type Values = Record<string, string>;
export const RULE_SLOTS = 4;

const local = (iso: string | null): string => (iso ? iso.slice(0, 16) : '');

export function valuesFromView(l: LinkView): Values {
  const v: Values = {
    url: l.url, code: l.code, title: l.title, notes: l.notes, redirectType: String(l.redirectType), folderId: l.folderId ?? '',
    tags: l.tags.join(', '), startsAt: local(l.startsAt), expiresAt: local(l.expiresAt), clickCap: l.clickCap === null ? '' : String(l.clickCap),
    expiredUrl: l.expiredUrl ?? '', previewTitle: l.preview.title, previewDescription: l.preview.description, previewImage: l.preview.image,
  };
  if (l.forwardQuery) v.forwardQuery = 'on';
  l.rules.slice(0, RULE_SLOTS).forEach((r, i) => {
    v[`rule_kind_${i}`] = r.kind;
    v[`rule_values_${i}`] = r.values.join(', ');
    v[`rule_url_${i}`] = r.url;
  });
  return v;
}

const orNull = (s: string): string | null => (s === '' ? null : s);

/** Turn a posted form into the input the API accepts. On an edit, blank optional fields clear the setting. */
export function toInput(f: Form, editing: boolean): Record<string, unknown> {
  const input: Record<string, unknown> = {
    url: text(f, 'url'),
    title: text(f, 'title'),
    notes: text(f, 'notes'),
    redirectType: Number(text(f, 'redirectType') || 302),
    folderId: orNull(text(f, 'folderId')),
    tags: text(f, 'tags').split(',').map((t) => t.trim()).filter(Boolean),
    startsAt: orNull(text(f, 'startsAt')),
    expiresAt: orNull(text(f, 'expiresAt')),
    clickCap: text(f, 'clickCap') === '' ? null : Number(text(f, 'clickCap')),
    expiredUrl: orNull(text(f, 'expiredUrl')),
    forwardQuery: checked(f, 'forwardQuery'),
    preview: { title: text(f, 'previewTitle'), description: text(f, 'previewDescription'), image: text(f, 'previewImage') },
  };
  const code = text(f, 'code');
  if (code) input.code = code;
  if (checked(f, 'removePassword')) input.password = null;
  else if (text(f, 'password')) input.password = text(f, 'password');
  const utm = { source: text(f, 'utmSource'), medium: text(f, 'utmMedium'), campaign: text(f, 'utmCampaign'), term: text(f, 'utmTerm'), content: text(f, 'utmContent') };
  if (Object.values(utm).some(Boolean)) input.utm = utm;
  const rules = [];
  for (let i = 0; i < RULE_SLOTS; i++) {
    const kind = text(f, `rule_kind_${i}`);
    const url = text(f, `rule_url_${i}`);
    const values = text(f, `rule_values_${i}`).split(',').map((s) => s.trim()).filter(Boolean);
    if (kind && (url || values.length)) rules.push({ kind, values, url });
  }
  if (editing || rules.length) input.rules = rules;
  return input;
}

interface Props {
  v: Values;
  errors?: FieldErrors;
  folders: Folder[];
  /** The address to show the code under, for example https://example.com/. */
  base: string;
  hasPassword?: boolean;
  editing?: boolean;
}

const err = (e: FieldErrors | undefined, k: string): string | undefined => e?.[k];

const REDIRECTS = [
  { value: '302', label: '302 temporary (recommended)' },
  { value: '301', label: '301 permanent' },
  { value: '307', label: '307 temporary, keeps the method' },
];

const RULE_KINDS = [
  { value: '', label: 'Not used' },
  { value: 'country', label: 'Country' },
  { value: 'device', label: 'Device' },
  { value: 'os', label: 'System' },
];

/** The fields, in sections. The caller wraps them in a form and supplies the save button. */
export function LinkFields({ v, errors, folders, base, hasPassword, editing }: Props) {
  const rules = Math.min(RULE_SLOTS, Math.max(2, Object.keys(v).filter((k) => k.startsWith('rule_kind_') && v[k]).length + 1));
  return (
    <div class="lk-sections">
      <Card title="Destination" description="Where the short link sends people.">
        <div class="stack">
          <Field id="f-url" label="Destination address" error={err(errors, 'url')}>
            <Input id="f-url" name="url" type="url" required value={v.url ?? ''} placeholder="https://example.com/a/long/page" invalid={!!err(errors, 'url')} autocomplete="off" />
          </Field>
          <div class="grid-2">
            <Field id="f-code" label="Short code" optional hint={editing ? 'Changing the code breaks links you already shared.' : 'Leave empty for a random one.'} error={err(errors, 'code')}>
              <Input id="f-code" name="code" value={v.code ?? ''} prefix={`${base.replace(/^https?:\/\//, '')}/`} invalid={!!err(errors, 'code')} autocomplete="off" autocapitalize="off" spellcheck={false} />
            </Field>
            <Field id="f-title" label="Title" optional hint="Only you see this." error={err(errors, 'title')}>
              <Input id="f-title" name="title" value={v.title ?? ''} maxlength={200} />
            </Field>
          </div>
          <Field id="f-notes" label="Notes" optional>
            <Textarea id="f-notes" name="notes" rows={2} value={v.notes ?? ''} maxlength={2000} />
          </Field>
        </div>
      </Card>

      <Card title="Campaign tags" description="Add UTM values to the destination so your analytics can tell where visits came from.">
        <div class="grid-3">
          {(['Source', 'Medium', 'Campaign'] as const).map((n) => (
            <Field id={`f-utm${n}`} label={`utm_${n.toLowerCase()}`} optional>
              <Input id={`f-utm${n}`} name={`utm${n}`} value={v[`utm${n}`] ?? ''} placeholder={n === 'Source' ? 'newsletter' : n === 'Medium' ? 'email' : 'spring-launch'} maxlength={100} />
            </Field>
          ))}
        </div>
        <div class="grid-2 lk-gap">
          {(['Term', 'Content'] as const).map((n) => (
            <Field id={`f-utm${n}`} label={`utm_${n.toLowerCase()}`} optional>
              <Input id={`f-utm${n}`} name={`utm${n}`} value={v[`utm${n}`] ?? ''} maxlength={100} />
            </Field>
          ))}
        </div>
      </Card>

      <Card title="Share preview" description="What chat apps and social sites show when the link is pasted. Leave empty to use the destination’s own preview.">
        <div class="stack">
          <Field id="f-pt" label="Preview title" optional>
            <Input id="f-pt" name="previewTitle" value={v.previewTitle ?? ''} maxlength={120} />
          </Field>
          <Field id="f-pd" label="Preview description" optional>
            <Textarea id="f-pd" name="previewDescription" rows={2} value={v.previewDescription ?? ''} maxlength={300} />
          </Field>
          <Field id="f-pi" label="Preview image address" optional hint="A public https address of a picture." error={err(errors, 'preview')}>
            <Input id="f-pi" name="previewImage" type="url" value={v.previewImage ?? ''} invalid={!!err(errors, 'preview')} />
          </Field>
        </div>
      </Card>

      <Card title="Rules" description="Send some visitors somewhere else. The first rule that matches wins; everyone else goes to the destination above.">
        <div class="stack">
          {Array.from({ length: rules }, (_, i) => (
            <div class="lk-rule">
              <Field id={`f-rk${i}`} label={`Rule ${i + 1} based on`}>
                <Select id={`f-rk${i}`} name={`rule_kind_${i}`} value={v[`rule_kind_${i}`] ?? ''} options={RULE_KINDS} />
              </Field>
              <Field id={`f-rv${i}`} label="Matches" hint="Countries like US, IN. Devices: mobile, tablet, desktop. Systems: ios, android, windows, macos, linux.">
                <Input id={`f-rv${i}`} name={`rule_values_${i}`} value={v[`rule_values_${i}`] ?? ''} />
              </Field>
              <Field id={`f-ru${i}`} label="Send them to">
                <Input id={`f-ru${i}`} name={`rule_url_${i}`} type="url" value={v[`rule_url_${i}`] ?? ''} />
              </Field>
            </div>
          ))}
          {err(errors, 'rules') ? <p class="field-error">{err(errors, 'rules')}</p> : null}
        </div>
      </Card>

      <Card title="Schedule and limits" description="Times are in UTC.">
        <div class="stack">
          <div class="grid-2">
            <Field id="f-sa" label="Starts" optional error={err(errors, 'startsAt')}>
              <Input id="f-sa" name="startsAt" type="datetime-local" value={v.startsAt ?? ''} />
            </Field>
            <Field id="f-ea" label="Ends" optional error={err(errors, 'expiresAt')}>
              <Input id="f-ea" name="expiresAt" type="datetime-local" value={v.expiresAt ?? ''} />
            </Field>
          </div>
          <div class="grid-2">
            <Field id="f-cap" label="Click limit" optional hint="After this many human clicks the link stops working.">
              <Input id="f-cap" name="clickCap" type="number" min={1} value={v.clickCap ?? ''} />
            </Field>
            <Field id="f-eu" label="After it ends, send people to" optional error={err(errors, 'expiredUrl')}>
              <Input id="f-eu" name="expiredUrl" type="url" value={v.expiredUrl ?? ''} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Password" description="Visitors have to type it before they are sent on.">
        <div class="stack">
          <Field id="f-pw" label={hasPassword ? 'New password' : 'Password'} optional hint={hasPassword ? 'A password is set. Type a new one to replace it.' : 'At least 4 characters.'} error={err(errors, 'password')}>
            <Input id="f-pw" name="password" type="password" autocomplete="new-password" />
          </Field>
          {hasPassword ? <Checkbox name="removePassword" label="Remove the password" /> : null}
        </div>
      </Card>

      <Card title="Redirect and organising">
        <div class="stack">
          <div class="grid-2">
            <Field id="f-rt" label="Redirect type">
              <Select id="f-rt" name="redirectType" value={v.redirectType ?? '302'} options={REDIRECTS} />
            </Field>
            <Field id="f-fo" label="Folder" optional>
              <Select id="f-fo" name="folderId" value={v.folderId ?? ''} options={[{ value: '', label: 'No folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />
            </Field>
          </div>
          <Field id="f-tg" label="Tags" optional hint="Separate with commas.">
            <Input id="f-tg" name="tags" value={v.tags ?? ''} placeholder="launch, newsletter" />
          </Field>
          <Checkbox name="forwardQuery" label="Pass the visitor’s query string on to the destination" checked={v.forwardQuery === 'on'} />
        </div>
      </Card>
    </div>
  );
}
