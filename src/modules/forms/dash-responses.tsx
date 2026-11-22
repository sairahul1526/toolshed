/** Responses: the list with search, filters, columns and bulk actions, and the detail view with notes. */
import { Hono } from 'hono';
import { orgDb } from '../../core/db';
import { AppError } from '../../core/errors';
import type { AppEnv } from '../../env';
import { Button, Callout, Card, ConfirmButton, EmptyState, FilterBar, KeyValueList, PageHeader, Pagination, Pill, SearchInput, Table, Tabs, Textarea, formatDateTime, formatNumber, renderPage, timeAgo } from '../../ui';
import { BASE, CSS, FormTabs, act, body, crumbs, list, safeBack, str, type C } from './dash-common';
import { actorOf, ctxOf, intParam } from './http';
import { displayValue } from './logic';
import { DISPLAY_TYPES, allFields, type Definition, type Field } from './schema';
import { getDraft, getForm, getPublished } from './service';
import { addNote, definitionFor, deleteNote, deleteSubmissions, folderCounts, getSubmission, listSubmissions, markRead, setSpam, setStarred, type ListQuery, type Submission } from './submissions';

export const responseRoutes = new Hono<AppEnv>();
const PAGE = 25;
const questions = (def: Definition): Field[] => allFields(def).filter((f) => !DISPLAY_TYPES.includes(f.type));

function queryFrom(c: C): { q: ListQuery; keep: Record<string, string> } {
  const get = (k: string) => str(c.req.query(k));
  const status = get('status');
  const st = status === 'partial' || status === 'spam' ? status : 'complete';
  const keep: Record<string, string> = {};
  const q: ListQuery = { status: st };
  for (const k of ['q', 'from', 'to', 'starred', 'unread', 'field', 'value']) if (get(k)) keep[k] = get(k);
  if (keep.q) q.q = keep.q;
  if (keep.from && Number.isFinite(Date.parse(keep.from))) q.from = Date.parse(keep.from);
  // The end date is a day, so include all of it.
  if (keep.to && Number.isFinite(Date.parse(keep.to))) q.to = Date.parse(keep.to) + 86_399_999;
  if (keep.starred === '1') q.starred = true;
  if (keep.unread === '1') q.unread = true;
  if (keep.field && keep.value !== undefined) {
    q.field = keep.field;
    q.value = keep.value;
  }
  if (st !== 'complete') keep.status = st;
  return { q, keep };
}

responseRoutes.get('/:id/responses', async (c: C) => {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, c.req.param('id') ?? '');
  const def = (await getPublished(db, form)) ?? (await getDraft(db, form));
  const qs = questions(def);
  const { q, keep } = queryFrom(c);
  const page = intParam(c.req.query('page'), 1, 1, 100_000);
  const chosen = list(c.req.queries('col')).filter((id) => qs.some((f) => f.id === id));
  const cols = chosen.length ? qs.filter((f) => chosen.includes(f.id)) : qs.slice(0, 3);
  const [{ items, total }, counts] = await Promise.all([listSubmissions(db, form.id, { ...q, limit: PAGE, offset: (page - 1) * PAGE }), folderCounts(db, form.id)]);
  const here = (extra: Record<string, string> = {}, drop: string[] = []) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...extra })) if (!drop.includes(k) && v) p.set(k, v);
    for (const id of chosen) p.append('col', id);
    const s = p.toString();
    return `${BASE}/${form.id}/responses${s ? `?${s}` : ''}`;
  };
  const filtered = Boolean(keep.q || keep.from || keep.to || keep.starred || keep.unread || keep.field);
  const status = q.status ?? 'complete';
  const label = (s: Submission) => (s.email ? s.email : formatDateTime(s.createdAt));
  const rows = items.map((s) => ({
    pick: <input class="fm-check" type="checkbox" name="ids" value={s.id} aria-label={`Select the response from ${label(s)}`} />,
    when: (
      <a href={`${BASE}/${form.id}/responses/${s.id}`}>
        {s.read ? '' : <Pill tone="solid">New</Pill>} {s.starred ? '* ' : ''}
        {timeAgo(s.createdAt)}
      </a>
    ),
    ...Object.fromEntries(cols.map((f) => [`c_${f.id}`, <span class="fm-clip">{displayValue(f, s.answers[f.id] as never) || '-'}</span>])),
    score: s.score === null ? '' : String(s.score),
  }));
  const hasScore = items.some((s) => s.score !== null);
  const backHere = here();

  return renderPage(
    c,
    { title: `Responses to ${form.name}`, crumbs: crumbs(form, 'Responses') },
    <>
      {CSS}
      <PageHeader title={form.name} description={`${formatNumber(form.responseCount)} ${form.responseCount === 1 ? 'response' : 'responses'}`} />
      <FormTabs form={form} active="responses" />
      <Tabs
        label="Response folders"
        active={status}
        items={[
          { id: 'complete', label: 'Responses', count: counts.complete, href: here({}, ['status', 'page']) },
          ...(counts.partial > 0 || form.settings.privacy.partial ? [{ id: 'partial', label: 'Partial', count: counts.partial, href: here({ status: 'partial' }, ['page']) }] : []),
          { id: 'spam', label: 'Spam', count: counts.spam, href: here({ status: 'spam' }, ['page']) },
        ]}
      />
      {status === 'partial' ? <Callout tone="info" title="Partial responses">These are answers saved from people who did not finish. This is off by default, and the form tells people when it is on.</Callout> : null}
      <FilterBar action={`${BASE}/${form.id}/responses`}>
        {status !== 'complete' ? <input type="hidden" name="status" value={status} /> : null}
        <SearchInput name="q" label="Search responses" placeholder="Search answers and emails" value={keep.q ?? ''} />
        <label class="sr-only" for="fm-from">From date</label>
        <input id="fm-from" class="input" type="date" name="from" value={keep.from ?? ''} />
        <label class="sr-only" for="fm-to">To date</label>
        <input id="fm-to" class="input" type="date" name="to" value={keep.to ?? ''} />
        <details class="fm-cols">
          <summary class="btn sm">Columns</summary>
          <div class="fm-colbox">
            {qs.map((f) => (
              <label class="fb-check">
                <input type="checkbox" name="col" value={f.id} checked={cols.some((x) => x.id === f.id)} /> {f.label || f.key}
              </label>
            ))}
          </div>
        </details>
      </FilterBar>
      <p class="fm-actions">
        <a class="btn sm" href={here({ unread: keep.unread ? '' : '1' })}>{keep.unread ? 'Show all' : 'Unread only'}</a>
        <a class="btn sm" href={here({ starred: keep.starred ? '' : '1' })}>{keep.starred ? 'Show all' : 'Starred only'}</a>
        {filtered ? <a class="btn sm ghost" href={here({}, ['q', 'from', 'to', 'starred', 'unread', 'field', 'value', 'page'])}>Clear filters</a> : null}
        <a class="btn sm" href={`/api/v1/forms/${form.id}/submissions/export.csv?${new URLSearchParams({ status, ...(keep.q ? { q: keep.q } : {}) })}`}>Export these as CSV</a>
      </p>
      <form method="post" action={`${BASE}/${form.id}/responses/bulk`}>
        <input type="hidden" name="back" value={backHere} />
        <div class="fm-bulk" role="group" aria-label="Actions for selected responses">
          <label class="fb-check">
            <input type="checkbox" class="fm-check" data-select-all aria-label="Select every response on this page" /> Select all
          </label>
          {status === 'spam' ? (
            <Button size="sm" type="submit" name="action" value="not_spam">Not spam</Button>
          ) : (
            <Button size="sm" type="submit" name="action" value="spam">Mark as spam</Button>
          )}
          <Button size="sm" type="submit" name="action" value="star">Star</Button>
          <Button size="sm" type="submit" name="action" value="read">Mark read</Button>
          <ConfirmButton size="sm" title="Delete the selected responses?" body="They and their uploaded files are removed for good. This cannot be undone." confirmLabel="Delete" name="action" value="delete" id="fm-bulk-del">
            Delete
          </ConfirmButton>
        </div>
        <Card flush>
          <Table
            caption="Responses"
            columns={[
              { key: 'pick', label: 'Select', srOnly: true },
              { key: 'when', label: 'Received' },
              ...cols.map((f, i) => ({ key: `c_${f.id}`, label: f.label || f.key, hideOnMobile: i > 0 })),
              ...(hasScore ? [{ key: 'score', label: 'Score', numeric: true }] : []),
            ]}
            rows={rows}
            empty={
              <EmptyState
                bare
                icon="mail"
                title={filtered ? 'No responses match' : status === 'spam' ? 'No spam' : status === 'partial' ? 'No partial responses' : 'No responses yet'}
                body={filtered ? 'Try a different search or clear the filters.' : status === 'complete' ? 'Share the form and they will show up here.' : 'Nothing here.'}
                actions={!filtered && status === 'complete' ? <a class="btn primary" href={`${BASE}/${form.id}/share`}>Share the form</a> : undefined}
              />
            }
          />
        </Card>
      </form>
      <Pagination page={page} pageSize={PAGE} total={total} href={(p) => here({ page: String(p) })} noun={['response', 'responses']} />
    </>,
  );
});

responseRoutes.post('/:id/responses/bulk', async (c: C) => {
  const b = await body(c);
  const id = c.req.param('id') ?? '';
  const ids = list(b.ids);
  const back = safeBack(b.back, `${BASE}/${id}/responses`);
  if (ids.length === 0) return act(c, back, async () => { throw new AppError('forms.nothing_selected', 400, 'Select at least one response first.'); });
  return act(c, back, async () => {
    const ctx = ctxOf(c);
    const action = str(b.action);
    const n =
      action === 'spam' ? await setSpam(ctx, id, ids, true)
      : action === 'not_spam' ? await setSpam(ctx, id, ids, false)
      : action === 'delete' ? await deleteSubmissions(ctx, id, ids)
      : action === 'star' ? await setStarred(ctx.db, id, ids, true)
      : await markRead(ctx.db, id, ids, true);
    const word = n === 1 ? 'response' : 'responses';
    return action === 'delete' ? `Deleted ${n} ${word}.` : action === 'spam' ? `Moved ${n} ${word} to spam.` : action === 'not_spam' ? `Moved ${n} ${word} back.` : `Updated ${n} ${word}.`;
  });
});

responseRoutes.get('/:id/responses/:sid', async (c: C) => {
  const db = orgDb(c.env.DB, c.get('org')!.id);
  const form = await getForm(db, c.req.param('id') ?? '');
  const { submission: s, notes, files } = await getSubmission(db, form.id, c.req.param('sid') ?? '');
  const def = await definitionFor(db, s.versionId);
  if (!s.read) await markRead(db, form.id, [s.id], true);
  const back = `${BASE}/${form.id}/responses${s.status === 'complete' ? '' : `?status=${s.status}`}`;
  const me = `${BASE}/${form.id}/responses/${s.id}`;
  const shown = questions(def).filter((f) => s.answers[f.id] !== undefined);
  return renderPage(
    c,
    { title: 'Response', crumbs: [...crumbs(form, 'Responses'), { label: 'Response' }] },
    <>
      {CSS}
      <PageHeader
        title={s.email ?? 'Response'}
        soft={formatDateTime(s.createdAt)}
        actions={<a class="btn" href={back}>Back to responses</a>}
      />
      <div class="fm-grid2">
        <Card title="Answers">
          {shown.length === 0 ? (
            <EmptyState bare icon="clipboard" title="No answers" body="This response has no answers." />
          ) : (
            <dl class="fm-answers">
              {shown.map((f) => (
                <div>
                  <dt>{f.label || f.key}</dt>
                  <dd>{displayValue(f, s.answers[f.id] as never) || '-'}</dd>
                </div>
              ))}
            </dl>
          )}
          {files.length ? (
            <>
              <h3>Files</h3>
              <ul>
                {files.map((f) => (
                  <li>
                    <a href={`/api/v1/forms/${form.id}/files/${f.id}`}>{f.name}</a> <span class="fm-muted">{formatNumber(Math.round(f.size / 1024))} KB</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
        <div class="fm-stack">
          <Card title="Details">
            <KeyValueList
              items={[
                { label: 'Status', value: s.status === 'complete' ? 'Complete' : s.status === 'partial' ? 'Partial' : 'Spam' },
                { label: 'Received', value: formatDateTime(s.createdAt) },
                ...(s.score !== null ? [{ label: 'Score', value: String(s.score) }] : []),
                ...Object.entries(s.calcs).map(([id, v]) => ({ label: def.calcs.find((x) => x.id === id)?.name ?? id, value: String(v) })),
                ...(s.durationMs ? [{ label: 'Time taken', value: `${Math.max(1, Math.round(s.durationMs / 1000))} seconds` }] : []),
                ...Object.entries(s.meta).map(([k, v]) => ({ label: k, value: v })),
              ]}
            />
            <form method="post" action={`${me}/act`} class="fm-actions">
              <input type="hidden" name="back" value={back} />
              <Button size="sm" type="submit" name="action" value={s.starred ? 'unstar' : 'star'}>{s.starred ? 'Remove star' : 'Star'}</Button>
              {s.status === 'spam' ? <Button size="sm" type="submit" name="action" value="not_spam">Not spam</Button> : <Button size="sm" type="submit" name="action" value="spam">Mark as spam</Button>}
              <ConfirmButton size="sm" title="Delete this response?" body="It and its uploaded files are removed for good." confirmLabel="Delete" name="action" value="delete" id="fm-del-one">Delete</ConfirmButton>
            </form>
          </Card>
          <Card title="Notes" description="Only your team sees these.">
            {notes.map((n) => (
              <div class="fm-note">
                <p>{n.body}</p>
                <span class="fm-muted">{n.authorLabel}, {timeAgo(n.createdAt)}</span>
                <form method="post" action={`${me}/notes/${n.id}/delete`}>
                  <Button size="sm" variant="ghost" type="submit">Delete note</Button>
                </form>
              </div>
            ))}
            <form method="post" action={`${me}/notes`} class="fm-stack">
              <Textarea id="fm-note" name="body" rows={3} maxlength={4000} required aria-label="Add a note" placeholder="Add a note" />
              <div><Button type="submit" variant="primary" size="sm">Save note</Button></div>
            </form>
          </Card>
        </div>
      </div>
    </>,
  );
});

responseRoutes.post('/:id/responses/:sid/act', async (c: C) => {
  const b = await body(c);
  const id = c.req.param('id') ?? '';
  const sid = c.req.param('sid') ?? '';
  const back = safeBack(b.back, `${BASE}/${id}/responses`);
  const action = str(b.action);
  const ctx = ctxOf(c);
  return act(c, action === 'delete' || action === 'spam' || action === 'not_spam' ? back : `${BASE}/${id}/responses/${sid}`, async () => {
    if (action === 'delete') { await deleteSubmissions(ctx, id, [sid]); return 'Response deleted.'; }
    if (action === 'spam') { await setSpam(ctx, id, [sid], true); return 'Moved to spam.'; }
    if (action === 'not_spam') { await setSpam(ctx, id, [sid], false); return 'Moved back to responses.'; }
    await setStarred(ctx.db, id, [sid], action === 'star');
    return action === 'star' ? 'Starred.' : 'Star removed.';
  });
});

responseRoutes.post('/:id/responses/:sid/notes', async (c: C) => {
  const b = await body(c);
  const id = c.req.param('id') ?? '';
  const sid = c.req.param('sid') ?? '';
  return act(c, `${BASE}/${id}/responses/${sid}`, async () => {
    const text = str(b.body);
    if (!text) throw new AppError('forms.empty_note', 400, 'Write something before saving the note.');
    await addNote(ctxOf(c).db, id, sid, text, actorOf(c));
    return 'Note saved.';
  });
});

responseRoutes.post('/:id/responses/:sid/notes/:nid/delete', (c: C) =>
  act(c, `${BASE}/${c.req.param('id')}/responses/${c.req.param('sid')}`, async () => {
    await deleteNote(ctxOf(c).db, c.req.param('sid') ?? '', c.req.param('nid') ?? '');
    return 'Note deleted.';
  }),
);
