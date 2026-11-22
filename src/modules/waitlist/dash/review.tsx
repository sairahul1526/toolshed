/** The review queue: people and referrals the fraud rules held back, with the reason, approved or rejected in bulk. */
import { Hono } from 'hono';
import { errors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, EmptyState, PageHeader, Pill, Table, setFlash } from '../../../ui';
import { formatNumber, plural, timeAgo } from '../../../ui/format';
import { bulk, reviewQueue } from '../review';
import { audit, attempt, EmailNotice, formOf, ids, ListNav, pickList, ROOT, scopeOf, to, write, renderPage } from './common';
import { personName, reasonText } from './people';

export const review = new Hono<AppEnv>();

review.get('/review', async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const queue = await reviewQueue(db, wl.id);
  return renderPage(c, { title: `${wl.name} review`, crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name }] }, (
    <>
      <PageHeader title={wl.name} description="Signups and referrals the abuse rules held back. Nothing here is lost: approve to let them in, or reject to turn them away." />
      {ListNav({ lists, wl, active: 'review', counts: { review: queue.length } })}
      {await EmailNotice({ c })}
      <Card flush>
        {queue.length ? (
          <form method="post" action={to('review', wl)} data-no-busy>
            {queue.map((s) => <input type="hidden" name="shown" value={s.id} />)}
            <Table
              caption="Held for review"
              columns={[
                { key: 'pick', label: 'Select', srOnly: true },
                { key: 'who', label: 'Person' },
                { key: 'what', label: 'Held' },
                { key: 'why', label: 'Why' },
                { key: 'when', label: 'When', hideOnMobile: true },
              ]}
              rows={queue.map((s) => ({
                pick: <input type="checkbox" name="ids" value={s.id} aria-label={`Select ${personName(s)}`} />,
                who: <a class="wl-person" href={to(`people/${s.id}`, wl)}><strong>{personName(s)}</strong>{s.name ? <span>{s.email}</span> : null}</a>,
                what: <Pill tone="bad">{s.status === 'flagged' ? 'Signup' : 'Referral credit'}</Pill>,
                why: reasonText(s.flag_reason) || 'Held by the abuse rules.',
                when: s.flagged_at ? timeAgo(s.flagged_at) : 'Unknown',
              }))}
            />
            <div class="wl-bulk" role="group" aria-label="Review actions">
              <Button type="submit" name="action" value="approve" variant="primary" size="sm">Approve selected</Button>
              <Button type="submit" name="action" value="reject" size="sm">Reject selected</Button>
              <Button type="submit" name="scope" value="all" size="sm">Approve all {formatNumber(queue.length)} shown</Button>
            </div>
          </form>
        ) : (
          <EmptyState icon="check" title="Nothing to review" body="Held signups appear here with the reason. Change how strict the rules are in the page settings." />
        )}
      </Card>
      {queue.length >= 200 ? <Callout tone="info">Showing the first 200. Approve or reject these to see more.</Callout> : null}
    </>
  ));
});

review.post('/review', write, async (c) => {
  const { db, base } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const f = await formOf(c);
  const everyone = f.scope === 'all';
  const picked = ids(everyone ? f.shown : f.ids);
  const action = everyone ? 'approve' : f.action === 'reject' ? 'reject' : 'approve';
  return attempt(c, to('review', wl), null, async () => {
    if (!picked.length) throw errors.validation_failed(undefined, { ids: 'Select at least one person first.' });
    const res = await bulk(c.env, wl, action, picked, { base });
    await audit(c, `waitlist.signups.${action}`, wl, `${action} on ${picked.length} held signups`);
    const later = res.queued ? ` ${formatNumber(res.queued)} more are finishing in the background.` : '';
    setFlash(c, { kind: 'ok', message: `${action === 'approve' ? 'Approved' : 'Rejected'} ${plural(res.done, 'person', 'people')}.${later}` });
  });
});
