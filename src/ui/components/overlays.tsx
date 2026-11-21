import type { Child, JSX } from 'hono/jsx';
import { Icon } from './icon';
import { Button, IconButton } from './buttons';
import { cx } from './util';

export interface DialogProps {
  id: string;
  title: string;
  /** Short text under the title. */
  description?: Child;
  size?: 'sm' | 'md' | 'wide';
  /** Buttons along the bottom. Include a Cancel that has `data-close`. */
  footer?: Child;
  children?: Child;
}

/** A modal dialog. Open it with any element that has `data-open="<id>"`; `data-close` inside it closes it. */
export function Dialog({ id, title, description, size = 'md', footer, children }: DialogProps) {
  return (
    <dialog id={id} class={cx(size !== 'md' && size)} aria-labelledby={`${id}-title`}>
      <div class="dlg-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <IconButton icon="x" label="Close" data-close />
      </div>
      <div class="dlg-body">
        {description ? <p class="lead">{description}</p> : null}
        {children}
      </div>
      {footer ? <div class="dlg-foot">{footer}</div> : null}
    </dialog>
  );
}

export interface ConfirmButtonProps {
  /** Text on the button that opens the question. */
  children: Child;
  /** The question, for example "Delete this link?". */
  title: string;
  /** What will happen, and whether it can be undone. */
  body: Child;
  /** Text on the final button, for example "Delete link". */
  confirmLabel: string;
  /** Needed once per page when there are several, so each dialog has its own id. */
  id: string;
  danger?: boolean;
  icon?: string;
  /** Sent with the form when confirmed. */
  name?: string;
  value?: string;
  formAction?: string;
  /** Style of the button that opens the question. */
  variant?: 'default' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
}

/**
 * Asks before doing something that is hard to undo. Place it inside the <form> that does the work:
 * confirming submits that form, cancelling does nothing.
 */
export function ConfirmButton({ children, title, body, confirmLabel, id, danger = true, icon, name, value, formAction, variant, size = 'md' }: ConfirmButtonProps) {
  const dialogId = `confirm-${id}`;
  return (
    <>
      <Button variant={variant ?? (danger ? 'danger' : 'default')} size={size} icon={icon} data-open={dialogId}>
        {children}
      </Button>
      <Dialog
        id={dialogId}
        title={title}
        size="sm"
        footer={
          <>
            <span class="spacer" />
            <Button data-close>Cancel</Button>
            <Button type="submit" variant={danger ? 'danger-solid' : 'primary'} name={name} value={value} formAction={formAction}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p class="lead">{body}</p>
      </Dialog>
    </>
  );
}

export interface MenuItem {
  label: string;
  icon?: string;
  href?: string;
  /** A button instead of a link, for example one that posts a form: set `formAction`. */
  formAction?: string;
  danger?: boolean;
  /** A line above this item. */
  divider?: boolean;
}

export interface MenuProps {
  /** The trigger refers to it as `data-menu="<id>"`. */
  id: string;
  items: MenuItem[];
  head?: { title: string; subtitle?: string };
}

/** A pop-up menu. Put it anywhere on the page; app.js places it next to whatever has `data-menu="<id>"`. */
export function Menu({ id, items, head }: MenuProps) {
  return (
    <div class="menu" id={`menu-${id}`} role="menu">
      {head ? (
        <>
          <div class="menu-head">
            <b>{head.title}</b>
            {head.subtitle ? <span>{head.subtitle}</span> : null}
          </div>
          <hr />
        </>
      ) : null}
      {items.map((it) => (
        <>
          {it.divider ? <hr /> : null}
          {it.href ? (
            <a href={it.href} role="menuitem" class={cx(it.danger && 'danger')}>
              {it.icon ? <Icon name={it.icon} /> : null}
              {it.label}
            </a>
          ) : (
            <button type="submit" role="menuitem" formAction={it.formAction} class={cx(it.danger && 'danger')}>
              {it.icon ? <Icon name={it.icon} /> : null}
              {it.label}
            </button>
          )}
        </>
      ))}
    </div>
  );
}

export interface InspectorProps {
  id: string;
  title: string;
  footer?: Child;
  children?: Child;
}

/** A panel that slides in from the right (details of a row, an editor). Open with `data-inspect="<id>"`. */
export function Inspector({ id, title, footer, children }: InspectorProps) {
  return (
    <aside class="inspector" id={id} aria-labelledby={`${id}-title`} role="dialog" aria-modal="true" aria-hidden="true" data-inspector>
      <div class="insp-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <IconButton icon="x" label="Close panel" data-close />
      </div>
      <div class="insp-body">{children}</div>
      {footer ? <div class="insp-foot">{footer}</div> : null}
    </aside>
  );
}

export interface CopyFieldProps {
  /** What is being copied, spoken by the copy button, for example "invite link". */
  label: string;
  value: string;
  /** Show it as a dashed secret box rather than an input. */
  secret?: boolean;
}

/** A read-only value with a copy button. */
export function CopyField({ label, value, secret = true }: CopyFieldProps) {
  return (
    <div class={secret ? 'secret' : 'input-group'}>
      {secret ? <code>{value}</code> : <input class="input" readonly value={value} aria-label={label} />}
      <IconButton icon="copy" label={`Copy ${label}`} size="sm" data-copy={value} data-copied={`${label[0]?.toUpperCase() ?? ''}${label.slice(1)} copied.`} />
    </div>
  );
}

export interface CodeBlockProps {
  code: string;
  /** Names the block for screen readers, for example "curl example". */
  label: string;
  copy?: boolean;
}

/** A block of code or a command. Plain text only: it is never run or highlighted from user input. */
export function CodeBlock({ code, label, copy = true }: CodeBlockProps) {
  return (
    <pre class="code" tabindex={0} aria-label={label}>
      <code>{code}</code>
      {copy ? <IconButton icon="copy" label={`Copy ${label}`} size="sm" data-copy={code} data-copied="Copied." /> : null}
    </pre>
  );
}

export interface DangerItem {
  title: string;
  description: Child;
  /** The button, usually a ConfirmButton. */
  action: Child;
}

/** The red-edged box at the bottom of a settings screen for things that cannot be undone. */
export function DangerZone({ items, title = 'Danger zone' }: { items: DangerItem[]; title?: string }) {
  return (
    <section class="danger-zone card" aria-label={title}>
      <div class="card-head ruled">
        <h2>{title}</h2>
      </div>
      <ul class="rows">
        {items.map((i) => (
          <li>
            <span class="row-text">
              <b>{i.title}</b>
              <span>{i.description}</span>
            </span>
            {i.action}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface SearchInputProps extends Omit<JSX.IntrinsicElements['input'], 'class' | 'children' | 'type'> {
  label?: string;
}

/** A search box with an icon. Pressing Enter submits the form around it. */
export function SearchInput({ label = 'Search', name = 'q', placeholder = 'Search', ...rest }: SearchInputProps) {
  return (
    <div class="input-group search-in">
      <Icon name="search" />
      <input {...rest} class="input" type="search" name={name} placeholder={placeholder} aria-label={label} />
    </div>
  );
}

export interface FilterBarProps {
  /** Where the filters are sent (GET). Leave empty for the current page. */
  action?: string;
  children?: Child;
}

/** Search and filter controls in one row. A GET form, so the filters live in the URL and can be shared. */
export function FilterBar({ action, children }: FilterBarProps) {
  return (
    <form class="toolbar" method="get" action={action} role="search">
      {children}
      <button class="btn sm" type="submit">
        Apply
      </button>
    </form>
  );
}
