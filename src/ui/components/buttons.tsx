import type { Child, JSX } from 'hono/jsx';
import { Icon } from './icon';
import { cx } from './util';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost';
export type ButtonSize = 'md' | 'sm' | 'block';

function buttonClass(variant: ButtonVariant, size: ButtonSize, extra?: string) {
  return cx('btn', variant !== 'default' && variant, size !== 'md' && size, extra);
}

export interface ButtonProps extends Omit<JSX.IntrinsicElements['button'], 'children' | 'class' | 'size'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon name shown before the label. */
  icon?: string;
  class?: string;
  children?: Child;
}

/** A button. Submit buttons show a busy state on their own while the form is sent (see app.js). */
export function Button({ variant = 'default', size = 'md', icon, class: className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} class={buttonClass(variant, size, className)}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export interface LinkButtonProps extends Omit<JSX.IntrinsicElements['a'], 'children' | 'class'> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  class?: string;
  children?: Child;
}

/** A link that looks like a button. */
export function LinkButton({ variant = 'default', size = 'md', icon, class: className, children, ...rest }: LinkButtonProps) {
  return (
    <a {...rest} class={buttonClass(variant, size, className)}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </a>
  );
}

export interface IconButtonProps extends Omit<JSX.IntrinsicElements['button'], 'children' | 'class' | 'size'> {
  icon: string;
  /** What the button does. Spoken by screen readers and shown as a tooltip. */
  label: string;
  size?: 'md' | 'sm';
  bordered?: boolean;
  class?: string;
}

/** A square button with just an icon. The label is required so it is never unnamed. */
export function IconButton({ icon, label, size = 'md', bordered, class: className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button title={label} {...rest} type={type} aria-label={label} class={cx('icon-btn', size === 'sm' && 'sm', bordered && 'bordered', className)}>
      <Icon name={icon} />
    </button>
  );
}
