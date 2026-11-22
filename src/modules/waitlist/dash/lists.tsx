/** The waitlists screen: every list with its numbers, the first-run start and creating or removing a list. */
import { Hono } from 'hono';
import { formatNumber, plural } from '../../../ui/format';
import { Button, Card, EmptyState, Field, Input, LinkButton, PageHeader, Pill, Table } from '../../../ui';
import type { AppEnv } from '../../../env';
import { countsByWaitlist, createWaitlist, deleteWaitlist, emptyCounts, getWaitlist, listWaitlists } from '../waitlists';
import { addSampleWaitlist } from '../sample';
import { audit, attempt, EmailNotice, formOf, ROOT, scopeOf, str, to, write, renderPage } from './common';
import type { WaitlistStatus } from '../types';

export const lists = new Hono<AppEnv>();

const TONE: Record<WaitlistStatus, 'good' | 'neutral' | 'warn'> = { live: 'good', draft: 'neutral', paused: 'warn', archived: 'neutral' };

function NewForm({ first }: { first: boolean }) {
  return (
    <form method="post" action={`${ROOT}/new`} class="wl-new">
      <Field id="new-name" label="Name of your waitlist" hint="People see this on the signup page. You can change it later.">
        <Input id="new-name" name="name" required maxlength={80} placeholder="Early access" autocomplete="off" />
      </Field>
      <Button type="submit" variant="primary" icon="plus">{first ? 'Create your first waitlist' : 'Create waitlist'}</Button>
    </form>
  );
}

lists.get('/', async (c) => {
  const { db } = scopeOf(c);
  const [all, counts] = await Promise.all([listWaitlists(db), countsByWaitlist(db)]);
  if (!all.length) {
    return renderPage(c, { title: 'Waitlist' }, (
      <>
        <PageHeader title="Waitlist" description="Collect signups before launch, let people move up by inviting friends, and let them in in waves." />
        {await EmailNotice({ c })}
        <Card>
          <EmptyState
            icon="users"
            title="No waitlists yet"
            body="Start with a real waitlist, or fill the workspace with 24 sample people to see how it works. Sample data can be removed in one click."
            actions={
              <form method="post" action={`${ROOT}/sample`}>
                <Button type="submit" icon="sparkles">Try it with sample data</Button>
              </form>
            }
          />
          <NewForm first />
        </Card>
      </>
    ));
  }
  const rows = all.map((wl) => {
    const n = counts.get(wl.id) ?? emptyCounts();
    return {
      name: <a href={to('people', wl)}><strong>{wl.name}</strong></a>,
      status: <Pill tone={TONE[wl.status]}>{wl.is_sample ? `${wl.status}, sample` : wl.status}</Pill>,
      people: formatNumber(n.total - n.removed),
      review: n.flagged ? <a href={to('review', wl)}>{formatNumber(n.flagged)} to review</a> : 'None',
      page: <a href={`/w/${wl.slug}`}>/w/{wl.slug}</a>,
    };
  });
  return renderPage(c, { title: 'Waitlist' }, (
    <>
      <PageHeader
        title="Waitlist"
        description={`${plural(all.length, 'waitlist', 'waitlists')} in this workspace.`}
        actions={<LinkButton href="#new" icon="plus" variant="primary">New waitlist</LinkButton>}
      />
      {await EmailNotice({ c })}
      <Card flush>
        <Table
          caption="Waitlists"
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status' },
            { key: 'people', label: 'People', numeric: true },
            { key: 'review', label: 'Held for review' },
            { key: 'page', label: 'Public page', hideOnMobile: true },
          ]}
          rows={rows}
        />
      </Card>
      <Card title="New waitlist" id="new"><NewForm first={false} /></Card>
    </>
  ));
});

lists.post('/new', write, async (c) => {
  const { db } = scopeOf(c);
  const name = str((await formOf(c)).name).trim();
  return attempt(c, ROOT, null, async () => {
    const wl = await createWaitlist(db, { name });
    await audit(c, 'waitlist.created', wl, `Created waitlist ${wl.name}`);
    return to('edit', wl, { created: 1 });
  });
});

lists.post('/sample', write, async (c) => {
  const { db } = scopeOf(c);
  const org = c.get('org')!;
  return attempt(c, ROOT, 'Added a sample waitlist with 24 people.', async () => {
    if ((await listWaitlists(db)).length) return;
    await addSampleWaitlist({ env: c.env, db, org });
  });
});

lists.post('/delete', write, async (c) => {
  const { db } = scopeOf(c);
  const wl = await getWaitlist(db, str((await formOf(c)).w));
  return attempt(c, ROOT, `Deleted ${wl.name}.`, async () => {
    await deleteWaitlist(db, wl.id);
    await audit(c, 'waitlist.deleted', wl, `Deleted waitlist ${wl.name}`);
    return ROOT;
  });
});

