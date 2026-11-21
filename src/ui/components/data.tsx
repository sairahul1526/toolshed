import type { Child } from 'hono/jsx';
import { initials, formatNumber } from '../format';
import { Icon } from './icon';
import { cx } from './util';

/* ---------- Card, PageHeader, Section ---------- */

export interface CardProps {
  title?: Child;
  description?: Child;
  /** Buttons or links on the right of the heading. */
  actions?: Child;
  /** A bar along the bottom, usually the Save button. */
  footer?: Child;
  /** No padding around the content, for tables and lists that run edge to edge. */
  flush?: boolean;
  /** Draw a line under the heading. */
  ruled?: boolean;
  class?: string;
  id?: string;
  children?: Child;
}

export function Card({ title, description, actions, footer, flush, ruled, class: className, id, children }: CardProps) {
  return (
    <article class={cx('card', className)} id={id}>
      {title || actions ? (
        <div class={cx('card-head', ruled && 'ruled')}>
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div class="actions">{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : children ? <div class={cx('card-body', (title || actions) ? 'after-head' : null)}>{children}</div> : null}
      {footer ? <div class="card-foot">{footer}</div> : null}
    </article>
  );
}

export interface PageHeaderProps {
  title: Child;
  /** A paler second part of the title, for example the workspace name. */
  soft?: Child;
  description?: Child;
  actions?: Child;
}

export function PageHeader({ title, soft, description, actions }: PageHeaderProps) {
  return (
    <div class="page-head">
      <div>
        <h1>
          {title}
          {soft ? <span class="soft"> {soft}</span> : null}
        </h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div class="actions">{actions}</div> : null}
    </div>
  );
}

export interface SectionProps {
  title: Child;
  description?: Child;
  children?: Child;
}

/** A settings block: title and explanation on the left, the controls on the right. */
export function Section({ title, description, children }: SectionProps) {
  return (
    <section class="sec">
      <div class="sec-info">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div class="stack">{children}</div>
    </section>
  );
}

/* ---------- Stat ---------- */

export interface StatProps {
  label: string;
  /** Already formatted, for example formatNumber(18420). */
  value: string;
  unit?: string;
  /** One sentence under the number. */
  note?: Child;
  icon?: string;
  href?: string;
}

export function Stat({ label, value, unit, note, icon, href }: StatProps) {
  return (
    <article class="card kpi">
      <div class="card-head">
        <h3>{href ? <a href={href}>{label}</a> : label}</h3>
      </div>
      <div class="kpi-body">
        <div class="kpi-value">
          {icon ? (
            <span class="tile">
              <Icon name={icon} />
            </span>
          ) : null}
          <span class="num">
            {value}
            {unit ? <span class="unit">{unit}</span> : null}
          </span>
        </div>
        {note ? <p class="kpi-note">{note}</p> : null}
      </div>
    </article>
  );
}

export function StatGrid({ children, label = 'Key numbers' }: { children?: Child; label?: string }) {
  return (
    <section class="kpis" aria-label={label}>
      {children}
    </section>
  );
}

/* ---------- Table ---------- */

export interface TableColumn {
  key: string;
  label: string;
  /** Right-aligned digits. */
  numeric?: boolean;
  /** Hidden at 760 px wide and below, where rows turn into cards. */
  hideOnMobile?: boolean;
  /** Header text is read aloud but not drawn (for a column of action buttons). */
  srOnly?: boolean;
}

export interface TableProps {
  columns: TableColumn[];
  /** One object per row, a cell per column key. */
  rows: Record<string, Child>[];
  /** Describes the table to screen readers. */
  caption: string;
  /** Shown instead of the table when there are no rows. */
  empty?: Child;
  class?: string;
}

/** A data table. On narrow screens each row becomes a small card, with the column name before each value. */
export function Table({ columns, rows, caption, empty, class: className }: TableProps) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div class="table-wrap">
      <table class={cx('stack-table', className)}>
        <caption class="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th scope="col" class={cx(c.numeric && 'num-col', c.hideOnMobile && 'hide-m')}>
                {c.srOnly ? <span class="sr-only">{c.label}</span> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr>
              {columns.map((c) => (
                <td data-label={c.srOnly ? undefined : c.label} class={cx(c.numeric && 'num-col', c.hideOnMobile && 'hide-m', c.srOnly && 'actions-col')}>
                  {row[c.key] ?? null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  /** Builds the link for a page number, for example (p) => `/app/links?page=${p}`. */
  href: (page: number) => string;
  noun?: [string, string];
}

/** "Showing 26 to 50 of 312" with previous and next links. Renders nothing for a single page. */
export function Pagination({ page, pageSize, total, href, noun = ['result', 'results'] }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) return null;
  const current = Math.min(Math.max(1, page), pages);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return (
    <nav class="pagination" aria-label="Pagination">
      <span class="muted">
        Showing {formatNumber(from)} to {formatNumber(to)} of {formatNumber(total)} {total === 1 ? noun[0] : noun[1]}
      </span>
      <span class="row">
        {current > 1 ? (
          <a class="btn sm" href={href(current - 1)} rel="prev">
            <Icon name="left" />
            Previous
          </a>
        ) : (
          <span class="btn sm is-disabled" aria-disabled="true">
            <Icon name="left" />
            Previous
          </span>
        )}
        {current < pages ? (
          <a class="btn sm" href={href(current + 1)} rel="next">
            Next
            <Icon name="right" />
          </a>
        ) : (
          <span class="btn sm is-disabled" aria-disabled="true">
            Next
            <Icon name="right" />
          </span>
        )}
      </span>
    </nav>
  );
}

/* ---------- Pill, Avatar ---------- */

export type PillTone = 'neutral' | 'good' | 'warn' | 'bad' | 'solid';

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children?: Child }) {
  return <span class={cx('pill', tone)}>{children}</span>;
}

export interface AvatarProps {
  /** Name or email. Initials are drawn from it. */
  name: string;
  /** Picture URL. Falls back to initials. */
  src?: string | null;
  size?: 'sm' | 'md';
}

export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  return (
    <span class={cx('avatar', size === 'sm' && 'sm')} title={name}>
      {src ? <img src={src} alt="" width="32" height="32" loading="lazy" /> : <span aria-hidden="true">{initials(name)}</span>}
      {src ? null : <span class="sr-only">{name}</span>}
    </span>
  );
}

/* ---------- EmptyState, Callout ---------- */

export interface EmptyStateProps {
  icon?: string;
  title: string;
  body?: Child;
  /** One main next step and at most one other. */
  actions?: Child;
  /** Put it inside a card, the usual case. */
  bare?: boolean;
}

export function EmptyState({ icon = 'layers', title, body, actions, bare }: EmptyStateProps) {
  const inner = (
    <div class="empty">
      <span class="tile">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {actions ? <div class="row">{actions}</div> : null}
    </div>
  );
  return bare ? inner : <article class="card">{inner}</article>;
}

export type CalloutTone = 'info' | 'good' | 'warn' | 'bad';

export interface CalloutProps {
  tone?: CalloutTone;
  title?: Child;
  icon?: string;
  actions?: Child;
  children?: Child;
}

const CALLOUT_ICON: Record<CalloutTone, string> = { info: 'info', good: 'shieldcheck', warn: 'alert', bad: 'alert' };

export function Callout({ tone = 'info', title, icon, actions, children }: CalloutProps) {
  return (
    <div class={cx('callout', tone !== 'info' && tone)} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon name={icon ?? CALLOUT_ICON[tone]} />
      <div>
        {title ? <b>{title}</b> : null}
        {children ? <p>{children}</p> : null}
        {actions ? <div class="row">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ---------- Tabs ---------- */

export interface TabItem {
  id: string;
  label: string;
  /** A small count after the label. */
  count?: number;
  /** With an href the tab is a link (a page per tab). Without one it switches a panel on this page. */
  href?: string;
  /** Panel content, for tabs that switch on the page. */
  content?: Child;
}

export interface TabsProps {
  items: TabItem[];
  /** The selected tab's id. */
  active: string;
  /** Accessible name for the tab list. */
  label: string;
}

export function Tabs({ items, active, label }: TabsProps) {
  const links = items.some((t) => t.href !== undefined);
  if (links) {
    return (
      <nav class="tabs" aria-label={label}>
        {items.map((t) => (
          <a href={t.href} aria-current={t.id === active ? 'page' : undefined} class="tab-link">
            {t.label}
            {t.count !== undefined ? <span class="n">{formatNumber(t.count)}</span> : null}
          </a>
        ))}
      </nav>
    );
  }
  return (
    <div>
      <div class="tabs" role="tablist" aria-label={label}>
        {items.map((t) => (
          <button type="button" role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={t.id === active ? 'true' : 'false'} tabindex={t.id === active ? 0 : -1}>
            {t.label}
            {t.count !== undefined ? <span class="n">{formatNumber(t.count)}</span> : null}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={t.id !== active} class="tab-panel">
          {t.content}
        </div>
      ))}
    </div>
  );
}

/* ---------- KeyValueList ---------- */

export function KeyValueList({ items }: { items: { label: string; value: Child }[] }) {
  return (
    <dl class="kv">
      {items.map((i) => (
        <>
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
        </>
      ))}
    </dl>
  );
}
