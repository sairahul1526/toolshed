/**
 * Merge tags: `{{first_name|friend}}` becomes the subscriber's value, or the fallback after the bar.
 *
 * The syntax is strict on purpose. A tag is `{{`, a lowercase name, an optional `|fallback`, `}}`.
 * There is no logic, no nesting and no expressions. Values are escaped for the place they land
 * (HTML or plain text), so a name like `<script>` or `**bold**` can never change the email.
 */

const TAG = /\{\{\s*([a-z][a-z0-9_]{0,40})\s*(?:\|([^{}\n]{0,80}))?\}\}/g;

/** Names every email can use without the person having filled anything in. */
export const SYSTEM_TAGS = ['first_name', 'name', 'email', 'list_name', 'unsubscribe_url', 'preferences_url'] as const;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

export type MergeValues = Record<string, string | undefined>;

export interface Subscriberish {
  email: string;
  name?: string;
  fields?: Record<string, unknown>;
}

/** The values a subscriber brings: first_name and name from the name, plus every custom field. */
export function valuesFor(sub: Subscriberish, extra: MergeValues = {}): MergeValues {
  const name = (sub.name ?? '').trim();
  const out: MergeValues = {};
  for (const [key, value] of Object.entries(sub.fields ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = String(value);
  }
  out.email = sub.email;
  if (name) {
    out.name = name;
    out.first_name = name.split(/\s+/)[0]!;
  }
  return { ...out, ...extra };
}

/** Every tag used in a text, with whether it has a fallback. Used by the checklist and the editor. */
export function findTags(text: string): { name: string; fallback: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const m of text.matchAll(TAG)) {
    const name = m[1]!;
    const fallback = m[2] === undefined ? null : m[2].trim();
    if (!seen.has(name) || (seen.get(name) === null && fallback !== null)) seen.set(name, fallback);
  }
  return [...seen.entries()].map(([name, fallback]) => ({ name, fallback }));
}

function pick(values: MergeValues, name: string, fallback: string | undefined): string {
  const value = values[name];
  if (value !== undefined && value.trim() !== '') return value;
  return (fallback ?? '').trim();
}

/** Fill the tags of an HTML string. Values and fallbacks are HTML-escaped. */
export function mergeHtml(html: string, values: MergeValues): string {
  return html.replace(TAG, (_all, name: string, fallback?: string) => escapeHtml(pick(values, name, fallback)));
}

/** Fill the tags of plain text (subjects, the text part). Line breaks are removed from values. */
export function mergeText(text: string, values: MergeValues): string {
  return text.replace(TAG, (_all, name: string, fallback?: string) => pick(values, name, fallback).replace(/[\r\n\u0085\u2028\u2029]+/g, ' '));
}

/** Fill the tags of Markdown. Markdown punctuation in a value is escaped, so a name like `**x**` stays plain. */
export function mergeMarkdown(text: string, values: MergeValues): string {
  return text.replace(TAG, (_all, name: string, fallback?: string) =>
    pick(values, name, fallback)
      .replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
      .replace(/([\\`*_{}[\]()#+!|<>~])/g, '\\$1'),
  );
}
