import { cx } from './util';

export interface IconProps {
  /** A name from the sprite in `icons.ts`. */
  name: string;
  class?: string;
  /** Set only when the icon stands alone with no text next to it. */
  label?: string;
}

/** An icon from the page's sprite. Decorative unless it has a label. */
export function Icon({ name, class: className, label }: IconProps) {
  return label ? (
    <svg class={cx('i', className)} role="img" aria-label={label}>
      <use href={`#i-${name}`} />
    </svg>
  ) : (
    <svg class={cx('i', className)} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}
