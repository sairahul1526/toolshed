/** Which events exist, and which of them an endpoint's patterns cover. */
import { z } from 'zod';
import { allModules } from '../registry';

export interface CatalogEvent {
  /** The full name an endpoint subscribes to, for example `links.link.clicked`. */
  type: string;
  module: string;
  moduleName: string;
}

/** Every event a module says it emits (`events.emits`), sorted by name. */
export function eventCatalog(): CatalogEvent[] {
  const out: CatalogEvent[] = [];
  for (const m of allModules()) {
    for (const name of m.events?.emits ?? []) out.push({ type: `${m.id}.${name}`, module: m.id, moduleName: m.name });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

/** `*` (everything), `links.*` (one module) or an exact name such as `links.link.clicked`. */
const PATTERN = /^(\*|[a-z][a-z0-9-]*\.\*|[a-z][a-z0-9-]*(\.[a-z0-9_-]+)+)$/;

export const eventPattern = z
  .string('Each event must be text, such as links.link.clicked.')
  .trim()
  .max(100, 'Keep each event name under 100 characters.')
  .regex(PATTERN, 'Use an event name like links.link.clicked, a whole module like links.*, or * for everything.');

export function matchesEvent(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}
