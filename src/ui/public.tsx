/**
 * Building blocks for pages the public sees: forms, short-link previews, the status page.
 * They use /assets/public.css (small, no dashboard styles) and the workspace's saved preset
 * (paper, warm, cobalt or dusk). Colours follow the visitor's light or dark setting.
 */
import type { Child } from 'hono/jsx';
import { DEFAULT_APPEARANCE, type Appearance } from './appearance';
import { cx } from './components/util';
import { Document } from './layout';
import type { Flash } from './flash';

export interface PublicPageProps {
  /** Tab title. The visitor sees "title · Toolshed" unless `brandTitle` is set. */
  title: string;
  appearance?: Appearance;
  /** The workspace or product name above the card. */
  brand?: string;
  /** Wider layout, for forms with many fields. */
  wide?: boolean;
  /** Let search engines index the page. Default is no. */
  indexable?: boolean;
  description?: string;
  /** Force light or dark, for previews. Leave empty to follow the visitor. */
  forceTheme?: 'light' | 'dark';
  flash?: Flash | null;
  /** Add the page's own stylesheet (path under /assets). */
  styles?: string[];
  children?: Child;
}

/** A whole public page: brand, content, and the small "Powered by Toolshed" line when the workspace keeps it on. */
export function PublicPage({ title, appearance = DEFAULT_APPEARANCE, brand, wide, indexable, description, forceTheme, flash, styles, children }: PublicPageProps) {
  return (
    <Document
      title={title}
      description={description}
      appearance={appearance}
      preset={appearance.preset}
      forceTheme={forceTheme}
      lockTheme
      noindex={!indexable}
      baseStyle="/assets/public.css"
      styles={styles}
      scripts={false}
      bodyClass="pub"
      layout="public"
      flash={flash}
    >
      <main class={cx('pub-wrap', wide && 'wide')} id="main">
        {brand ? <div class="pub-brand">{brand}</div> : null}
        {children}
      </main>
      {appearance.powered ? (
        <p class="pub-powered">
          Powered by <a href="https://github.com/sairahul1526/toolshed" rel="noopener">Toolshed</a>
        </p>
      ) : null}
    </Document>
  );
}

export function PublicCard({ children, class: className }: { children?: Child; class?: string }) {
  return <div class={cx('pub-card', className)}>{children}</div>;
}

export interface PublicButtonProps {
  href?: string;
  type?: 'button' | 'submit';
  block?: boolean;
  ghost?: boolean;
  disabled?: boolean;
  children?: Child;
}

/** A button, or a link that looks like one when `href` is set. */
export function PublicButton({ href, type = 'button', block, ghost, disabled, children }: PublicButtonProps) {
  const cls = cx('pub-btn', block && 'block', ghost && 'ghost');
  return href ? (
    <a class={cls} href={href}>
      {children}
    </a>
  ) : (
    <button class={cls} type={type} disabled={disabled}>
      {children}
    </button>
  );
}

export interface PublicFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children?: Child;
}

/** Label, control, hint and error message, wired together for screen readers. */
export function PublicField({ id, label, hint, error, optional, children }: PublicFieldProps) {
  return (
    <div class="pub-field">
      <label for={id}>
        {label}
        {optional ? <span class="opt"> (optional)</span> : null}
      </label>
      {children}
      {hint ? (
        <span class="pub-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span class="pub-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface PublicInputProps {
  id: string;
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
  inputmode?: 'text' | 'email' | 'numeric' | 'tel' | 'url';
  maxlength?: number;
  invalid?: boolean;
  /** Set to match `hint` / `error` on the PublicField so they are read out. */
  describedBy?: string;
}

export function PublicInput({ id, name = id, type = 'text', invalid, describedBy, ...rest }: PublicInputProps) {
  return <input class="pub-input" id={id} name={name} type={type} aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedBy} {...rest} />;
}
