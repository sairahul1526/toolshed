/** The Links screen: first run, the quick "shorten" box, the list with filters and bulk actions, and the full create form. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { csvRow } from '../../core/csv';
import {
  Button, Callout, Card, ConfirmButton, CopyField, EditorBar, EmptyState, FilterBar, IconButton, Input, LinkButton, Menu, PageHeader, Pill, SearchInput, Select, Sparkline, Table, formatNumber, timeAgo,
} from '../../ui';
import type { PillTone } from '../../ui';
import { csvResponse, flashAndGo, HOME, many, page, plainError, readForm, safely, text, valuesOf, writer } from './dash-shared';
import { LinkFields, toInput, type Values } from './dash-form';
import { ctxOf, limitCreate } from './ctx';
import { listFolders } from './folders';
import { bulkAction, countByStatus, createLink, duplicateLink, getLink, listLinks, listTags, setArchived, sparklines } from './links';
import type { LinkState, LinkView } from './types';

export const links = new Hono<AppEnv>();

const STATE: Record<LinkState, { tone: PillTone; label: string }> = {
  live: { tone: 'good', label: 'Live' },
  scheduled: { tone: 'neutral', label: 'Scheduled' },
  expired: { tone: 'warn', label: 'Ended' },
  capped: { tone: 'warn', label: 'Limit reached' },
  archived: { tone: 'neutral', label: 'Archived' },
  disabled: { tone: 'bad', label: 'Disabled' },
};

export const StatePill = ({ state }: { state: LinkState }) => <Pill tone={STATE[state].tone}>{STATE[state].label}</Pill>;

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'clicks', label: 'Most clicks' },
  { value: 'title', label: 'Title A to Z' },
  { value: 'code', label: 'Code A to Z' },
];

const bare = (u: string): string => u.replace(/^https?:\/\//, '');

/** Short link, its QR code and copy button: shown right after a link is made. */
function Ready({ link }: { link: LinkView }) {
  return (
    <Card title="Your short link is ready" description={<>Pointing to <span class="mono">{bare(link.url)}</span></>} id="ready">
      <div class="lk-ready">
        <div class="lk-ready-main">
          <CopyField label="short link" value={link.shortUrl} />
          <div class="lk-actions">
            <LinkButton href={`${HOME}/${link.id}`} icon="edit">Edit details</LinkButton>
            <LinkButton href={`/l/qr/${link.code}?download=1`} icon="download">Download QR as SVG</LinkButton>
            <Button data-qr-png={`/l/qr/${link.code}?size=1024`} data-qr-name={`${link.code}-qr.png`} icon="download">Download QR as PNG</Button>
          </div>
        </div>
        <img class="lk-qr" src={`/l/qr/${link.code}?size=320`} width="160" height="160" alt={`QR code for ${link.shortUrl}`} />
      </div>
    </Card>
  );
}

function QuickBox() {
  return (
    <form method="post" action={HOME} class="lk-quick">
      <label class="sr-only" for="q-url">Destination address</label>
      <Input id="q-url" name="url" type="url" required placeholder="Paste a long address, like https://example.com/a/long/page" icon="link" autocomplete="off" />
      <Button type="submit" variant="primary">Shorten</Button>
    </form>
  );
}

const dashQuery = (q: Record<string, string>, extra: Record<string, string> = {}): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

links.get('/', (c) =>
  safely(c, 'Links', async () => {
    const ctx = ctxOf(c);
    const q = c.req.query();
    const filters = { q: q.q ?? '', tag: q.tag ?? '', folder: q.folder ?? '', status: q.status ?? 'active', sort: q.sort ?? 'newest' };
    const [counts, list, tags, folders] = await Promise.all([
      countByStatus(ctx),
      listLinks(ctx, { q: filters.q || undefined, tag: filters.tag || undefined, folder: filters.folder || undefined, status: filters.status as 'active', sort: filters.sort as 'newest', limit: 25, cursor: q.cursor || undefined }),
      listTags(ctx),
      listFolders(ctx),
    ]);
    const total = counts.active + counts.archived + counts.disabled;
    const made = q.made ? await getLink(ctx, q.made).catch(() => null) : null;
    if (total === 0) {
      return (
        <>
          <PageHeader title="Links" description="Short links with QR codes, click stats and a bio page." />
          <Card title="Shorten your first link" description="Paste a long web address. You get a short link and a QR code to share.">
            <QuickBox />
          </Card>
          <div class="lk-pad">
            <EmptyState icon="link" title="No links yet" body="Your links will show up here with their clicks. Want to bring links from Bitly or a spreadsheet?" actions={<LinkButton href={`${HOME}/import`} icon="upload">Import from a CSV file</LinkButton>} />
          </div>
        </>
      );
    }
    const spark = await sparklines(ctx, list.items.map((l) => l.id));
    const filtered = Boolean(filters.q || filters.tag || filters.folder || filters.status !== 'active');
    const back = `${HOME}${dashQuery(filters)}`;
    const rows = list.items.map((l) => ({
      select: <input type="checkbox" name="ids" value={l.id} aria-label={`Select ${l.title || l.code}`} data-select-row />,
      link: (
        <div class="lk-cell">
          <a href={`${HOME}/${l.id}`} class="lk-name">{l.title || `/${l.code}`}</a>
          <span class="mono muted lk-short">{bare(l.shortUrl)}</span>
          <span class="muted lk-dest" title={l.url}>{bare(l.url)}</span>
        </div>
      ),
      state: <StatePill state={l.state} />,
      clicks: formatNumber(l.clicks),
      trend: <Sparkline values={spark.get(l.id) ?? []} label={`Clicks per day for /${l.code}`} />,
      tags: l.tags.length ? <span class="lk-tags">{l.tags.slice(0, 3).map((t) => <span class="tag">{t}</span>)}</span> : <span class="muted">None</span>,
      created: timeAgo(new Date(l.createdAt)),
      actions: (
        <span class="lk-row-actions">
          <IconButton icon="copy" label={`Copy short link for ${l.code}`} size="sm" data-copy={l.shortUrl} data-copied="Short link copied." />
          <IconButton icon="more" label={`More actions for ${l.code}`} size="sm" data-menu={`row-${l.id}`} />
          <Menu id={`row-${l.id}`} items={[
            { label: 'Edit', icon: 'edit', href: `${HOME}/${l.id}` },
            { label: 'See stats', icon: 'chart', href: `${HOME}/stats?link=${l.id}` },
            { label: 'Duplicate', icon: 'copy', formAction: `${HOME}/${l.id}/duplicate`, divider: true },
            l.status === 'archived' ? { label: 'Restore', icon: 'refresh', formAction: `${HOME}/${l.id}/restore` } : { label: 'Archive', icon: 'down', formAction: `${HOME}/${l.id}/archive` },
          ]} />
        </span>
      ),
    }));
    const next = list.nextCursor ? `${HOME}${dashQuery(filters, { cursor: list.nextCursor })}` : null;
    return (
      <>
        <PageHeader title="Links" description={`${formatNumber(counts.active)} active, ${formatNumber(counts.archived)} archived.`} actions={<LinkButton href={`${HOME}/new`} icon="plus" variant="primary">New link</LinkButton>} />
        {made ? <Ready link={made} /> : null}
        <Card><QuickBox /></Card>
        <FilterBar action={HOME}>
          <SearchInput name="q" label="Search links" placeholder="Search titles, codes and addresses" value={filters.q} />
          <Select name="status" aria-label="Status" value={filters.status} options={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'disabled', label: 'Disabled' }, { value: 'all', label: 'All' }]} />
          <Select name="tag" aria-label="Tag" value={filters.tag} options={[{ value: '', label: 'Any tag' }, ...tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.links})` }))]} />
          <Select name="folder" aria-label="Folder" value={filters.folder} options={[{ value: '', label: 'Any folder' }, ...folders.map((f) => ({ value: f.id, label: `${f.name} (${f.links})` }))]} />
          <Select name="sort" aria-label="Sort" value={filters.sort} options={SORTS} />
        </FilterBar>
        <form method="post" action={`${HOME}/bulk`} class="lk-bulk">
          <input type="hidden" name="back" value={back} />
          <div class="lk-bulkbar" role="group" aria-label="Actions for selected links">
            <label class="lk-all"><input type="checkbox" data-select-all aria-label="Select all links on this page" /> Select all</label>
            <span class="lk-bulk-tag"><Input name="tag" aria-label="Tag to add" placeholder="Tag" maxlength={32} /><Button type="submit" name="action" value="tag" size="sm">Add tag</Button></span>
            <Button type="submit" name="action" value="archive" size="sm">Archive</Button>
            <Button type="submit" name="action" value="restore" size="sm" icon="refresh">Restore</Button>
            <Button type="submit" name="action" value="export" size="sm" icon="download">Export CSV</Button>
            <ConfirmButton id="bulk-delete" title="Delete the selected links?" body="They stop working right away and their click history is removed. This can’t be undone." confirmLabel="Delete links" name="action" value="delete" size="sm" icon="trash">Delete</ConfirmButton>
          </div>
          <Table
            caption="Short links"
            columns={[
              { key: 'select', label: 'Select', srOnly: true },
              { key: 'link', label: 'Link' },
              { key: 'state', label: 'Status', hideOnMobile: true },
              { key: 'clicks', label: 'Clicks', numeric: true },
              { key: 'trend', label: 'Last 14 days', hideOnMobile: true },
              { key: 'tags', label: 'Tags', hideOnMobile: true },
              { key: 'created', label: 'Created', hideOnMobile: true },
              { key: 'actions', label: 'Actions', srOnly: true },
            ]}
            rows={rows}
            empty={
              <EmptyState icon="search" title={filtered ? 'No links match' : 'Nothing here'} body={filtered ? 'Try a different search or clear the filters.' : 'Make a link with the box above.'} actions={filtered ? <LinkButton href={HOME}>Clear filters</LinkButton> : undefined} />
            }
          />
        </form>
        {next ? <div class="lk-more"><LinkButton href={next} icon="right">Next links</LinkButton><span class="muted">Showing {list.items.length} links</span></div> : null}
      </>
    );
  }),
);

links.post('/', async (c) => {
  writer(c);
  const f = await readForm(c);
  try {
    await limitCreate(c);
    const link = await createLink(ctxOf(c), { url: text(f, 'url') });
    await auditFromRequest(c, { action: 'links.link.created', targetType: 'link', targetId: link.id, summary: `Created /${link.code}`, meta: { code: link.code } });
    return c.redirect(`${HOME}?made=${encodeURIComponent(link.code)}`, 303);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, HOME);
  }
});

// The full form ---------------------------------------------------------------------------------

async function newScreen(c: Parameters<typeof page>[0], v: Values, errors: Record<string, string>, status?: 422) {
  const ctx = ctxOf(c);
  const folders = await listFolders(ctx);
  return page(c, 'New link', (
    <form method="post" action={`${HOME}/new`} class="lk-form-page">
      <EditorBar back={{ href: HOME, label: 'Links' }} title="New link" actions={<Button type="submit" variant="primary">Create link</Button>} />
      {Object.keys(errors).length ? <Callout tone="bad" title="Some fields need fixing">Check the highlighted fields below.</Callout> : null}
      <LinkFields v={v} errors={errors} folders={folders} base={ctx.base} />
    </form>
  ), undefined, status);
}

links.get('/new', (c) => newScreen(c, { url: c.req.query('url') ?? '', redirectType: '302' }, {}));

links.post('/new', async (c) => {
  writer(c);
  const f = await readForm(c);
  try {
    await limitCreate(c);
    const link = await createLink(ctxOf(c), toInput(f, false));
    await auditFromRequest(c, { action: 'links.link.created', targetType: 'link', targetId: link.id, summary: `Created /${link.code}`, meta: { code: link.code } });
    return c.redirect(`${HOME}?made=${encodeURIComponent(link.code)}`, 303);
  } catch (e) {
    const { fields, message } = plainError(e);
    return newScreen(c, valuesOf(f), Object.keys(fields).length ? fields : { url: message }, 422);
  }
});

// Bulk actions ----------------------------------------------------------------------------------

const safeBack = (s: string): string => (s === HOME || s.startsWith(`${HOME}?`) ? s : HOME);

links.post('/bulk', async (c) => {
  writer(c);
  const f = await readForm(c);
  const back = safeBack(text(f, 'back'));
  const ids = many(f, 'ids');
  if (!ids.length) return flashAndGo(c, 'info', 'Select at least one link first.', back);
  const action = text(f, 'action');
  const ctx = ctxOf(c);
  if (action === 'export') {
    let out = csvRow(['code', 'short_url', 'destination', 'title', 'tags', 'clicks', 'status', 'created']);
    for (const id of ids.slice(0, 200)) {
      const l = await getLink(ctx, id).catch(() => null);
      if (l) out += csvRow([l.code, l.shortUrl, l.url, l.title, l.tags.join(' '), l.clicks, l.state, l.createdAt]);
    }
    return csvResponse('links-selected.csv', out);
  }
  try {
    const r = await bulkAction(ctx, { ids: ids.slice(0, 200), action, tag: text(f, 'tag') || undefined });
    await auditFromRequest(c, { action: `links.link.bulk_${action}`, targetType: 'link', summary: `${action} on ${r.done} links`, meta: { done: r.done } });
    const verb: Record<string, string> = { archive: 'Archived', restore: 'Restored', delete: 'Deleted', tag: 'Tagged' };
    return flashAndGo(c, 'ok', `${verb[action] ?? 'Updated'} ${r.done} ${r.done === 1 ? 'link' : 'links'}.`, back);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, back);
  }
});

// One-click actions from the list menu ----------------------------------------------------------

links.post('/:id/duplicate', async (c) => {
  writer(c);
  const copy = await duplicateLink(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.link.created', targetType: 'link', targetId: copy.id, summary: `Duplicated to /${copy.code}`, meta: { code: copy.code } });
  return flashAndGo(c, 'ok', `Duplicated. The copy is /${copy.code}.`, `${HOME}/${copy.id}`);
});

for (const action of ['archive', 'restore'] as const) {
  links.post(`/:id/${action}`, async (c) => {
    writer(c);
    const l = await setArchived(ctxOf(c), c.req.param('id'), action === 'archive');
    await auditFromRequest(c, { action: `links.link.${action === 'archive' ? 'archived' : 'restored'}`, targetType: 'link', targetId: l.id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} /${l.code}`, meta: { code: l.code } });
    return flashAndGo(c, 'ok', `${action === 'archive' ? 'Archived' : 'Restored'} /${l.code}.`, HOME);
  });
}
