/** The all-sites overview and the three steps of a first run: add a site, paste the tag, see the first hit. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import type { FieldErrors } from '../../../core/errors';
import { baseUrl } from '../../../core/net';
import { getSetting } from '../../../core/settings';
import type { AppEnv } from '../../../env';
import {
  Button, Callout, Card, CodeBlock, EmptyState, Field, Input, LinkButton, PageHeader, Select, Sparkline, Stat, StatGrid, Table, formatNumber, timeAgo,
} from '../../../ui';
import { act, BASE, canWrite, formValues, page, plainError, SamplePill, siteCrumbs, siteHref, SiteTabs, type C, type Values } from '../dash-common';
import { ctxOf } from '../http';
import { ensureFresh } from '../rollup';
import { clearSampleData, sampleData } from '../sample';
import { createSite, domainNote, getSite, listSites, pixelSnippet, snippet, type Site } from '../sites';
import { live, siteCards } from '../stats';
import { isTimeZone, MINUTE } from '../time';

export const sites = new Hono<AppEnv>();

/** The overview rolls up a few stale sites a visit, so a workspace with many never spends the request on it. */
const REFRESH_SITES = 5;
const OVERVIEW_FRESH_MS = 5 * MINUTE;

export function timeZoneOptions(current: string): { value: string; label: string }[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // An older runtime: the two below are still offered.
  }
  return [...new Set(['UTC', current, ...zones])].filter(Boolean).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}

sites.get('/', async (c: C) => {
  const ctx = ctxOf(c);
  const now = Date.now();
  let list = await listSites(ctx.db);
  let budget = REFRESH_SITES;
  list = await Promise.all(
    list.map((s) => {
      if (now - s.rolled_at <= OVERVIEW_FRESH_MS || budget <= 0) return s;
      budget--;
      return ensureFresh(ctx.env, s, now, OVERVIEW_FRESH_MS);
    }),
  );
  const cards = await siteCards(ctx.db, list, now);
  const write = canWrite(c);
  const hasSample = list.some((s) => s.sample === 1);
  const add = write ? <LinkButton href={`${BASE}/new`} variant="primary" icon="plus">Add a site</LinkButton> : undefined;

  if (!cards.length) {
    return page(c, 'Analytics', [{ label: 'Analytics' }], (
      <>
        <PageHeader title="Analytics" description="See who visits your sites. No cookies, no consent banner." />
        <EmptyState
          icon="chart"
          title="No sites yet"
          body={write ? 'Add your site, paste one line into its pages, and watch the first visit arrive.' : 'Nobody has added a site yet. Ask a member of this workspace to add one.'}
          actions={add}
        />
        {write ? (
          <Card title="Just looking around" description="Add a sample site with a month of made up visits to see how the screens fill up. Remove it in one click later." class="an-sample">
            <form method="post" action={`${BASE}/sample`}>
              <input type="hidden" name="on" value="1" />
              <Button type="submit">Add the sample site</Button>
            </form>
          </Card>
        ) : null}
      </>
    ));
  }

  const sum = (pick: (card: (typeof cards)[number]) => number) => cards.reduce((n, card) => n + pick(card), 0);
  return page(c, 'Analytics', [{ label: 'Analytics' }], (
    <>
      <PageHeader title="Analytics" description="Every site in this workspace, with today so far." actions={add} />
      {hasSample && write ? (
        <Callout
          tone="info"
          title="The sample site is on"
          actions={
            <form method="post" action={`${BASE}/sample`}>
              <input type="hidden" name="on" value="0" />
              <Button size="sm" type="submit">Remove the sample site</Button>
            </form>
          }
        >
          Its visits are made up. Remove it when you have seen enough.
        </Callout>
      ) : null}
      <StatGrid label="All sites today">
        <Stat label="Visitors today" value={formatNumber(sum((x) => x.visitorsToday))} note={`${formatNumber(sum((x) => x.visitorsYesterday))} yesterday`} />
        <Stat label="Page views today" value={formatNumber(sum((x) => x.pageviewsToday))} />
        <Stat label="Sites" value={formatNumber(cards.length)} />
      </StatGrid>
      <Card flush>
        <Table
          caption="Sites"
          columns={[
            { key: 'site', label: 'Site' },
            { key: 'visitors', label: 'Visitors today', numeric: true },
            { key: 'views', label: 'Page views today', numeric: true },
            { key: 'yesterday', label: 'Visitors yesterday', numeric: true, hideOnMobile: true },
            { key: 'week', label: 'Last 7 days', hideOnMobile: true },
          ]}
          rows={cards.map(({ site, visitorsToday, pageviewsToday, visitorsYesterday, spark }) => ({
            site: (
              <span class="an-site">
                <a href={siteHref(site)}><b>{site.name}</b></a> <SamplePill site={site} />
                {domainNote(site) ? <span class="muted">{site.domain}</span> : null}
                {site.first_hit_at === null && site.sample !== 1 ? <a href={siteHref(site, '/setup')}>Waiting for the first page view</a> : null}
              </span>
            ),
            visitors: formatNumber(visitorsToday),
            views: formatNumber(pageviewsToday),
            yesterday: formatNumber(visitorsYesterday),
            week: <Sparkline values={spark} label={`Visitors on ${site.name}, last 7 days`} />,
          }))}
        />
      </Card>
    </>
  ));
});

sites.post('/sample', (c: C) =>
  act(c, BASE, async () => {
    const ctx = ctxOf(c);
    if ((await formValues(c)).on === '1') {
      await sampleData(ctx);
      return 'Sample site added.';
    }
    await clearSampleData(ctx);
    return 'Sample site removed.';
  }),
);

async function newSite(c: C, values: Values = {}, errors: FieldErrors = {}, status?: 422): Promise<Response> {
  const zone = values.timezone ?? (await getSetting<string>(c.env, ctxOf(c).org.id, 'timezone', 'UTC'));
  const timezone = typeof zone === 'string' && isTimeZone(zone) ? zone : 'UTC';
  return page(c, 'Add a site', [{ label: 'Analytics', href: BASE }, { label: 'Add a site' }], (
    <>
      <PageHeader title="Add a site" description="Step 1 of 3. Next you paste one line into your pages, then you watch the first visit arrive." />
      <Card>
        <form method="post" action={`${BASE}/new`} class="stack an-form">
          <Field id="domain" label="Domain" hint="The address of your site, like example.com. Visits from its www. form count too." error={errors.domain}>
            <Input id="domain" name="domain" value={values.domain ?? ''} placeholder="example.com" required maxlength={253} autocomplete="off" autocapitalize="none" spellcheck={false} invalid={!!errors.domain} autofocus />
          </Field>
          <Field id="name" label="Name" optional hint="How the site is listed here. Leave it empty to use the domain." error={errors.name}>
            <Input id="name" name="name" value={values.name ?? ''} maxlength={80} invalid={!!errors.name} />
          </Field>
          <Field id="timezone" label="Time zone" hint="Days start and end at midnight in this time zone." error={errors.timezone}>
            <Select id="timezone" name="timezone" value={timezone} options={timeZoneOptions(timezone)} invalid={!!errors.timezone} />
          </Field>
          <div class="row">
            <Button type="submit" variant="primary">Add site</Button>
            <LinkButton href={BASE} variant="ghost">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  ), status);
}

sites.get('/new', (c: C) => newSite(c));

sites.post('/new', async (c: C) => {
  const values = await formValues(c);
  try {
    const site = await createSite(ctxOf(c), { domain: values.domain ?? '', name: values.name || undefined, timezone: values.timezone || undefined });
    await auditFromRequest(c, { action: 'site.created', targetType: 'site', targetId: site.id, summary: `Added the site ${site.domain}` });
    return c.redirect(siteHref(site, '/setup'), 303);
  } catch (e) {
    const { message, fields } = plainError(e);
    return newSite(c, values, Object.keys(fields).length ? fields : { domain: message }, 422);
  }
});

function Waiting({ site, firstHitAt }: { site: Site; firstHitAt: number | null }) {
  if (firstHitAt !== null) {
    return (
      <Callout tone="good" title="It works" actions={<LinkButton href={siteHref(site)} variant="primary" size="sm">Open the dashboard</LinkButton>}>
        The first page view arrived {timeAgo(firstHitAt)}.
      </Callout>
    );
  }
  return (
    <div class="an-wait" data-an-wait={siteHref(site, '/live.json')} role="status">
      <span class="an-dot" aria-hidden="true"></span>
      <div>
        <b>Waiting for the first page view</b>
        <p class="muted">
          Open your site in another tab after adding the line. This box checks every few seconds. <a href={siteHref(site, '/setup')}>Check now</a>
        </p>
      </div>
    </div>
  );
}

sites.get('/sites/:id/setup', async (c: C) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id') ?? '');
  const now = Date.now();
  const state = await live(ctx.db, site, now);
  const url = baseUrl(c);
  return page(c, `Install on ${site.name}`, siteCrumbs(site, 'Install'), (
    <>
      <PageHeader title={site.name} soft={domainNote(site)} actions={<SamplePill site={site} />} />
      <SiteTabs site={site} active="setup" />
      <Card title="Step 2 of 3. Paste this line" description={`Put it inside the <head> of every page on ${site.domain}. It is under 2 KB, sets no cookies and does not slow the page down.`}>
        <CodeBlock code={snippet(url, site)} label="tracking line" />
      </Card>
      <Card title="Step 3 of 3. See the first visit">
        <Waiting site={site} firstHitAt={state.firstHitAt} />
        <p class="muted an-gap">Visits from localhost and from files on your computer are never counted, so test on the real site.</p>
      </Card>
      <Card title="Options" description="Add any of these to the line to change what it does.">
        <dl class="an-opts">
          <dt><code>data-hash</code></dt>
          <dd>Count a change of the part after # as a new page, for sites that route with it.</dd>
          <dt><code>data-manual</code></dt>
          <dd>Do not count page views on their own. Call <code>toolshed('pageview')</code> yourself.</dd>
          <dt><code>data-no-pings</code></dt>
          <dd>Do not measure time on page.</dd>
          <dt><code>data-api</code></dt>
          <dd>Send hits to another address, for when you pass them through your own domain.</dd>
        </dl>
      </Card>
      <Card title="Count things people do" description="Call this from your own script for sign-ups, purchases or anything else. Clicks on links to other sites, file downloads and 404 pages are counted for you.">
        <CodeBlock code={"toolshed('Signup', { plan: 'free' })"} label="event example" />
      </Card>
      <Card title="Leave yourself out" description="Open this address once in each browser you use. Your own visits stop counting there. Use #toolshed-unignore to undo it.">
        <CodeBlock code={`https://${site.domain}/#toolshed-ignore`} label="opt-out address" />
      </Card>
      <Card title="Pages where scripts cannot run" description="This image counts a page view without script. It cannot see the referrer, time on page or events.">
        <CodeBlock code={pixelSnippet(url, site)} label="image fallback" />
      </Card>
    </>
  ));
});

/** What the small script asks for: how many people are on the site now, and whether the first hit has arrived. */
sites.get('/sites/:id/live.json', async (c: C) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id') ?? '');
  const state = await live(ctx.db, site, Date.now());
  return c.json({ visitors: state.visitors, first_hit_at: state.firstHitAt }, 200, { 'cache-control': 'no-store' });
});
