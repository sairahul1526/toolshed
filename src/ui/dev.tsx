/**
 * /dev/ui: every UI kit component on one page, with sample data. Dev only (the app returns 404 elsewhere).
 *
 *   /dev/ui                      the gallery inside the dashboard shell
 *   /dev/ui?theme=dark           force light or dark
 *   /dev/ui?accent=violet        lime, mint, sky, violet, rose or amber
 *   /dev/ui?data=worst           swap in worst-case data: long names, huge numbers, empty lists, other scripts
 *   /dev/ui/auth                 the sign-in style page
 *   /dev/ui/public?preset=warm   public page presets: paper, warm, cobalt, dusk
 *   /dev/ui/error?status=404     the error page
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ShellData } from '../core/shell-data';
import type { AppEnv } from '../env';
import { ACCENTS, PUBLIC_PRESETS, parseAppearance, type Accent, type Appearance, type PublicPreset } from './appearance';
import { Button, IconButton, LinkButton } from './components/buttons';
import { BarChart, LineChart, Sparkline } from './components/charts';
import {
  Avatar,
  Callout,
  Card,
  EmptyState,
  KeyValueList,
  PageHeader,
  Pagination,
  Pill,
  Section,
  Stat,
  StatGrid,
  Table,
  Tabs,
} from './components/data';
import { Breadcrumb, EditorBar, Skeleton, Toast } from './components/feedback';
import { Checkbox, Field, Input, OtpInput, PasswordInput, RadioCards, Segmented, Select, Switch, Textarea } from './components/forms';
import { CodeBlock, ConfirmButton, CopyField, DangerZone, Dialog, FilterBar, Inspector, Menu, SearchInput } from './components/overlays';
import { ErrorPage } from './error-page';
import { formatBytes, formatCompact, formatDate, formatDateTime, formatNumber, plural, timeAgo } from './format';
import { AppShell, AuthLayout } from './layout';
import { PublicButton, PublicCard, PublicField, PublicInput, PublicPage } from './public';
import { ICONS } from './icons';

export const devUi = new Hono<AppEnv>();

const NOW = Date.UTC(2026, 10, 21, 9, 30);

function pick<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
  return allowed.find((a) => a === value);
}

function sampleShell(c: Context<AppEnv>, worst: boolean): ShellData {
  const accent = pick(ACCENTS, c.req.query('accent')) ?? 'lime';
  return {
    user: {
      id: 'u1',
      email: worst ? 'a.very.long.email.address.that.does.not.break.anywhere@subdomain.example-company-name.example.com' : 'maya@example.com',
      name: worst ? 'Maximilian Alexander Konstantinopoulos-Featherstonehaugh' : 'Maya Reyes',
      image: null,
      isInstanceOwner: true,
    },
    org: { id: 'o1', name: worst ? 'Northwind Studio and Associates International Holdings' : 'Northwind Studio', slug: 'northwind', role: 'owner' },
    modules: [
      { id: 'links', name: 'Links', icon: 'link', href: '/app/links', count: worst ? 1284903 : 128, nav: [] },
      { id: 'forms', name: worst ? 'Forms and surveys with a very long module name' : 'Forms', icon: 'form', href: '/app/forms', count: 6, nav: [] },
      { id: 'analytics', name: 'Analytics', icon: 'chart', href: '/app/analytics', count: null, nav: [] },
    ],
    modulesOff: 3,
    appearance: { accent },
  };
}

const LINKS = [
  { name: 'Spring launch', url: '/spring', clicks: 4821, status: 'good' as const, label: 'Live' },
  { name: 'Newsletter signup', url: '/news', clicks: 1290, status: 'good' as const, label: 'Live' },
  { name: 'Old campaign', url: '/2019', clicks: 14, status: 'neutral' as const, label: 'Paused' },
  { name: 'Partner offer', url: '/partners', clicks: 0, status: 'warn' as const, label: 'Needs review' },
];

const WORST_LINKS = [
  { name: 'A campaign name that keeps going and going well past any sensible width for a table cell', url: '/this-is-a-very-long-slug-that-has-no-spaces-in-it-at-all-and-never-ends-ever', clicks: 123456789, status: 'good' as const, label: 'Live' },
  { name: 'X', url: '/x', clicks: 1, status: 'bad' as const, label: 'Broken' },
  { name: '夏のキャンペーン 🎉 شركة الاختبار', url: '/日本語', clicks: 0, status: 'neutral' as const, label: 'Paused' },
];

/** Longer than any column: shows how a value that must be read in full behaves. */
const longAddress = `${'a-very-long-mailbox-name.'.repeat(3)}with+tags@${'subdomain.'.repeat(4)}example-company-name.co.uk`;

function Gallery({ worst }: { worst: boolean }) {
  const links = worst ? WORST_LINKS : LINKS;
  const days = Array.from({ length: 14 }, (_, i) => `Nov ${i + 8}`);
  const clicks = [12, 18, 9, 22, 31, 28, 40, 36, 44, 51, 47, 63, 58, 72].map((v) => (worst ? v * 91000 : v));
  const uniques = clicks.map((v) => Math.round(v * 0.62));
  return (
    <>
      <PageHeader
        title="UI kit"
        soft="gallery"
        description={worst ? 'Worst-case data: long names, huge numbers, other scripts.' : 'Every component with sample data. Use the links in the top row to change mode, accent and data.'}
        actions={
          <>
            <LinkButton size="sm" href={worst ? '?' : '?data=worst'}>
              {worst ? 'Demo data' : 'Worst case'}
            </LinkButton>
            <LinkButton size="sm" variant="primary" href="/dev/ui/auth">
              Auth page
            </LinkButton>
          </>
        }
      />

      <Section title="Buttons" description="Variants, sizes, icons and the busy state.">
        <Card>
          <div class="row">
            <Button>Default</Button>
            <Button variant="primary">Primary</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger-solid">Delete</Button>
            <Button variant="ghost">Ghost</Button>
            <Button size="sm" icon="plus">
              Small
            </Button>
            <Button disabled>Disabled</Button>
            <Button aria-busy="true">Saving</Button>
            <IconButton icon="gear" label="Settings" bordered />
            <LinkButton href="#">Link button</LinkButton>
          </div>
        </Card>
      </Section>

      <Section title="Numbers" description="Stat cards, charts and a sparkline. Charts are plain SVG with a hidden table for screen readers.">
        <StatGrid>
          <Stat label="Clicks" value={formatNumber(worst ? 987654321 : 18420)} note={<><b>+12%</b> on last week</>} icon="link" />
          <Stat label="Unique visitors" value={formatCompact(worst ? 987654321 : 9210)} note="Counted once per person per day" icon="users" />
          <Stat label="Storage" value={formatBytes(worst ? 5.4e12 : 3.2e8)} note="Of unlimited" icon="layers" />
          <Stat label="Errors" value="0" unit="today" note="Nothing to fix" icon="shieldcheck" />
        </StatGrid>
        <div class="row-2 gallery-gap">
          <Card title="Clicks over time" description="Last 14 days" flush>
            <LineChart title="Clicks over time" labels={days} series={[{ label: 'Clicks', values: clicks }, { label: 'Unique', values: uniques }]} />
          </Card>
          <Card title="Top links" flush>
            <BarChart title="Top links" unit="clicks" data={links.map((l) => ({ label: l.name.slice(0, 12), value: l.clicks }))} />
          </Card>
        </div>
        <p class="muted gallery-gap">
          Sparkline <Sparkline values={clicks} label="Clicks, last 14 days" /> and an empty one <Sparkline values={[]} label="No data" />.
        </p>
      </Section>

      <Section title="Table" description="Rows become cards at 760 px and below.">
        <Card flush>
          <FilterBar>
            <SearchInput placeholder="Search links" />
            <Select aria-label="Status" name="status" options={[{ value: '', label: 'Any status' }, { value: 'live', label: 'Live' }, { value: 'paused', label: 'Paused' }]} />
          </FilterBar>
          <Table
            caption="Links"
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'status', label: 'Status', hideOnMobile: false },
              { key: 'clicks', label: 'Clicks', numeric: true },
              { key: 'trend', label: 'Trend', hideOnMobile: true },
              { key: 'actions', label: 'Actions', srOnly: true },
            ]}
            rows={links.map((l) => ({
              name: (
                <span class="cell-name">
                  <Avatar name={l.name} size="sm" />
                  <span class="row-text">
                    <b>{l.name}</b>
                    <span>{l.url}</span>
                  </span>
                </span>
              ),
              status: <Pill tone={l.status}>{l.label}</Pill>,
              clicks: formatNumber(l.clicks),
              trend: <Sparkline values={[3, 5, 4, 8, 6, 9, 12]} label={`${l.name} clicks`} />,
              actions: <IconButton icon="more" label={`More for ${l.name}`} data-menu="row" />,
            }))}
            empty={<EmptyState title="No links yet" body="Create your first short link." actions={<Button variant="primary">New link</Button>} />}
          />
          <Pagination page={2} pageSize={25} total={worst ? 1284903 : 312} href={(p) => `?page=${p}`} noun={['link', 'links']} />
        </Card>
        <Card class="gallery-gap" title="Table with a value to read in full" description="Cut with a hover title on wide screens. Wraps on phones, where there is no hover." flush>
          <Table
            caption="Addresses"
            columns={[
              { key: 'address', label: 'Address' },
              { key: 'why', label: 'Why' },
            ]}
            rows={[
              {
                address: (
                  <span class="row-text">
                    <b class="trunc full-m" title={longAddress}>
                      {longAddress}
                    </b>
                  </span>
                ),
                why: 'Bounced',
              },
            ]}
          />
        </Card>
        <Card class="gallery-gap" title="Empty table">
          <Table caption="Nothing" columns={[{ key: 'a', label: 'A' }]} rows={[]} empty={<EmptyState bare icon="link" title="No links yet" body="Links you create show up here." />} />
        </Card>
      </Section>

      <Section title="Forms">
        <Card>
          <form class="form" method="post" action="#" data-no-busy>
            <div class="form-row">
              <Field id="f-name" label="Name" hint="Shown to people you invite.">
                <Input id="f-name" name="name" value={worst ? 'Maximilian Alexander Konstantinopoulos-Featherstonehaugh' : 'Maya Reyes'} />
              </Field>
              <Field id="f-email" label="Email" error="That address is already in use.">
                <Input id="f-email" name="email" type="email" invalid value="maya@example.com" />
              </Field>
            </div>
            <Field id="f-token" label="Invite code" hint="Share this with the person you invite." action={<Button type="button">Generate</Button>}>
              <Input id="f-token" name="token" placeholder="abc-123" />
            </Field>
            <Field id="f-slug" label="Short link" optional>
              <Input id="f-slug" name="slug" prefix="tools.example.com/" placeholder="spring" />
            </Field>
            <Field id="f-search" label="With icon">
              <Input id="f-search" name="s" icon="search" placeholder="Search" />
            </Field>
            <Field id="f-pass" label="Password" hint="At least 10 characters.">
              <PasswordInput id="f-pass" name="password" autocomplete="new-password" />
            </Field>
            <Field id="f-role" label="Role">
              <Select id="f-role" name="role" value="member" options={[{ value: 'admin', label: 'Admin' }, { value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }]} />
            </Field>
            <Field id="f-note" label="Note">
              <Textarea id="f-note" name="note" placeholder="Anything to add" />
            </Field>
            <RadioCards
              name="plan"
              label="Look"
              value="warm"
              options={[
                { value: 'paper', label: 'Paper', description: 'Quiet and neutral', icon: 'layers' },
                { value: 'warm', label: 'Warm', description: 'Cream and clay', icon: 'brush' },
                { value: 'cobalt', label: 'Cobalt', description: 'Cool and crisp', icon: 'globe' },
              ]}
            />
            <Segmented name="range" label="Range" value="7" options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
            <Checkbox name="agree" label="Send me release notes" description="About once a month. No tracking." checked />
            <div class="row">
              <Switch label="Active" name="active" checked />
              <Switch label="Large switch" name="big" large />
              <Switch label="Disabled switch" name="off" disabled />
            </div>
            <Field id="f-otp" label="One-time code">
              <OtpInput name="code" />
            </Field>
            <div class="row">
              <Button type="submit" variant="primary">
                Save changes
              </Button>
              <Button type="button" data-toast="Saved.">
                Show a toast
              </Button>
            </div>
          </form>
        </Card>
      </Section>

      <Section title="Status and messages">
        <div class="stack">
          <div class="row">
            <Pill>Neutral</Pill>
            <Pill tone="good">Good</Pill>
            <Pill tone="warn">Warning</Pill>
            <Pill tone="bad">Bad</Pill>
            <Pill tone="solid">Solid</Pill>
            <Avatar name="Maya Reyes" />
            <Avatar name="X" />
            <Avatar name="夏のキャンペーン" size="md" />
          </div>
          <Callout title="Heads up">Sign-in codes go out from a shared address until you add a sending domain.</Callout>
          <Callout tone="good" title="All set">Your workspace is ready.</Callout>
          <Callout tone="warn" title="Almost out of room" actions={<LinkButton size="sm" href="#">Manage storage</LinkButton>}>
            You have used 92% of your storage.
          </Callout>
          <Callout tone="bad" title="Could not save">Check the highlighted fields and try again.</Callout>
          <Card title="Loading">
            <Skeleton lines={4} />
          </Card>
          <Card>
            <EmptyState bare icon="sparkles" title="No lists yet" body="Create the first one below." />
            <form class="form" method="post" action="#" data-no-busy>
              <Field id="f-list" label="List name">
                <Input id="f-list" name="list" placeholder="Launch list" />
              </Field>
              <div class="actions"><Button variant="primary">Create list</Button></div>
            </form>
          </Card>
          <EmptyState icon="form" title="No forms yet" body="Build one in a few minutes." actions={<><Button variant="primary">New form</Button><Button>Import</Button></>} />
          <div class="toast-demo">
            <Toast message="Link copied." kind="ok" />
          </div>
        </div>
      </Section>

      <Section title="Tabs, key values and breadcrumb">
        <Card flush>
          <Tabs
            label="Link details"
            active="overview"
            items={[
              { id: 'overview', label: 'Overview', content: <p class="muted pad">Overview panel</p> },
              { id: 'clicks', label: 'Clicks', count: 18420, content: <p class="muted pad">Clicks panel</p> },
              { id: 'settings', label: 'Settings', content: <p class="muted pad">Settings panel</p> },
            ]}
          />
        </Card>
        <Card class="gallery-gap" flush>
          <Tabs label="Pages" active="a" items={[{ id: 'a', label: 'One', href: '#a' }, { id: 'b', label: 'Two', href: '#b', count: 4 }]} />
        </Card>
        <Card class="gallery-gap" title="Details">
          <KeyValueList items={[{ label: 'Created', value: formatDateTime(NOW - 86400000 * 4) }, { label: 'Last click', value: timeAgo(NOW - 5 * 60000, NOW) }, { label: 'Size', value: formatBytes(48213) }, { label: 'Owner', value: plural(3, 'person', 'people') }]} />
        </Card>
        <Breadcrumb items={[{ label: 'Links', href: '#' }, { label: 'Spring launch' }]} />
      </Section>

      <Section title="Overlays" description="Dialog, confirm, menu, inspector, copy and code.">
        <Card>
          <div class="row">
            <Button data-open="demo-dialog">Open dialog</Button>
            <Button data-menu="demo-menu">Open menu</Button>
            <Button data-inspect="demo-inspector">Open inspector</Button>
            <Button data-command>Command menu</Button>
            <form method="post" action="#" data-no-busy>
              <ConfirmButton id="demo" title="Delete this link?" body="People who open it will see a not found page. This cannot be undone." confirmLabel="Delete link" icon="trash">
                Delete link
              </ConfirmButton>
            </form>
          </div>
        </Card>
        <Card class="gallery-gap" title="Copy and code">
          <div class="stack">
            <CopyField label="API key" value="ts_live_9f3b2c1d7a6e48f0b5d2" />
            <CodeBlock code={'curl https://tools.example.com/api/v1/links \\\n  -H "Authorization: Bearer ts_live_..."'} label="Example request" />
          </div>
        </Card>
        <div class="gallery-gap">
          <DangerZone items={[{ title: 'Delete this workspace', description: 'Removes every link, form and file. Cannot be undone.', action: <Button variant="danger">Delete workspace</Button> }]} />
        </div>
        <div class="gallery-gap">
          <EditorBar back={{ href: '#', label: 'Forms' }} title={worst ? 'A form title that is much too long to fit in the bar without being cut off' : 'Customer feedback'} status={<Pill tone="warn">Draft</Pill>} actions={<><Button size="sm">Preview</Button><Button size="sm" variant="primary">Publish</Button></>} />
        </div>
      </Section>

      <Section title="Format helpers">
        <Card>
          <KeyValueList
            items={[
              { label: 'formatNumber', value: formatNumber(1234567) },
              { label: 'formatCompact', value: formatCompact(1234567) },
              { label: 'formatDate', value: formatDate(NOW) },
              { label: 'timeAgo', value: timeAgo(NOW - 3 * 3600000, NOW) },
              { label: 'formatBytes', value: formatBytes(1536000) },
              { label: 'plural', value: plural(1, 'link') },
            ]}
          />
        </Card>
      </Section>

      <Section title="Icons" description={`${Object.keys(ICONS).length} icons on a 24 px grid.`}>
        <Card>
          <ul class="icon-grid">
            {Object.keys(ICONS).map((n) => (
              <li>
                <svg class="i" aria-hidden="true">
                  <use href={`#i-${n}`} />
                </svg>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      <Menu id="demo-menu" head={{ title: 'Spring launch', subtitle: 'Link' }} items={[{ label: 'Edit', icon: 'pencil', href: '#' }, { label: 'Copy link', icon: 'copy', href: '#' }, { label: 'Delete', icon: 'trash', href: '#', danger: true, divider: true }]} />
      <Menu id="row" items={[{ label: 'Open', icon: 'link', href: '#' }, { label: 'Pause', icon: 'pause', href: '#' }]} />
      <Dialog
        id="demo-dialog"
        title="Invite people"
        description="They get an email with a sign-in code."
        footer={
          <>
            <span class="spacer" />
            <Button data-close>Cancel</Button>
            <Button variant="primary" data-close>
              Send invite
            </Button>
          </>
        }
      >
        <Field id="d-email" label="Email addresses">
          <Input id="d-email" type="email" placeholder="name@example.com" />
        </Field>
      </Dialog>
      <Inspector id="demo-inspector" title="Spring launch" footer={<Button variant="primary" data-close>Done</Button>}>
        <KeyValueList items={[{ label: 'Created', value: formatDate(NOW) }, { label: 'Clicks', value: formatNumber(4821) }]} />
      </Inspector>
    </>
  );
}

devUi.get('/', (c) => {
  const worst = c.req.query('data') === 'worst';
  const shell = sampleShell(c, worst);
  const theme = c.req.query('theme');
  return c.html(
    <AppShell shell={shell} path="/dev/ui" title="UI kit" crumbs={[{ label: 'UI kit' }]} forceTheme={theme === 'dark' || theme === 'light' ? theme : undefined} styles={['/assets/dev.css']}>
      <Gallery worst={worst} />
    </AppShell>,
  );
});

devUi.get('/auth', (c) => {
  const state = c.req.query('state') ?? 'email';
  const theme = c.req.query('theme');
  const appearance: Appearance = parseAppearance({ accent: pick(ACCENTS, c.req.query('accent')) as Accent | undefined });
  return c.html(
    <AuthLayout title="Sign in" brand="Northwind Studio" appearance={appearance} forceTheme={theme === 'dark' || theme === 'light' ? theme : undefined} footer={<>New here? Ask an admin of Northwind Studio to invite you.<br />Toolshed v0.1.0</>}>
      {state === 'code' ? (
        <section class="card">
          <h1>Check your email</h1>
          <p class="sub">We sent a 6-digit code to <b>maya@example.com</b>. It works for 10 minutes.</p>
          <form class="form" method="post" action="#" data-no-busy>
            <OtpInput name="code" autofocus />
            <Button type="submit" variant="primary" size="block">Continue</Button>
            <Callout>The email also has a sign-in link. Opening it on this device works too.</Callout>
          </form>
        </section>
      ) : (
        <section class="card">
          <h1>Sign in</h1>
          <p class="sub">Use the email your workspace invited.</p>
          <form class="form" method="post" action="#" data-no-busy>
            <Field id="email" label="Email">
              <Input id="email" name="email" type="email" value="maya@example.com" autocomplete="username webauthn" />
            </Field>
            <Button type="submit" variant="primary" size="block">Email me a code</Button>
            <a class="link" href="/dev/ui/auth?state=code">See the code step</a>
          </form>
        </section>
      )}
    </AuthLayout>,
  );
});

devUi.get('/public', (c) => {
  const preset: PublicPreset = pick(PUBLIC_PRESETS, c.req.query('preset')) ?? 'paper';
  const theme = c.req.query('theme');
  const appearance = parseAppearance({ preset, powered: c.req.query('powered') !== '0' });
  return c.html(
    <PublicPage title="Contact" brand="Northwind Studio" appearance={appearance} forceTheme={theme === 'dark' || theme === 'light' ? theme : undefined}>
      <PublicCard>
        <h1>Tell us about your project</h1>
        <p>We reply within two working days.</p>
        <form method="post" action="#" class="pub-form">
          <PublicField id="p-name" label="Your name">
            <PublicInput id="p-name" autocomplete="name" />
          </PublicField>
          <PublicField id="p-email" label="Email" hint="We only use it to reply.">
            <PublicInput id="p-email" type="email" autocomplete="email" describedBy="p-email-hint" />
          </PublicField>
          <PublicField id="p-msg" label="Message" optional error="Please write a few words.">
            <textarea id="p-msg" name="msg" aria-invalid="true" aria-describedby="p-msg-error" class="pub-input" />
          </PublicField>
          <PublicButton type="submit" block>
            Send message
          </PublicButton>
          <PublicButton ghost block href="/dev/ui/public">
            Back
          </PublicButton>
        </form>
      </PublicCard>
    </PublicPage>,
  );
});

devUi.get('/error', (c) => {
  const status = Number(c.req.query('status') ?? '404');
  const theme = c.req.query('theme');
  void theme;
  return c.html(
    <ErrorPage
      status={Number.isInteger(status) ? status : 404}
      code={status === 404 ? 'not_found' : 'internal'}
      message={status === 404 ? 'That page does not exist. It may have moved.' : 'Something went wrong on our side. Try again in a moment.'}
      requestId="8f3a2b1c-demo"
      signedIn={c.req.query('signedIn') === '1'}
    />,
    (Number.isInteger(status) && status >= 400 && status < 600 ? status : 404) as 404,
  );
});
