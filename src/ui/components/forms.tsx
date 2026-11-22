import type { Child, JSX } from 'hono/jsx';
import { Icon } from './icon';
import { IconButton } from './buttons';
import { cx } from './util';

export interface FieldProps {
  /** Ties the label, hint and error to the control with this id. */
  id: string;
  label: Child;
  hint?: Child;
  /** Shown under the control in red. Pair it with `invalid` on the control itself. */
  error?: Child;
  optional?: boolean;
  /**
   * A button that belongs to the control, for example "Send code" or "Copy". It sits level with the
   * control (never with the hint) and drops under it at 375 px. The hint and error stay below both.
   */
  action?: Child;
  class?: string;
  children?: Child;
}

/** Label, control, hint and inline error in one block. */
export function Field({ id, label, hint, error, optional, action, class: className, children }: FieldProps) {
  return (
    <div class={className}>
      <label class="lbl" for={id}>
        {label}
        {optional ? <span class="opt"> optional</span> : null}
      </label>
      {action ? (
        <div class="field-action">
          {children}
          {action}
        </div>
      ) : (
        children
      )}
      {hint ? (
        <p class="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p class="err-text" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string | undefined, explicit: unknown): string | undefined {
  if (typeof explicit === 'string') return explicit;
  return id ? `${id}-hint ${id}-error` : undefined;
}

export interface InputProps extends Omit<JSX.IntrinsicElements['input'], 'class' | 'children'> {
  invalid?: boolean;
  /** Icon inside the left edge. */
  icon?: string;
  /** Fixed text before the value, for example "https://". */
  prefix?: Child;
  /** Fixed text after the value, for example "/ month". */
  suffix?: Child;
  class?: string;
}

export function Input({ invalid, icon, prefix, suffix, class: className, id, ...rest }: InputProps) {
  const input = (
    <input
      type="text"
      {...rest}
      id={id}
      class={cx('input', invalid && 'invalid', className)}
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={describedBy(id, rest['aria-describedby'])}
    />
  );
  if (!icon && !prefix && !suffix) return input;
  return (
    <div class="input-group">
      {icon ? <Icon name={icon} /> : null}
      {prefix ? <span class="addon">{prefix}</span> : null}
      {input}
      {suffix ? <span class="addon">{suffix}</span> : null}
    </div>
  );
}

export interface TextareaProps extends Omit<JSX.IntrinsicElements['textarea'], 'class' | 'children'> {
  invalid?: boolean;
  value?: string;
  class?: string;
}

export function Textarea({ invalid, value, class: className, id, rows = 3, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      id={id}
      rows={rows}
      class={cx('input', invalid && 'invalid', className)}
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={describedBy(id, rest['aria-describedby'])}
    >
      {value ?? ''}
    </textarea>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<JSX.IntrinsicElements['select'], 'class' | 'children'> {
  options: SelectOption[];
  /** The selected option's value. */
  value?: string;
  invalid?: boolean;
  class?: string;
}

export function Select({ options, value, invalid, class: className, id, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      id={id}
      class={cx('input', invalid && 'invalid', className)}
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={describedBy(id, rest['aria-describedby'])}
    >
      {options.map((o) => (
        <option value={o.value} selected={o.value === value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface CheckboxProps extends Omit<JSX.IntrinsicElements['input'], 'class' | 'children' | 'type' | 'label'> {
  label: Child;
  description?: Child;
  class?: string;
}

export function Checkbox({ label, description, class: className, ...rest }: CheckboxProps) {
  return (
    <label class={cx('check', className)}>
      <input {...rest} type="checkbox" />
      <span>
        <b>{label}</b>
        {description ? <span>{description}</span> : null}
      </span>
    </label>
  );
}

export interface SwitchProps extends Omit<JSX.IntrinsicElements['input'], 'class' | 'children' | 'type' | 'role'> {
  /** Required: a switch has no visible text of its own. */
  label: string;
  large?: boolean;
  class?: string;
}

/** An on/off control that is a real checkbox, so it submits with its form and works without JavaScript. */
export function Switch({ label, large, class: className, ...rest }: SwitchProps) {
  return <input {...rest} type="checkbox" role="switch" aria-label={label} class={cx('switch', large && 'switch-lg', className)} />;
}

export interface RadioCardOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface RadioCardsProps {
  name: string;
  options: RadioCardOption[];
  value?: string;
  /** Accessible name of the group when there is no visible heading. */
  label: string;
  columns?: 2 | 3;
  required?: boolean;
}

/** Big selectable cards, one per choice. Native radio buttons underneath. */
export function RadioCards({ name, options, value, label, columns = 3, required }: RadioCardsProps) {
  return (
    <div class={cx('choices', columns === 2 && 'two')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label class="choice">
          <input class="sr-only" type="radio" name={name} value={o.value} checked={o.value === value} required={required} />
          {o.icon ? (
            <span class="tile">
              <Icon name={o.icon} />
            </span>
          ) : null}
          <b>{o.label}</b>
          {o.description ? <span>{o.description}</span> : null}
        </label>
      ))}
    </div>
  );
}

export interface SegmentedProps {
  name: string;
  options: { value: string; label: string }[];
  value?: string;
  label: string;
}

/** A small either-or control (for example Month and Week). Native radio buttons underneath. */
export function Segmented({ name, options, value, label }: SegmentedProps) {
  return (
    <div class="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label>
          <input class="sr-only" type="radio" name={name} value={o.value} checked={o.value === value} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export interface OtpInputProps {
  name: string;
  length?: number;
  /** Visible digits get "Digit 1 of 6" labels. This is the group's own name. */
  label?: string;
  invalid?: boolean;
  autofocus?: boolean;
}

/**
 * Six boxes for a one-time code. app.js moves between them, accepts a pasted code and fills one hidden field.
 * Without JavaScript a single plain field is shown instead.
 */
export function OtpInput({ name, length = 6, label = 'One-time code', invalid, autofocus }: OtpInputProps) {
  const half = Math.floor(length / 2);
  const boxes: Child[] = [];
  for (let i = 0; i < length; i++) {
    if (length > 4 && i === half) boxes.push(<span class="gap" aria-hidden="true" />);
    boxes.push(
      <input
        type="text"
        inputmode="numeric"
        maxlength={1}
        autocomplete={i === 0 ? 'one-time-code' : 'off'}
        aria-label={`Digit ${i + 1} of ${length}`}
        aria-invalid={invalid ? 'true' : undefined}
        autofocus={autofocus && i === 0 ? true : undefined}
      />,
    );
  }
  return (
    <div>
      <input class="input otp-plain" type="text" name={name} inputmode="numeric" autocomplete="one-time-code" maxlength={length} aria-label={label} placeholder={'0'.repeat(length)} />
      <div class="otp" role="group" aria-label={label} data-otp>
        {boxes}
        <input type="hidden" name={name} data-otp-value disabled />
      </div>
    </div>
  );
}

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'icon' | 'prefix' | 'suffix'> {}

/** A password field with a show and hide button. */
export function PasswordInput({ invalid, class: className, id, ...rest }: PasswordInputProps) {
  return (
    <div class="input-group">
      <input
        autocomplete="current-password"
        {...rest}
        id={id}
        type="password"
        class={cx('input', invalid && 'invalid', className)}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={describedBy(id, rest['aria-describedby'])}
      />
      <IconButton icon="eye" label="Show password" size="sm" data-toggle-password aria-pressed="false" />
    </div>
  );
}
