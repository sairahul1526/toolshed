import type { Child } from 'hono/jsx';
import type { Flash } from '../flash';
import { Icon } from './icon';
import { cx } from './util';

export interface ToastProps {
  message: string;
  kind?: Flash['kind'];
}

/**
 * A message that appears at the bottom of the screen and goes away by itself (app.js removes it).
 * The page shell draws one for a flash message; scripts can add more with `window.Toolshed.toast(text)`.
 */
export function Toast({ message, kind = 'info' }: ToastProps) {
  return (
    <div class={cx('toast show', kind === 'error' && 'error')} role={kind === 'error' ? 'alert' : 'status'} data-toast-auto>
      <Icon name={kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'} />
      <span>{message}</span>
    </div>
  );
}

export interface SkeletonProps {
  /** Number of text lines, or a block when `block` is set. */
  lines?: number;
  block?: boolean;
  /** Names what is loading for screen readers. */
  label?: string;
}

/** A grey placeholder shown while something loads. */
export function Skeleton({ lines = 3, block, label = 'Loading' }: SkeletonProps) {
  return (
    <div class="skeleton" role="status" aria-label={label}>
      {block ? <span class="sk sk-block" /> : Array.from({ length: lines }, (_, i) => <span class={cx('sk', i === lines - 1 && lines > 1 && 'short')} />)}
    </div>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

/** Where you are: links for the parents, plain text for the page itself (the last item). */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <>
            {last || !c.href ? (
              <span aria-current={last ? 'page' : undefined} class={cx(!last && 'crumb-parent')}>
                {c.label}
              </span>
            ) : (
              <a href={c.href} class="crumb-parent">
                {c.label}
              </a>
            )}
            {last ? null : (
              <span class="sep" aria-hidden="true">
                /
              </span>
            )}
          </>
        );
      })}
    </nav>
  );
}

export interface EditorBarProps {
  back: { href: string; label: string };
  title: Child;
  /** For example a Pill showing Draft or Published. */
  status?: Child;
  /** Save and publish buttons. */
  actions?: Child;
}

/** The sticky bar on full-page editors: a way back, the name, a status and the save buttons. */
export function EditorBar({ back, title, status, actions }: EditorBarProps) {
  return (
    <div class="editor-bar">
      <a class="btn sm ghost" href={back.href}>
        <Icon name="left" />
        {back.label}
      </a>
      <div class="editor-title">
        <b>{title}</b>
        {status}
      </div>
      {actions ? <div class="actions">{actions}</div> : null}
    </div>
  );
}
