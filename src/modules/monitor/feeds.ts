/** RSS and Atom feeds of a status page's incidents and the machine-readable status.json. */
import type { StatusData, StatusIncident } from './pages';

export const xmlEscape = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function items(data: StatusData): StatusIncident[] {
  return [...data.active, ...data.past].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30);
}

function summary(i: StatusIncident): string {
  const latest = i.updates[0];
  return `${cap(i.status)}${latest ? `: ${latest.body}` : ''}`;
}

function bodyHtml(i: StatusIncident): string {
  return i.updates.map((u) => `<p><strong>${xmlEscape(cap(u.status))}</strong> (${new Date(u.at).toUTCString()}): ${xmlEscape(u.body)}</p>`).join('');
}

export function rssFeed(data: StatusData, base: string): string {
  const link = `${base}/status/${data.page.slug}`;
  const entries = items(data)
    .map(
      (i) => `<item><title>${xmlEscape(i.title)}</title><link>${xmlEscape(link)}#${xmlEscape(i.id)}</link><guid isPermaLink="false">${xmlEscape(i.id)}:${i.updates[0]?.at ?? i.startedAt}</guid><pubDate>${new Date(i.updates[0]?.at ?? i.startedAt).toUTCString()}</pubDate><description>${xmlEscape(summary(i))}</description></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xmlEscape(data.page.title)} status</title><link>${xmlEscape(link)}</link><description>${xmlEscape(data.overall.text)}</description><lastBuildDate>${new Date(data.generatedAt).toUTCString()}</lastBuildDate>${entries}</channel></rss>`;
}

export function atomFeed(data: StatusData, base: string): string {
  const link = `${base}/status/${data.page.slug}`;
  const list = items(data);
  const updated = new Date(list[0]?.updates[0]?.at ?? data.generatedAt).toISOString();
  const entries = list
    .map(
      (i) => `<entry><id>${xmlEscape(link)}#${xmlEscape(i.id)}</id><title>${xmlEscape(i.title)}</title><link href="${xmlEscape(link)}"/><updated>${new Date(i.updates[0]?.at ?? i.startedAt).toISOString()}</updated><summary>${xmlEscape(summary(i))}</summary><content type="html">${xmlEscape(bodyHtml(i))}</content></entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${xmlEscape(link)}</id><title>${xmlEscape(data.page.title)} status</title><link href="${xmlEscape(link)}"/><link rel="self" href="${xmlEscape(link)}/feed.atom"/><updated>${updated}</updated>${entries}</feed>`;
}

/** Same shape other status pages use, so existing tools can read it. */
export function statusJson(data: StatusData, base: string) {
  const comps = [...data.groups.flatMap((g) => g.components.map((c) => ({ c, group: g.name }))), ...data.loose.map((c) => ({ c, group: null as string | null }))];
  return {
    page: { name: data.page.title, url: `${base}/status/${data.page.slug}`, updated_at: new Date(data.generatedAt).toISOString() },
    status: { indicator: data.overall.status === 'operational' ? 'none' : data.overall.status === 'maintenance' ? 'maintenance' : data.overall.status === 'degraded' ? 'minor' : data.overall.status === 'partial' ? 'major' : 'critical', description: data.overall.text },
    components: comps.map(({ c, group }) => ({ id: c.id, name: c.name, group, status: c.status, uptime_percent: c.uptimePct === null ? null : Math.round(c.uptimePct * 1000) / 1000 })),
    incidents: data.active.map((i) => ({ id: i.id, name: i.title, status: i.status, impact: i.impact, started_at: new Date(i.startedAt).toISOString(), updates: i.updates.map((u) => ({ status: u.status, body: u.body, at: new Date(u.at).toISOString() })) })),
    scheduled_maintenances: data.maintenance.map((m) => ({ id: m.id, name: m.title, active: m.active, starts_at: new Date(m.start).toISOString(), ends_at: new Date(m.end).toISOString() })),
  };
}

/** A small SVG badge: "status | all systems operational". Colours are fixed so it reads anywhere. */
export function badgeSvg(label: string, value: string, status: StatusData['overall']['status']): string {
  const color = { operational: '#1f9d55', maintenance: '#2f6fed', degraded: '#d99a00', partial: '#e0701a', major: '#d6342b' }[status];
  const w1 = 12 + label.length * 6.4;
  const w2 = 12 + value.length * 6.4;
  const total = w1 + w2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total.toFixed(0)}" height="20" role="img" aria-label="${xmlEscape(label)}: ${xmlEscape(value)}"><title>${xmlEscape(label)}: ${xmlEscape(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${total.toFixed(0)}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${w1.toFixed(0)}" height="20" fill="#555"/><rect x="${w1.toFixed(0)}" width="${w2.toFixed(0)}" height="20" fill="${color}"/><rect width="${total.toFixed(0)}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${(w1 / 2).toFixed(1)}" y="14">${xmlEscape(label)}</text><text x="${(w1 + w2 / 2).toFixed(1)}" y="14">${xmlEscape(value)}</text></g></svg>`;
}
