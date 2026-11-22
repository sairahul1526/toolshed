/**
 * The two emails this module sends. Both reuse the shared brand layout through the plain
 * `notification` template, so they pick up the workspace's name, color, logo and footer.
 */
import { renderEmail, type RenderedEmail } from '../../core/email-templates';
import type { Env } from '../../env';
import { formatNumber } from '../../ui/format';
import type { Site } from './sites';
import { derive, type Metrics, type Row } from './stats';

function change(now: number, before: number): string {
  if (before <= 0) return now > 0 ? ' (none the week before)' : '';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return ' (same as the week before)';
  return ` (${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on the week before)`;
}

function top(rows: Row[], pick: (r: Row) => number): string {
  return rows.map((r) => `${r.value} (${formatNumber(pick(r))})`).join(', ');
}

function seconds(total: number): string {
  const s = Math.round(total);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export interface WeeklyReportInput {
  orgId: string;
  site: Pick<Site, 'id' | 'name' | 'domain'>;
  /** For example "5 Jan 2026 to 11 Jan 2026". */
  rangeLabel: string;
  totals: Metrics;
  prev: Metrics | null;
  pages: Row[];
  sources: Row[];
  /** Link to the dashboard for that week. Null when the install has no fixed address. */
  link: string | null;
}

export function weeklyReportEmail(env: Env, input: WeeklyReportInput): Promise<RenderedEmail> {
  const { totals, prev } = input;
  const d = derive(totals);
  const lines = [
    `${input.rangeLabel}.`,
    `Visitors: ${formatNumber(totals.visitors)}${prev ? change(totals.visitors, prev.visitors) : ''}`,
    `Page views: ${formatNumber(totals.pageviews)}${prev ? change(totals.pageviews, prev.pageviews) : ''}`,
  ];
  if (d.bounceRate !== null && d.visitSeconds !== null) {
    lines.push(`Bounce rate: ${Math.round(d.bounceRate * 100)}%. Time per visit: ${seconds(d.visitSeconds)}.`);
  }
  if (input.pages.length) lines.push(`Top pages: ${top(input.pages, (r) => r.visitors)}`);
  if (input.sources.length) lines.push(`Top sources: ${top(input.sources, (r) => r.visitors)}`);
  if (totals.visitors === 0) lines.push('No visits were counted this week. If that is a surprise, check that the snippet is still on your pages.');
  return renderEmail(env, {
    template: 'notification',
    orgId: input.orgId,
    data: { title: `${input.site.name}: your week in numbers`, body: lines.join('\n\n'), ...(input.link ? { link: input.link, linkLabel: 'Open the dashboard' } : {}) },
  });
}

export interface SpikeInput {
  orgId: string;
  site: Pick<Site, 'id' | 'name' | 'domain'>;
  visitors: number;
  threshold: number;
  pages: { value: string; visitors: number }[];
  link: string | null;
}

export function spikeEmail(env: Env, input: SpikeInput): Promise<RenderedEmail> {
  const lines = [
    `${formatNumber(input.visitors)} people visited ${input.site.domain} in the last hour. You asked to hear about more than ${formatNumber(input.threshold)}.`,
  ];
  if (input.pages.length) lines.push(`Where they are right now: ${input.pages.map((p) => `${p.value} (${formatNumber(p.visitors)})`).join(', ')}`);
  lines.push('You will not get another alert for this site for 12 hours.');
  return renderEmail(env, {
    template: 'notification',
    orgId: input.orgId,
    data: { title: `Traffic spike on ${input.site.name}`, body: lines.join('\n\n'), ...(input.link ? { link: input.link, linkLabel: 'See live visitors' } : {}) },
  });
}
