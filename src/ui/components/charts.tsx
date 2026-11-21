/**
 * Charts are plain SVG drawn on the server: no script, no library. The picture stretches to its box
 * (strokes keep their width), the axis labels are real text next to it, and every chart carries a
 * title, a description and a hidden table of its numbers so screen readers get the same facts.
 */
import { formatCompact, formatNumber } from '../format';
import { slug } from './util';

const W = 600;
const H = 200;
const PAD = 4;

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function DataTable({ labels, series }: { labels: string[]; series: { label: string; values: number[] }[] }) {
  return (
    <table class="sr-only">
      <thead>
        <tr>
          <th scope="col">Label</th>
          {series.map((s) => (
            <th scope="col">{s.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((l, i) => (
          <tr>
            <th scope="row">{l}</th>
            {series.map((s) => (
              <td>{formatNumber(s.values[i] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Axis({ max, labels }: { max: number; labels: string[] }) {
  const first = labels[0];
  const last = labels[labels.length - 1];
  return (
    <>
      <div class="chart-y" aria-hidden="true">
        <span>{formatCompact(max)}</span>
        <span>{formatCompact(max / 2)}</span>
        <span>0</span>
      </div>
      {first !== undefined ? (
        <div class="chart-x" aria-hidden="true">
          <span>{first}</span>
          {labels.length > 2 ? <span>{labels[Math.floor((labels.length - 1) / 2)]}</span> : null}
          {labels.length > 1 ? <span>{last}</span> : null}
        </div>
      ) : null}
    </>
  );
}

function Grid() {
  return (
    <>
      {[0, 0.5, 1].map((f) => (
        <line class="grid" x1="0" x2={W} y1={PAD + f * (H - 2 * PAD)} y2={PAD + f * (H - 2 * PAD)} />
      ))}
    </>
  );
}

export interface BarChartProps {
  title: string;
  description?: string;
  data: { label: string; value: number }[];
  /** Word for what is counted, used in the bar tooltips, for example "visitors". */
  unit?: string;
}

export function BarChart({ title, description, data, unit = '' }: BarChartProps) {
  const id = `chart-${slug(title)}`;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const slot = data.length > 0 ? W / data.length : W;
  const bar = Math.max(2, slot * 0.64);
  return (
    <figure class="chart-fig">
      <div class="chart-box">
        <Axis max={max} labels={data.map((d) => d.label)} />
        <svg class="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={`${id}-t ${id}-d`}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{description ?? `${data.length} values, highest ${formatNumber(Math.max(0, ...data.map((d) => d.value)))}.`}</desc>
          <Grid />
          {data.map((d, i) => {
            const h = (d.value / max) * (H - 2 * PAD);
            return (
              <rect class="bar" x={i * slot + (slot - bar) / 2} y={H - PAD - h} width={bar} height={Math.max(0, h)} rx="2">
                <title>{`${d.label}: ${formatNumber(d.value)} ${unit}`.trim()}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <DataTable labels={data.map((d) => d.label)} series={[{ label: unit || 'Value', values: data.map((d) => d.value) }]} />
    </figure>
  );
}

export interface LineChartProps {
  title: string;
  description?: string;
  /** One label per point, for example dates. Only the first, middle and last are drawn. */
  labels: string[];
  series: { label: string; values: number[] }[];
}

function pointsFor(values: number[], max: number): [number, number][] {
  const n = values.length;
  return values.map((v, i) => [n === 1 ? W / 2 : (i * W) / (n - 1), PAD + (1 - v / max) * (H - 2 * PAD)]);
}

function path(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

export function LineChart({ title, description, labels, series }: LineChartProps) {
  const id = `chart-${slug(title)}`;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  return (
    <figure class="chart-fig">
      <div class="chart-box">
        <Axis max={max} labels={labels} />
        <svg class="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={`${id}-t ${id}-d`}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{description ?? `${series.map((s) => s.label).join(', ')} over ${labels.length} points.`}</desc>
          <Grid />
          {series.map((s, i) => {
            const pts = pointsFor(s.values, max);
            if (pts.length === 0) return null;
            return (
              <>
                {i === 0 ? <path class="area" d={`${path(pts)} L${W},${H - PAD} L0,${H - PAD} Z`} /> : null}
                <path class={`line s${i % 2}`} d={path(pts)} />
              </>
            );
          })}
        </svg>
      </div>
      {series.length > 1 ? (
        <figcaption class="legend">
          {series.map((s, i) => (
            <span>
              <i class={`sw s${i % 2}`} />
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
      <DataTable labels={labels} series={series} />
    </figure>
  );
}

export interface SparklineProps {
  values: number[];
  /** What the numbers are, for screen readers, for example "Clicks, last 14 days". */
  label: string;
}

/** A tiny line with no axes, for a table row or a stat card. */
export function Sparkline({ values, label }: SparklineProps) {
  const max = Math.max(1, ...values);
  const w = 96;
  const h = 28;
  const pts = values.map((v, i): [number, number] => [values.length === 1 ? w / 2 : (i * w) / (values.length - 1), 2 + (1 - v / max) * (h - 4)]);
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${values.map(formatNumber).join(', ')}`}>
      {pts.length > 0 ? <path d={path(pts)} /> : null}
    </svg>
  );
}
