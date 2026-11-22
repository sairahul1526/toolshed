/** The public form, drawn on the server. It works as a plain HTML form; `form.js` adds pages, logic and uploads. */
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import { PublicButton, PublicCard, PublicPage } from '../../ui/public';
import type { Appearance } from '../../ui/appearance';
import { pipe, type Answers } from './logic';
import { type Definition, type Ending, type Field } from './schema';
import type { Form } from './service';
import type { EndingView } from './submit';

export interface FormViewProps {
  form: Form;
  def: Definition;
  appearance: Appearance;
  token: string;
  access?: string | null;
  embed?: boolean;
  /** URL parameters, for hidden fields. */
  params?: Record<string, string>;
  /** What the person already typed, when the page is drawn again after a mistake. */
  values?: Record<string, string | string[]>;
  errors?: Record<string, string>;
  banner?: string;
}

const STYLES = ['/m/forms/form.css'];

function themeStyles(form: Form): string[] {
  const t = form.settings.theme;
  return t.accent || t.background || t.text ? [...STYLES, `/f/${form.slug}/theme.css`] : STYLES;
}

function describe(f: Field): string {
  return f.description ?? '';
}

function range(f: Field): number[] {
  const lo = f.type === 'nps' ? 0 : f.type === 'scale' ? (f.min ?? 1) : 1;
  const hi = f.type === 'nps' ? 10 : f.type === 'csat' ? 5 : f.type === 'ces' ? 7 : f.type === 'rating' ? (f.max ?? 5) : (f.max ?? 10);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function val(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function Control({ f, value, invalid, describedBy, hidden }: { f: Field; value: string | string[] | undefined; invalid: boolean; describedBy?: string; hidden?: string }): Child {
  const common = { id: f.id, name: f.id, required: f.required || undefined, 'aria-invalid': invalid ? ('true' as const) : undefined, 'aria-describedby': describedBy };
  const picked = Array.isArray(value) ? value : value ? [value] : [];
  switch (f.type) {
    case 'long_text':
      return <textarea class="pub-input" rows={4} maxlength={10000} placeholder={f.placeholder} {...common}>{val(value)}</textarea>;
    case 'email':
      return <input class="pub-input" type="email" autocomplete="email" inputmode="email" maxlength={254} placeholder={f.placeholder} value={val(value)} {...common} />;
    case 'number':
      return <input class="pub-input" type="text" inputmode="decimal" placeholder={f.placeholder} value={val(value)} {...common} />;
    case 'phone':
      return <input class="pub-input" type="tel" autocomplete="tel" inputmode="tel" maxlength={40} placeholder={f.placeholder} value={val(value)} {...common} />;
    case 'url':
      return <input class="pub-input" type="url" inputmode="url" maxlength={500} placeholder={f.placeholder ?? 'https://'} value={val(value)} {...common} />;
    case 'date':
      return <input class="pub-input" type="date" value={val(value)} {...common} />;
    case 'dropdown':
      return (
        <select class="pub-input" {...common}>
          <option value="">Choose one</option>
          {(f.options ?? []).map((o) => (
            <option value={o.id} selected={picked.includes(o.id)}>{o.label}</option>
          ))}
        </select>
      );
    case 'hidden':
      return <input type="hidden" id={f.id} name={f.id} value={hidden ?? val(value)} data-param={f.param ?? f.key} />;
    case 'file_upload':
      return (
        <div class="fm-file" data-file data-field={f.id} data-max={f.maxFiles ?? 1} data-accept={(f.accept ?? []).join(',')} data-mb={f.maxSizeMb ?? 10}>
          <input class="pub-input" type="file" id={f.id} disabled aria-describedby={describedBy} />
          <p class="pub-hint fm-nojs">Uploading files needs JavaScript. Turn it on to send a file with this form.</p>
          <ul class="fm-files" data-list></ul>
        </div>
      );
    case 'short_text':
      return <input class="pub-input" type="text" maxlength={500} placeholder={f.placeholder} value={val(value)} {...common} />;
    default:
      return null;
  }
}

function Choices({ f, value, invalid, describedBy }: { f: Field; value: string | string[] | undefined; invalid: boolean; describedBy?: string }) {
  const multi = f.type === 'multiple_choice';
  const picked = Array.isArray(value) ? value : value ? [value] : [];
  const opts =
    f.type === 'yes_no' ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] : f.type === 'consent' ? [{ id: 'yes', label: f.label }] : f.options ?? [];
  if (f.type === 'consent') {
    return (
      <label class="fm-choice">
        <input type="checkbox" name={f.id} value="yes" checked={picked.includes('yes')} aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedBy} />
        <span>{f.label}</span>
      </label>
    );
  }
  const scale = ['rating', 'nps', 'csat', 'ces', 'scale'].includes(f.type);
  const items = scale ? range(f).map((n) => ({ id: String(n), label: String(n) })) : opts;
  return (
    <div class={scale ? 'fm-scale' : 'fm-choices'} role={multi ? 'group' : 'radiogroup'} aria-describedby={describedBy}>
      {items.map((o, i) => (
        <label class={scale ? 'fm-pip' : 'fm-choice'}>
          <input type={multi ? 'checkbox' : 'radio'} name={f.id} value={o.id} checked={picked.includes(o.id)} required={!multi && f.required && i === 0 ? true : undefined} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function FieldBlock({ f, props }: { f: Field; props: FormViewProps }) {
  if (f.type === 'section') return <h3 class="fm-section" data-field={f.id}>{f.label}</h3>;
  if (f.type === 'statement') return <div class="fm-statement" data-field={f.id}><p>{f.label}</p>{f.description ? <p class="pub-hint">{f.description}</p> : null}</div>;
  if (f.type === 'hidden') return <Control f={f} value={props.values?.[f.id]} invalid={false} hidden={props.params?.[f.param ?? f.key]} />;
  const error = props.errors?.[f.id];
  const ids = [describe(f) ? `${f.id}-hint` : '', error ? `${f.id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const value = props.values?.[f.id];
  const grouped = f.type === 'single_choice' || f.type === 'multiple_choice' || f.type === 'yes_no' || f.type === 'consent' || ['rating', 'nps', 'csat', 'ces', 'scale'].includes(f.type);
  const hasScaleLabels = ['rating', 'nps', 'csat', 'ces', 'scale'].includes(f.type) && (f.minLabel || f.maxLabel);
  return (
    <div class={`pub-field fm-field${error ? ' has-error' : ''}`} data-field={f.id} data-type={f.type}>
      {grouped ? (
        <fieldset class="fm-set">
          {f.type === 'consent' ? null : <legend>{f.label}{f.required ? null : <span class="opt"> (optional)</span>}</legend>}
          {describe(f) ? <span class="pub-hint" id={`${f.id}-hint`}>{describe(f)}</span> : null}
          <Choices f={f} value={value} invalid={!!error} describedBy={ids} />
          {hasScaleLabels ? <div class="fm-ends" aria-hidden="true"><span>{f.minLabel}</span><span>{f.maxLabel}</span></div> : null}
        </fieldset>
      ) : (
        <>
          <label for={f.id}>{f.label}{f.required ? null : <span class="opt"> (optional)</span>}</label>
          {describe(f) ? <span class="pub-hint" id={`${f.id}-hint`}>{describe(f)}</span> : null}
          <Control f={f} value={value} invalid={!!error} describedBy={ids} />
        </>
      )}
      {error ? <span class="pub-error" id={`${f.id}-error`} role="alert">{error}</span> : <span class="pub-error" id={`${f.id}-error`} role="alert" hidden></span>}
    </div>
  );
}

function jsonScript(def: Definition): string {
  return JSON.stringify(def).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function FormView(props: FormViewProps) {
  const { form, def, appearance, token, embed } = props;
  const th = form.settings.theme;
  const own: Appearance = { ...appearance, powered: false, ...(th.preset && th.preset !== 'workspace' ? { preset: th.preset } : {}) };
  const slug = form.slug;
  return (
    <PublicPage title={form.name} appearance={own} wide={def.pages.length > 1 || undefined} styles={themeStyles(form)} description={def.intro?.body || undefined}>
      <div class={embed ? 'fm-root is-embed' : 'fm-root'} data-embed={embed ? '1' : undefined}>
        {th.coverKey ? <img class="fm-cover" src={`/f/${slug}/img/cover`} alt="" /> : null}
        <PublicCard class="fm-card">
          {th.logoKey ? <img class="fm-logo" src={`/f/${slug}/img/logo`} alt="" /> : null}
          <h1 class="fm-title">{form.name}</h1>
          {props.banner ? <div class="fm-banner" role="alert">{props.banner}</div> : null}
          {def.intro ? (
            <div class="fm-intro" data-intro>
              <p>{def.intro.body}</p>
            </div>
          ) : null}
          {form.settings.privacy.partial ? <p class="pub-note fm-partial">This form saves your answers as you type, before you press {def.submitLabel.toLowerCase()}.</p> : null}
          <form class="fm" method="post" action={`/f/${slug}/submit`} novalidate data-slug={slug} data-partial={form.settings.privacy.partial ? '1' : undefined} data-progress={def.showProgress ? '1' : undefined} data-submit={def.submitLabel}>
            <input type="hidden" name="_token" value={token} />
            {props.access ? <input type="hidden" name="_access" value={props.access} /> : null}
            <input type="hidden" name="_cid" value="" data-cid />
            <div class="fm-trap" aria-hidden="true"><label>Leave this empty<input type="text" name="_gotcha" tabindex={-1} autocomplete="off" /></label></div>
            <div class="fm-progress" data-progress-bar hidden><span class="fm-bar"><i data-bar></i></span><span class="fm-count" data-count></span></div>
            {def.pages.map((p, i) => (
              <section class="fm-page" data-page={p.id} aria-label={p.title || `Page ${i + 1}`}>
                {p.title ? <h2 class="fm-page-title">{p.title}</h2> : null}
                {p.fields.map((f) => <FieldBlock f={f} props={props} />)}
              </section>
            ))}
            <div class="fm-actions">
              <button class="pub-btn ghost" type="button" data-back hidden>Back</button>
              <button class="pub-btn" type="button" data-next hidden>Next</button>
              <button class="pub-btn" type="submit" data-submit-btn>{def.submitLabel}</button>
            </div>
            <p class="pub-error fm-form-error" role="alert" data-form-error hidden></p>
          </form>
          <div class="fm-done" data-done hidden tabindex={-1}></div>
        </PublicCard>
      </div>
      {raw(`<script type="application/json" id="fm-def">${jsonScript(def)}</script>`)}
      <script src="/m/forms/form.js" defer></script>
    </PublicPage>
  );
}

export function GateView({ form, appearance, error, embed }: { form: Form; appearance: Appearance; error?: string; embed?: boolean }) {
  return (
    <PublicPage title={form.name} appearance={{ ...appearance, powered: false }} styles={themeStyles(form)}>
      <div class={embed ? 'fm-root is-embed' : 'fm-root'}>
        <PublicCard class="fm-card">
          <h1 class="fm-title">{form.name}</h1>
          <p class="pub-note">This form needs a password.</p>
          <form method="post" action={`/f/${form.slug}/unlock`}>
            <div class="pub-field">
              <label for="fm-pw">Password</label>
              <input class="pub-input" id="fm-pw" name="password" type="password" required autocomplete="off" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'fm-pw-error' : undefined} />
              {error ? <span class="pub-error" id="fm-pw-error" role="alert">{error}</span> : null}
            </div>
            {embed ? <input type="hidden" name="_embed" value="1" /> : null}
            <PublicButton type="submit" block>Open the form</PublicButton>
          </form>
        </PublicCard>
      </div>
    </PublicPage>
  );
}

export function NoticeView({ form, appearance, title, body, embed }: { form: Form; appearance: Appearance; title: string; body: string; embed?: boolean }) {
  return (
    <PublicPage title={title} appearance={{ ...appearance, powered: false }} styles={themeStyles(form)}>
      <div class={embed ? 'fm-root is-embed' : 'fm-root'}>
        <PublicCard class="fm-card">
          <h1 class="fm-title">{title}</h1>
          <p class="pub-note">{body}</p>
        </PublicCard>
      </div>
    </PublicPage>
  );
}

export function EndingPage({ form, appearance, ending, embed }: { form: Form; appearance: Appearance; ending: EndingView; embed?: boolean }) {
  return (
    <PublicPage title={ending.title || 'Thank you'} appearance={{ ...appearance, powered: false }} styles={themeStyles(form)}>
      <div class={embed ? 'fm-root is-embed' : 'fm-root'}>
        <PublicCard class="fm-card fm-ending">
          <h1 class="fm-title">{ending.title}</h1>
          {ending.body ? <p>{ending.body}</p> : null}
          {ending.buttonLabel && ending.buttonUrl ? <PublicButton href={ending.buttonUrl}>{ending.buttonLabel}</PublicButton> : null}
        </PublicCard>
      </div>
    </PublicPage>
  );
}

/** The ending for a stored response, with its own answers filled into the copy. */
export function endingFor(def: Definition, e: Ending, answers: Answers, calcs: Record<string, number>): EndingView {
  const values = { ...answers, ...calcs };
  return { id: e.id, title: pipe(e.title, def, values), body: pipe(e.body, def, values), ...(e.buttonLabel && e.buttonUrl ? { buttonLabel: e.buttonLabel, buttonUrl: e.buttonUrl } : {}) };
}

