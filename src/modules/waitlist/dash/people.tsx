/** Signups: the list with filters and bulk actions, and one person's detail page. */
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import {
  Button, Callout, Card, ConfirmButton, EmptyState, Field, FilterBar, Input, KeyValueList, LinkButton, PageHeader, Pagination, Pill, SearchInput, Select, Table, setFlash,
} from '../../../ui';
import { formatDateTime, formatNumber, timeAgo } from '../../../ui/format';
import { parseJson } from '../../../core/db';
import { errors } from '../../../core/errors';
import { referralLink } from '../emails';
import { moveTo, positionOf } from '../queue';
import { bulk, cleanTag, erase, removeOne, reviewCount, type BulkAction } from '../review';
import { listSignups, parseSegment, SORTS, type SortKey } from '../segments';
import { FRAUD_REASONS, type FraudReason } from '../rules';
import { SIGNUP_STATUSES, type Signup, type SignupStatus, type Waitlist } from '../types';
import { questionsOf } from '../waitlists';
import { audit, attempt, EmailNotice, formOf, ids, ListNav, pickList, ROOT, scopeOf, str, to, write, type C, renderPage } from './common';

export const people = new Hono<AppEnv>();

const PAGE = 25;
const TONE: Record<SignupStatus, 'good' | 'neutral' | 'warn' | 'bad'> = { active: 'good', pending: 'warn', flagged: 'bad', invited: 'neutral', accepted: 'good', removed: 'neutral' };
const SORT_LABEL: Record<SortKey, string> = { position: 'Place in line', newest: 'Newest first', oldest: 'Oldest first', referrals: 'Most referrals' };
const BULK_DONE: Record<string, string> = {
  approve: 'Approved', reject: 'Rejected', remove: 'Removed', tag: 'Tagged', untag: 'Untagged', unsubscribe: 'Unsubscribed',
};

export function reasonText(code: string | null): string {
  return code ? (FRAUD_REASONS[code as FraudReason] ?? 'Held for review.') : '';
}

export const personName = (s: Pick<Signup, 'name' | 'email'>) => s.name || s.email;

function StatusPill({ s }: { s: Signup }) {
  return <Pill tone={TONE[s.status]}>{s.status === 'flagged' ? 'held' : s.status}</Pill>;
}

people.get('/people', async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const q = c.req.query();
  const segment = parseSegment({ ...q, status: q.status === undefined ? 'active' : q.status });
  const sort = (q.sort && q.sort in SORTS ? q.sort : 'position') as SortKey;
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const [{ rows, total }, held] = await Promise.all([listSignups(db, wl.id, { segment, sort, page, pageSize: PAGE }), reviewCount(db, wl.id)]);
  const ranked = sort === 'position' && segment.status === 'active';
  const hrefFor = (p: number) => to('people', wl, { q: q.q, status: q.status, sort: q.sort, tag: q.tag, page: p });
  const table = (
    <form method="post" action={to('people/bulk', wl)} data-no-busy>
      <Table
        caption="Signups"
        columns={[
          { key: 'pick', label: 'Select', srOnly: true },
          { key: 'place', label: 'Place', numeric: true },
          { key: 'who', label: 'Person' },
          { key: 'status', label: 'Status' },
          { key: 'refs', label: 'Referrals', numeric: true, hideOnMobile: true },
          { key: 'source', label: 'Source', hideOnMobile: true },
          { key: 'when', label: 'Joined', hideOnMobile: true },
        ]}
        rows={rows.map((s, i) => ({
          pick: <input type="checkbox" name="ids" value={s.id} aria-label={`Select ${personName(s)}`} />,
          place: ranked ? formatNumber((page - 1) * PAGE + i + 1 + wl.head_start) : 'None',
          who: <a class="wl-person" href={to(`people/${s.id}`, wl)}><strong>{personName(s)}</strong>{s.name ? <span>{s.email}</span> : null}</a>,
          status: <><StatusPill s={s} />{s.email_verified ? null : <Pill>unconfirmed</Pill>}</>,
          refs: formatNumber(s.referral_count),
          source: s.referred_by ? 'referral' : s.source || 'direct',
          when: timeAgo(s.created_at),
        }))}
      />
      <div class="wl-bulk" role="group" aria-label="Actions for selected people">
        <span>With selected</span>
        <Button type="submit" name="action" value="approve" size="sm">Approve</Button>
        <Button type="submit" name="action" value="reject" size="sm">Reject</Button>
        <Button type="submit" name="action" value="unsubscribe" size="sm">Unsubscribe</Button>
        <Input name="tag" placeholder="tag" aria-label="Tag name" maxlength={30} class="wl-tag-in" />
        <Button type="submit" name="action" value="tag" size="sm">Add tag</Button>
        <Button type="submit" name="action" value="untag" size="sm">Remove tag</Button>
        <ConfirmButton id="bulk-remove" size="sm" title="Remove the selected people?" body="They leave the list and their referral credit is taken back. You can still find them under Removed." confirmLabel="Remove" name="action" value="remove">Remove</ConfirmButton>
      </div>
    </form>
  );
  return renderPage(c, { title: `${wl.name} signups`, crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name }] }, (
    <>
      <PageHeader title={wl.name} description={`${formatNumber(total)} ${total === 1 ? 'person' : 'people'} match.`} actions={<LinkButton href={`/api/v1/waitlist/waitlists/${wl.id}/export.csv`} icon="download">Export CSV</LinkButton>} />
      {ListNav({ lists, wl, active: 'people', counts: { review: held } })}
      {await EmailNotice({ c })}
      <FilterBar action={`${ROOT}/people`}>
        <input type="hidden" name="w" value={wl.id} />
        <SearchInput name="q" value={q.q ?? ''} placeholder="Search name or email" />
        <Select name="status" aria-label="Status" value={q.status === undefined ? 'active' : q.status} options={[{ value: '', label: 'Everyone' }, ...SIGNUP_STATUSES.map((s) => ({ value: s, label: s === 'active' ? 'In line' : s[0]!.toUpperCase() + s.slice(1) }))]} />
        <Select name="sort" aria-label="Sort" value={sort} options={(Object.keys(SORTS) as SortKey[]).map((k) => ({ value: k, label: SORT_LABEL[k] }))} />
        <Input name="tag" value={q.tag ?? ''} placeholder="tag" aria-label="Tag" />
      </FilterBar>
      <Card flush>
        {rows.length ? table : (
          <EmptyState
            icon="users"
            title={Object.keys(q).some((k) => k !== 'w') ? 'No one matches these filters' : 'No signups yet'}
            body={Object.keys(q).some((k) => k !== 'w') ? 'Clear a filter to see more people.' : 'Share the page, or add people by importing a file.'}
            actions={<LinkButton href={`/w/${wl.slug}`}>Open the signup page</LinkButton>}
          />
        )}
      </Card>
      <Pagination page={page} pageSize={PAGE} total={total} href={hrefFor} noun={['person', 'people']} />
    </>
  ));
});

people.post('/people/bulk', write, async (c) => {
  const { db, base } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const f = await formOf(c);
  const picked = ids(f.ids);
  const action = str(f.action);
  const back = str(f.back) || to('people', wl);
  return attempt(c, back, null, async () => {
    if (!(action in BULK_DONE)) throw errors.validation_failed('Choose an action.');
    if (!picked.length) throw errors.validation_failed(undefined, { ids: 'Select at least one person first.' });
    const tag = cleanTag(f.tag);
    if ((action === 'tag' || action === 'untag') && !tag) throw errors.validation_failed(undefined, { tag: 'Type a tag first.' });
    const res = await bulk(c.env, wl, action as BulkAction, picked, { tag, base });
    await audit(c, `waitlist.signups.${action}`, wl, `${action} on ${picked.length} people`);
    const later = res.queued ? ` ${formatNumber(res.queued)} more are finishing in the background.` : '';
    setFlash(c, { kind: 'ok', message: `${BULK_DONE[action]} ${formatNumber(res.done)} ${res.done === 1 ? 'person' : 'people'}.${later}` });
  });
});

function Detail({ wl, s, position, referrer, base }: { wl: Waitlist; s: Signup; position: number | null; referrer: Signup | null; base: string }) {
  const answers = parseJson<Record<string, string>>(s.answers, {});
  const qs = questionsOf(wl);
  return (
    <>
      <Card title="Details">
        <KeyValueList
          items={[
            { label: 'Email', value: <>{s.email} {s.email_verified ? <Pill tone="good">confirmed</Pill> : <Pill tone="warn">unconfirmed</Pill>}</> },
            { label: 'Status', value: <StatusPill s={s} /> },
            { label: 'Place in line', value: position === null ? 'Not in line' : formatNumber(position) },
            { label: 'Joined', value: formatDateTime(s.created_at) },
            { label: 'Source', value: [s.source, s.medium, s.campaign].filter(Boolean).join(' / ') || 'Direct' },
            { label: 'Referral link', value: <code>{referralLink(base, wl, s)}</code> },
            { label: 'Referrals', value: `${formatNumber(s.referral_count)} confirmed` },
            { label: 'Referred by', value: referrer ? <a href={to(`people/${referrer.id}`, wl)}>{personName(referrer)}</a> : 'No one' },
            { label: 'Tags', value: s.tags.split(',').filter(Boolean).join(', ') || 'None' },
            { label: 'Emails', value: s.unsubscribed_at ? `Unsubscribed ${timeAgo(s.unsubscribed_at)}` : 'Subscribed' },
            ...(s.invite_code ? [{ label: 'Invite', value: `Sent ${s.invited_at ? timeAgo(s.invited_at) : ''}${s.accepted_at ? `, accepted ${timeAgo(s.accepted_at)}` : ', not accepted yet'}` }] : []),
          ]}
        />
      </Card>
      {s.flag_reason ? (
        <Callout tone="warn" title="Held for review">{reasonText(s.flag_reason)}{s.flag_detail ? ` ${s.flag_detail}` : ''}</Callout>
      ) : null}
      {qs.length ? (
        <Card title="Answers">
          <KeyValueList items={qs.map((q) => ({ label: q.label, value: answers[q.id] || 'No answer' }))} />
        </Card>
      ) : null}
    </>
  );
}

async function loadPerson(c: C): Promise<{ wl: Waitlist; lists: Waitlist[]; s: Signup } | null> {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  const s = wl ? await db.get<Signup>('wl_signups', c.req.param('sid') ?? '') : null;
  return wl && s && s.waitlist_id === wl.id ? { wl, lists, s } : null;
}

people.get('/people/:sid', async (c) => {
  const found = await loadPerson(c);
  if (!found) return c.redirect(ROOT, 303);
  const { wl, lists, s } = found;
  const { db, base } = scopeOf(c);
  const [position, referrer] = await Promise.all([positionOf(db, wl, s), s.referred_by ? db.get<Signup>('wl_signups', s.referred_by) : Promise.resolve(null)]);
  const back = to('people', wl);
  return renderPage(c, { title: personName(s), crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name, href: back }, { label: personName(s) }] }, (
    <>
      <PageHeader title={personName(s)} description={s.email} actions={<LinkButton href={back} icon="left">All signups</LinkButton>} />
      {ListNav({ lists, wl, active: 'people' })}
      <div class="wl-detail">
        <div>
          <Detail wl={wl} s={s} position={position} referrer={referrer} base={base} />
        </div>
        <div class="stack">
          <Card title="Change">
            <form method="post" action={to(`people/${s.id}`, wl)} class="wl-form-stack">
              <Field id="p-name" label="Name" optional><Input id="p-name" name="name" value={s.name} maxlength={100} /></Field>
              {position !== null ? <Field id="p-place" label="Move to place" optional hint="Changes only this person. Everyone else keeps their order."><Input id="p-place" name="position" type="number" min={1} placeholder={String(position)} /></Field> : null}
              <Button type="submit" variant="primary">Save</Button>
            </form>
          </Card>
          <Card title="Remove">
            <p class="wl-note">Removing takes the person out of line and takes back any credit they gave. Erasing deletes their data and keeps an anonymous count.</p>
            <form method="post" action={to(`people/${s.id}/remove`, wl)} class="wl-actions">
              <ConfirmButton id="p-remove" title="Remove this person?" body="They leave the list and their referral credit is taken back." confirmLabel="Remove" variant="default" danger>Remove</ConfirmButton>
              <ConfirmButton id="p-erase" title="Erase this person?" body="Their email, name and answers are deleted for good. The waitlist keeps an anonymous count." confirmLabel="Erase" formAction={to(`people/${s.id}/erase`, wl)}>Erase data</ConfirmButton>
            </form>
          </Card>
        </div>
      </div>
    </>
  ));
});

people.post('/people/:sid', write, async (c) => {
  const found = await loadPerson(c);
  if (!found) return c.redirect(ROOT, 303);
  const { wl, s } = found;
  const { db } = scopeOf(c);
  const f = await formOf(c);
  return attempt(c, to(`people/${s.id}`, wl), 'Saved.', async () => {
    await db.update('wl_signups', s.id, { name: str(f.name).trim().slice(0, 100) });
    const place = Number(str(f.position));
    if (str(f.position) && Number.isFinite(place) && place >= 1) await moveTo(db, wl, s, place);
    await audit(c, 'waitlist.signup.updated', wl, `Changed ${s.email}`);
  });
});

people.post('/people/:sid/remove', write, async (c) => {
  const found = await loadPerson(c);
  if (!found) return c.redirect(ROOT, 303);
  const { wl, s } = found;
  const { db } = scopeOf(c);
  return attempt(c, to('people', wl), 'Removed.', async () => {
    await removeOne(c.env, db, wl, s, Date.now());
    await audit(c, 'waitlist.signup.removed', wl, `Removed ${s.email}`);
  });
});

people.post('/people/:sid/erase', write, async (c) => {
  const found = await loadPerson(c);
  if (!found) return c.redirect(ROOT, 303);
  const { wl, s } = found;
  return attempt(c, to('people', wl), 'Erased. The waitlist keeps an anonymous count.', async () => {
    await erase(c.env, wl, s);
    await audit(c, 'waitlist.signup.erased', wl, 'Erased one person');
  });
});
