/** What a person sets up for one site: goals, share links and settings. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import { parseJson } from '../../../core/db';
import { emailReady } from '../../../core/email';
import type { FieldErrors } from '../../../core/errors';
import { needRole } from '../../../core/guards';
import { baseUrl } from '../../../core/net';
import type { AppEnv } from '../../../env';
import {
  Button, Callout, Card, Checkbox, CodeBlock, ConfirmButton, CopyField, DangerZone, EmptyState, Field, Input, KeyValueList, LinkButton, PageHeader, Pill, Select, Table,
  Textarea, formatDate, formatNumber,
} from '../../../ui';
import { act, BASE, canWrite, formValues, isAdmin, page, plainError, SamplePill, siteCrumbs, siteHref, SiteTabs, type C, type Values } from '../dash-common';
import { ctxOf, freshSite } from '../http';
import { DROP_REASONS, flushDrops, forgetSites } from '../ingest';
import {
  createGoal, createShare, deleteGoal, deleteShare, deleteSite, domainNote, getSite, listGoals, listShares, MAX_GOALS, MAX_SHARES, RETENTION_CHOICES, updateSite, type Site,
} from '../sites';
import { health, report } from '../stats';
import { formatPercent, rangeQuery, RangeForm, readView } from '../view';
import { timeZoneOptions } from './sites';

export const manage = new Hono<AppEnv>();

const idOf = (c: C): string => c.req.param('id') ?? '';

// ---------------------------------------------------------------------------------------------
// Goals and events
// ---------------------------------------------------------------------------------------------

async function goalsScreen(c: C, values: Values = {}, errors: FieldErrors = {}, status?: 422): Promise<Response> {
  const ctx = ctxOf(c);
  const now = Date.now();
  const site = await freshSite(ctx, idOf(c), now);
  const view = { ...readView((key) => c.req.query(key), site, now), filters: {}, compare: false };
  const goals = await listGoals(ctx.db, site.id);
  const res = await report(ctx.db, site, view.range, {}, { dims: ['event'], limit: 50, goals });
  const write = canWrite(c);
  const here = siteHref(site, '/goals');
  const keep = rangeQuery(view);
  const events = res.panels.event ?? [];
  return page(c, `Goals, ${site.name}`, siteCrumbs(site, 'Goals and events'), (
    <>
      <PageHeader title={site.name} soft={domainNote(site)} actions={<SamplePill site={site} />} />
      <SiteTabs site={site} active="goals" keep={keep} />
      <RangeForm action={here} view={view} />
      <Card title="Goals" description="A goal counts the visitors who reach a page or send an event, and shows what share of all visitors they are." flush>
        <Table
          caption="Goals"
          empty={<EmptyState bare icon="flag" title="No goals yet" body={write ? 'Add one below, like visits to /thanks or the event Signup.' : 'A member of this workspace can add one.'} />}
          columns={[
            { key: 'name', label: 'Goal' },
            { key: 'counts', label: 'Counts', hideOnMobile: true },
            { key: 'visitors', label: 'Visitors', numeric: true },
            { key: 'total', label: 'Times', numeric: true, hideOnMobile: true },
            { key: 'rate', label: 'Conversion rate', numeric: true },
            ...(write ? [{ key: 'remove', label: 'Delete', srOnly: true }] : []),
          ]}
          rows={res.goals.map((g) => ({
            name: <a href={`${siteHref(site)}${keep ? `${keep}&` : '?'}goal=${g.goal.id}`}>{g.goal.name}</a>,
            counts: g.goal.kind === 'page' ? <span>Page <code>{g.goal.match}</code></span> : <span>Event <code>{g.goal.match}</code></span>,
            visitors: formatNumber(g.uniques),
            total: formatNumber(g.total),
            rate: formatPercent(g.rate),
            remove: (
              <form method="post" action={`${here}/${g.goal.id}/delete`}>
                <ConfirmButton id={`goal-${g.goal.id}`} title="Delete this goal?" body={`“${g.goal.name}” stops being counted as a goal. The page views and events behind it stay.`} confirmLabel="Delete goal" size="sm" variant="ghost" icon="trash">
                  Delete
                </ConfirmButton>
              </form>
            ),
          }))}
        />
      </Card>
      {write ? (
        <Card title="Add a goal" description={`Up to ${MAX_GOALS} per site. Goals count from the first day there is data, not from the day you add them.`} id="add-goal">
          <form method="post" action={here} class="stack an-form">
            <Field id="kind" label="What it counts" error={errors.kind}>
              <Select id="kind" name="kind" value={values.kind ?? 'event'} options={[{ value: 'event', label: 'An event' }, { value: 'page', label: 'A visit to a page' }]} invalid={!!errors.kind} />
            </Field>
            <Field id="match" label="Event name or page path" hint="An event name exactly as your site sends it, like Signup. Or a path, like /thanks. In a path, * stands for anything: /blog/*" error={errors.match}>
              <Input id="match" name="match" value={values.match ?? ''} required maxlength={200} autocomplete="off" autocapitalize="none" spellcheck={false} invalid={!!errors.match} />
            </Field>
            <Field id="name" label="Name" optional hint="How the goal is listed. Leave it empty to use the event name or path." error={errors.name}>
              <Input id="name" name="name" value={values.name ?? ''} maxlength={80} invalid={!!errors.name} />
            </Field>
            <div class="row">
              <Button type="submit" variant="primary">Add goal</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <Card title="Events" description="Everything your site sent in this range. Clicks on links to other sites, file downloads and 404 pages are sent for you." flush>
        <Table
          caption="Events"
          empty={<EmptyState bare icon="pulse" title="No events for these dates" body="Call toolshed('Signup') from your site to send one." actions={<LinkButton href={siteHref(site, '/setup')}>How to send events</LinkButton>} />}
          columns={[
            { key: 'name', label: 'Event' },
            { key: 'visitors', label: 'Visitors', numeric: true },
            { key: 'events', label: 'Events', numeric: true },
            { key: 'more', label: 'Properties', srOnly: true },
          ]}
          rows={events.map((r) => ({
            name: <span class="an-clip" title={r.value}>{r.value}</span>,
            visitors: formatNumber(r.visitors),
            events: formatNumber(r.events),
            more: <a href={`${siteHref(site)}/events/${encodeURIComponent(r.value)}${keep}`}>Properties</a>,
          }))}
        />
      </Card>
    </>
  ), status);
}

manage.get('/sites/:id/goals', (c: C) => goalsScreen(c));

manage.post('/sites/:id/goals', async (c: C) => {
  const values = await formValues(c);
  try {
    const goal = await createGoal(ctxOf(c), idOf(c), { kind: values.kind, match: values.match ?? '', name: values.name || undefined });
    await auditFromRequest(c, { action: 'goal.created', targetType: 'goal', targetId: goal.id, summary: `Added the goal ${goal.name}` });
  } catch (e) {
    const { message, fields } = plainError(e);
    return goalsScreen(c, values, Object.keys(fields).length ? fields : { match: message }, 422);
  }
  return act(c, siteHref({ id: idOf(c) }, '/goals'), async () => 'Goal added.');
});

manage.post('/sites/:id/goals/:goalId/delete', (c: C) =>
  act(c, siteHref({ id: idOf(c) }, '/goals'), async () => {
    const goalId = c.req.param('goalId') ?? '';
    await deleteGoal(ctxOf(c), idOf(c), goalId);
    await auditFromRequest(c, { action: 'goal.deleted', targetType: 'goal', targetId: goalId, summary: 'Deleted a goal' });
    return 'Goal deleted.';
  }),
);

// ---------------------------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------------------------

async function shareScreen(c: C, values: Values = {}, errors: FieldErrors = {}, status?: 422): Promise<Response> {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, idOf(c));
  const shares = await listShares(ctx.db, site.id);
  const write = canWrite(c);
  const here = siteHref(site, '/shares');
  const url = baseUrl(c);
  const now = Date.now();
  return page(c, `Share, ${site.name}`, siteCrumbs(site, 'Share'), (
    <>
      <PageHeader title={site.name} soft={domainNote(site)} actions={<SamplePill site={site} />} />
      <SiteTabs site={site} active="share" />
      {shares.length === 0 ? (
        <EmptyState icon="globe" title="No share links yet" body={write ? 'Make a link to show this site’s numbers to anyone, with or without a password. People who open it can look, not change.' : 'A member of this workspace can make one.'} />
      ) : (
        shares.map((s) => {
          const link = `${url}/a/share/${s.token}`;
          const expired = s.expires_at !== null && s.expires_at <= now;
          return (
            <Card
              title={s.name}
              actions={
                <>
                  {s.password_hash ? <Pill>Password</Pill> : <Pill tone="good">Anyone with the link</Pill>}
                  {expired ? <Pill tone="bad">Expired</Pill> : null}
                </>
              }
              description={s.expires_at === null ? `Made ${formatDate(s.created_at)}. Does not expire.` : `Made ${formatDate(s.created_at)}. ${expired ? 'Stopped' : 'Stops'} working ${formatDate(s.expires_at)}.`}
            >
              <div class="stack">
                <CopyField label="share link" value={link} secret={false} />
                {s.password_hash ? (
                  <p class="muted">A link with a password cannot be shown inside another page. Share the link itself.</p>
                ) : (
                  <details class="an-embed">
                    <summary>Put it on your own page</summary>
                    <CodeBlock code={`<iframe src="${link}/embed" title="${site.domain} visitors" loading="lazy" width="100%" height="900"></iframe>`} label="embed code" />
                    <p class="muted">Add <code>?theme=dark</code> or <code>?theme=light</code> to the address to match your page.</p>
                  </details>
                )}
                {write ? (
                  <form method="post" action={`${here}/${s.id}/delete`}>
                    <ConfirmButton id={`share-${s.id}`} title="Delete this share link?" body="The link stops working for everyone who has it, right away." confirmLabel="Delete link" size="sm" icon="trash">
                      Delete link
                    </ConfirmButton>
                  </form>
                ) : null}
              </div>
            </Card>
          );
        })
      )}
      {write ? (
        <Card title="Make a share link" description={`Up to ${MAX_SHARES} per site. Shared pages show totals for a date range. They leave out filters, regions and cities.`}>
          <form method="post" action={here} class="stack an-form">
            <Field id="name" label="Name" optional hint="Only you see this. It helps tell links apart." error={errors.name}>
              <Input id="name" name="name" value={values.name ?? ''} maxlength={80} invalid={!!errors.name} />
            </Field>
            <Field id="password" label="Password" optional hint="Leave it empty and anyone with the link can look." error={errors.password}>
              <Input id="password" name="password" type="password" maxlength={256} autocomplete="new-password" invalid={!!errors.password} />
            </Field>
            <Field id="expires_in_days" label="Stops working" error={errors.expires_in_days}>
              <Select
                id="expires_in_days"
                name="expires_in_days"
                value={values.expires_in_days ?? ''}
                options={[{ value: '', label: 'Never' }, { value: '7', label: 'After 7 days' }, { value: '30', label: 'After 30 days' }, { value: '90', label: 'After 90 days' }, { value: '365', label: 'After a year' }]}
                invalid={!!errors.expires_in_days}
              />
            </Field>
            <div class="row">
              <Button type="submit" variant="primary">Make link</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  ), status);
}

manage.get('/sites/:id/share', (c: C) => shareScreen(c));

manage.post('/sites/:id/shares', async (c: C) => {
  const values = await formValues(c);
  const raw = (await c.req.parseBody()).password;
  try {
    const share = await createShare(ctxOf(c), idOf(c), { name: values.name || undefined, password: typeof raw === 'string' && raw ? raw : undefined, expires_in_days: values.expires_in_days ?? '' });
    await auditFromRequest(c, { action: 'share.created', targetType: 'share', targetId: share.id, summary: `Made the share link ${share.name}` });
  } catch (e) {
    const { message, fields } = plainError(e);
    return shareScreen(c, values, Object.keys(fields).length ? fields : { name: message }, 422);
  }
  return act(c, siteHref({ id: idOf(c) }, '/share'), async () => 'Share link made.');
});

manage.post('/sites/:id/shares/:shareId/delete', (c: C) =>
  act(c, siteHref({ id: idOf(c) }, '/share'), async () => {
    const shareId = c.req.param('shareId') ?? '';
    await deleteShare(ctxOf(c), idOf(c), shareId);
    await auditFromRequest(c, { action: 'share.deleted', targetType: 'share', targetId: shareId, summary: 'Deleted a share link' });
    return 'Share link deleted.';
  }),
);

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

const REASONS: Record<(typeof DROP_REASONS)[number], string> = {
  bot: 'Bots and crawlers',
  prerender: 'Pages loaded ahead of time by the browser',
  localhost: 'Visits from localhost',
  origin: 'Sent from a domain this site does not allow',
  dnt: 'Visitors who asked not to be tracked',
  excluded: 'Pages and addresses you left out',
  spam: 'Spam referrers',
  cap: 'Over the daily limit',
  rate: 'Too many hits from one visitor',
  invalid: 'Hits that could not be read',
};

const listText = (json: string): string => parseJson<string[]>(json, []).join('\n');

function valuesOfSite(site: Site): Values {
  return {
    name: site.name, domain: site.domain, domains: listText(site.domains), timezone: site.timezone, retention_days: String(site.retention_days),
    engagement: String(site.engagement), respect_dnt: String(site.respect_dnt), daily_cap: String(site.daily_cap), exclude_paths: listText(site.exclude_paths),
    exclude_ips: listText(site.exclude_ips), pinned: String(site.pinned), weekly_report: String(site.weekly_report), report_emails: listText(site.report_emails),
    spike_threshold: String(site.spike_threshold),
  };
}

/** A checkbox that always sends a value: the hidden 0 comes first, so a ticked box wins. */
function Flag({ name, label, description, values }: { name: string; label: string; description: string; values: Values }) {
  return (
    <>
      <input type="hidden" name={name} value="0" />
      <Checkbox name={name} value="1" checked={values[name] === '1' || values[name] === 'on'} label={label} description={description} />
    </>
  );
}

async function settingsScreen(c: C, typed?: Values, errors: FieldErrors = {}, status?: 422): Promise<Response> {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, idOf(c));
  const now = Date.now();
  await flushDrops(c.env, now);
  const [state, canSend] = await Promise.all([health(ctx.db, site, now), emailReady(c.env)]);
  const v = typed ?? valuesOfSite(site);
  const write = canWrite(c);
  const here = siteHref(site, '/settings');
  const dropped = state.dropped.reduce((n, d) => n + d.n, 0);
  return page(c, `Settings, ${site.name}`, siteCrumbs(site, 'Settings'), (
    <>
      <PageHeader title={site.name} soft={domainNote(site)} actions={<SamplePill site={site} />} />
      <SiteTabs site={site} active="settings" />
      <Card title="Data health" description="What arrived today, and what was left out over the last 7 days.">
        <KeyValueList
          items={[
            // One stored hit in a few is counted, to save writes, so this number moves in steps.
            { label: 'Stored today', value: state.storedToday ? `About ${formatNumber(state.storedToday)} of ${formatNumber(state.dailyCap)} hits` : `Close to none so far. The limit is ${formatNumber(state.dailyCap)} hits.` },
            { label: 'Left out, last 7 days', value: dropped ? formatNumber(dropped) : 'Nothing' },
            ...state.dropped.map((d) => ({ label: REASONS[d.reason as keyof typeof REASONS] ?? d.reason, value: formatNumber(d.n) })),
          ]}
        />
        {state.storedToday >= state.dailyCap ? (
          <Callout tone="warn" title="Today’s limit is reached">Hits over the limit are dropped until midnight. Your visitors see nothing of this. Raise the limit below if your plan has room.</Callout>
        ) : null}
      </Card>
      {write ? (
        <form method="post" action={here} class="stack">
          <Card title="Site">
            <div class="stack an-form">
              <Field id="name" label="Name" error={errors.name}>
                <Input id="name" name="name" value={v.name ?? ''} maxlength={80} invalid={!!errors.name} />
              </Field>
              <Field id="domain" label="Domain" hint="Hits are only accepted from this domain, its www. form and the extra domains below." error={errors.domain}>
                <Input id="domain" name="domain" value={v.domain ?? ''} required maxlength={253} autocapitalize="none" spellcheck={false} invalid={!!errors.domain} />
              </Field>
              <Field id="domains" label="Extra domains" optional hint="One per line. Use *.example.com for every subdomain." error={errors.domains}>
                <Textarea id="domains" name="domains" value={v.domains ?? ''} rows={3} invalid={!!errors.domains} />
              </Field>
              <Field id="timezone" label="Time zone" hint="Days start and end at midnight in this time zone. Changing it only affects new days." error={errors.timezone}>
                <Select id="timezone" name="timezone" value={v.timezone ?? 'UTC'} options={timeZoneOptions(v.timezone ?? 'UTC')} invalid={!!errors.timezone} />
              </Field>
              <Flag name="pinned" label="Pin to the top of the list" description="Pinned sites come first on the all-sites page." values={v} />
            </div>
          </Card>
          <Card title="What is counted">
            <div class="stack an-form">
              <Flag name="engagement" label="Measure time on page" description="The script sends one small extra hit when a visitor leaves a page after 10 seconds or more. Turning it off roughly halves the hits you store." values={v} />
              <Flag name="respect_dnt" label="Leave out visitors who send Do Not Track" description="Off by default: nothing here identifies a person, so there is nothing to opt out of. Turn it on if your policy says so." values={v} />
              <Field id="exclude_paths" label="Pages to leave out" optional hint="One path per line. * stands for anything: /admin/*" error={errors.exclude_paths}>
                <Textarea id="exclude_paths" name="exclude_paths" value={v.exclude_paths ?? ''} rows={3} invalid={!!errors.exclude_paths} />
              </Field>
              <Field id="exclude_ips" label="IP addresses to leave out" optional hint="One per line, like your office address. They are compared as hits arrive and never stored with a hit." error={errors.exclude_ips}>
                <Textarea id="exclude_ips" name="exclude_ips" value={v.exclude_ips ?? ''} rows={3} invalid={!!errors.exclude_ips} />
              </Field>
            </div>
          </Card>
          <Card title="Storage">
            <div class="stack an-form">
              <Field id="retention_days" label="Keep full detail for" hint="Filters, regions, cities and event properties work inside this window. Daily totals are kept for good." error={errors.retention_days}>
                <Select id="retention_days" name="retention_days" value={v.retention_days ?? '30'} options={RETENTION_CHOICES.map((d) => ({ value: String(d), label: `${d} days` }))} invalid={!!errors.retention_days} />
              </Field>
              <Field id="daily_cap" label="Daily limit" hint="Hits stored per day before the rest are dropped. The free Cloudflare plan carries about 25,000 a day across all sites." error={errors.daily_cap}>
                <Input id="daily_cap" name="daily_cap" type="number" inputmode="numeric" min={100} max={5000000} value={v.daily_cap ?? ''} invalid={!!errors.daily_cap} />
              </Field>
            </div>
          </Card>
          <Card title="Emails">
            <div class="stack an-form">
              {canSend ? null : (
                <Callout tone="warn" title="Email is not set up" actions={<LinkButton href="/app/email" size="sm">Set up email</LinkButton>}>
                  Reports and alerts are saved here but not sent until this workspace can send email.
                </Callout>
              )}
              <Flag name="weekly_report" label="Send a weekly report" description="Every Monday: last week’s visitors, top pages and top sources." values={v} />
              <Field id="report_emails" label="Send to" optional hint="One address per line, up to 10. Reports and alerts both go here." error={errors.report_emails}>
                <Textarea id="report_emails" name="report_emails" value={v.report_emails ?? ''} rows={3} invalid={!!errors.report_emails} />
              </Field>
              <Field id="spike_threshold" label="Traffic spike alert" hint="Send one email when this many visitors are on the site at once. 0 turns it off. At most one alert every 6 hours." error={errors.spike_threshold}>
                <Input id="spike_threshold" name="spike_threshold" type="number" inputmode="numeric" min={0} value={v.spike_threshold ?? '0'} invalid={!!errors.spike_threshold} />
              </Field>
            </div>
          </Card>
          <div class="row">
            <Button type="submit" variant="primary">Save settings</Button>
          </div>
        </form>
      ) : (
        <Callout tone="info" title="You can look, not change">Ask a member of this workspace to change this site’s settings.</Callout>
      )}
      {isAdmin(c) ? (
        <form method="post" action={siteHref(site, '/delete')}>
          <DangerZone
            items={[
              {
                title: 'Delete this site',
                description: 'Its visits, goals and share links are removed and the tracking line stops being accepted. This can’t be undone.',
                action: (
                  <ConfirmButton id="delete-site" title={`Delete ${site.name}?`} body={`Everything counted for ${site.domain} is removed for good.`} confirmLabel="Delete site" icon="trash">
                    Delete site
                  </ConfirmButton>
                ),
              },
            ]}
          />
        </form>
      ) : null}
    </>
  ), status);
}

manage.get('/sites/:id/settings', (c: C) => settingsScreen(c));

manage.post('/sites/:id/settings', async (c: C) => {
  const values = await formValues(c);
  try {
    const site = await updateSite(ctxOf(c), idOf(c), values);
    forgetSites(c.env);
    await auditFromRequest(c, { action: 'site.updated', targetType: 'site', targetId: site.id, summary: `Changed the settings of ${site.domain}` });
  } catch (e) {
    const { message, fields } = plainError(e);
    return settingsScreen(c, values, Object.keys(fields).length ? fields : { name: message }, 422);
  }
  return act(c, siteHref({ id: idOf(c) }, '/settings'), async () => 'Settings saved.');
});

manage.post('/sites/:id/delete', async (c: C) => {
  needRole(c, 'admin');
  return act(c, BASE, async () => {
    const ctx = ctxOf(c);
    const site = await getSite(ctx.db, idOf(c));
    await deleteSite(ctx, site.id);
    forgetSites(c.env);
    await auditFromRequest(c, { action: 'site.deleted', targetType: 'site', targetId: site.id, summary: `Deleted the site ${site.domain}` });
    return `${site.name} was deleted.`;
  });
});
