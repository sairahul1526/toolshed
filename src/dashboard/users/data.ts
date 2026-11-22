/** What the screen reads from the address, and the addresses it builds. */
const MAX_QUERY = 100;

export const BASE = '/app/users';

export type Tab = 'people' | 'workspaces';

export interface ListState {
  tab: Tab;
  /** What was typed in the search box, trimmed. */
  q: string;
  /** The page marker from the service, for the page after the one shown. */
  after: string;
}

export function readListState(params: URLSearchParams): ListState {
  return {
    tab: params.get('tab') === 'workspaces' ? 'workspaces' : 'people',
    q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY),
    after: params.get('after') ?? '',
  };
}

/** A link to the list with some of the state changed. Anything at its default is left out. */
export function listHref(state: ListState, change: Partial<ListState> = {}): string {
  const next = { ...state, ...change };
  const q = new URLSearchParams();
  if (next.tab === 'workspaces') q.set('tab', 'workspaces');
  if (next.q) q.set('q', next.q);
  if (next.after) q.set('after', next.after);
  const text = q.toString();
  return text ? `${BASE}?${text}` : BASE;
}

export const userHref = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
export const workspaceHref = (id: string) => `${BASE}/workspaces/${encodeURIComponent(id)}`;

/** The three ways a ban can end, as the form sends them. */
export const BAN_CHOICES = [
  { value: '', label: 'Until I lift it' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

/** Cut text for a table cell or a message. The full text stays in `title`. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}
