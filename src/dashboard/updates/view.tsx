/** The Updates screen's markup. Pure functions of what `data.ts` loaded. */
import type { JobFailure } from '../../core/jobs';
import {
  Callout,
  Card,
  CodeBlock,
  ConfirmButton,
  EmptyState,
  KeyValueList,
  LinkButton,
  PageHeader,
  Pill,
  Section,
  Table,
  formatDateTime,
  formatNumber,
  plural,
  timeAgo,
} from '../../ui';
import type { UpdatesPage } from './data';

const BASE = '/app/updates';

/** The same five steps as the README's local commands, in the order an owner runs them. */
const STEPS: { title: string; body: string; code: string }[] = [
  {
    title: '1. Save a copy of your data',
    body: 'This writes every table to a file on your computer. Do it before any update that changes the database.',
    code: 'npx wrangler d1 export toolshed --remote --output backup.sql',
  },
  {
    title: '2. Get the new code',
    body: 'Run this in your copy of the Toolshed repository, then install what it needs.',
    code: 'git pull\nnpm install',
  },
  {
    title: '3. Apply the database changes',
    body: 'This prepares the changes that came with the new code and applies the ones your database does not have yet. Applied changes are listed below.',
    code: 'npm run prepare:app\nnpx wrangler d1 migrations apply DB --remote',
  },
  {
    title: '4. Deploy',
    body: 'This puts the new code on your Cloudflare account. Come back to this page afterwards to check the version.',
    code: 'npx wrangler deploy',
  },
];

export function UpdatesView({ page, before }: { page: UpdatesPage; before: number | null }) {
  return (
    <>
      <PageHeader
        title="Updates"
        description="What this install is running, and how to update it."
        actions={<Pill tone="neutral">{`Version ${page.version}`}</Pill>}
      />
      <div class="stack">
        <Card title="Running now" description="Read from this install, so it is always what is really deployed." ruled>
          <KeyValueList
            items={[
              { label: 'Toolshed version', value: <span class="mono">{page.version}</span> },
              { label: 'Database changes', value: migrationSummary(page) },
              { label: 'Modules installed', value: formatNumber(page.modules.length) },
              { label: 'Email', value: emailPill(page) },
              { label: 'Failed jobs', value: failureSummary(page, before) },
            ]}
          />
        </Card>
        <Callout tone="info" title="Updates happen from your computer">
          Toolshed does not look for new versions, and it cannot deploy itself. That keeps this page from talking to other sites and keeps you in charge of when your install changes.
          Check the Toolshed repository for new releases, then follow the steps below.
        </Callout>
      </div>
      <Section title="How to update" description="Run these in a terminal, in your copy of the repository, signed in to the Cloudflare account that runs this install.">
        <Card>
          <div class="stack">
            {STEPS.map((s) => (
              <div class="stack">
                <div class="row-text">
                  <b>{s.title}</b>
                  <span class="hint">{s.body}</span>
                </div>
                <CodeBlock code={s.code} label={s.title.replace(/^\d+\. /, '')} />
              </div>
            ))}
            <div class="row-text">
              <b>If something looks wrong</b>
              <span class="hint">
                Put the previous code back with the first command. It does not change your data. To put the data back too, use D1 Time Travel in the Cloudflare dashboard, or load the file from step 1.
              </span>
            </div>
            <CodeBlock code="npx wrangler rollback" label="rollback command" />
          </div>
        </Card>
      </Section>
      <Section title="Database changes" description="Each change a new version needs is applied once, in order. A list that matches the code you just deployed means step 3 worked.">
        <MigrationsCard migrations={page.migrations} />
      </Section>
      <Section title="Modules" description="Every module this install ships. Each workspace turns its own on or off from Modules.">
        <Card flush>
          <Table
            caption="Installed modules"
            columns={[
              { key: 'name', label: 'Module' },
              { key: 'version', label: 'Version' },
              { key: 'category', label: 'Group', hideOnMobile: true },
            ]}
            rows={page.modules.map((m) => ({
              name: (
                <span class="row-text">
                  <b class="trunc">{m.name}</b>
                  <span class="mono trunc">{m.id}</span>
                </span>
              ),
              version: <span class="mono">{m.version}</span>,
              category: m.category,
            }))}
            empty={<EmptyState bare icon="layers" title="No modules are installed" body="This version of Toolshed shipped without modules. Add one under src/modules and deploy again." />}
          />
        </Card>
      </Section>
      <Section title="Failed jobs" description="Background work, like sending an email or a webhook, that still failed after five tries. Records are kept for 30 days.">
        <div id="failed-jobs">
          <FailuresCard page={page} before={before} />
        </div>
      </Section>
    </>
  );
}

function migrationSummary(page: UpdatesPage) {
  if (!page.migrations) return <span class="muted">Not available</span>;
  const last = page.migrations[page.migrations.length - 1];
  return (
    <>
      {plural(page.migrations.length, 'change')} applied
      {last ? <span class="muted">{` · latest ${last.name}`}</span> : null}
    </>
  );
}

function emailPill(page: UpdatesPage) {
  const { mode } = page.email;
  if (mode === 'live') return <Pill tone="good">On</Pill>;
  if (mode === 'dev') return <Pill tone="neutral">Dev mode</Pill>;
  return (
    <>
      <Pill tone="solid">Needs setup</Pill> <a href="/app/email">Open Email</a>
    </>
  );
}

function failureSummary(page: UpdatesPage, before: number | null) {
  if (page.failures.length === 0) return before === null ? <Pill tone="good">None</Pill> : <span class="muted">None on this page</span>;
  const more = page.nextBefore !== null ? '+' : '';
  return <a href="#failed-jobs">{`${formatNumber(page.failures.length)}${more} to look at`}</a>;
}

function MigrationsCard({ migrations }: { migrations: UpdatesPage['migrations'] }) {
  if (!migrations) {
    return (
      <Callout tone="warn" title="This database does not keep a list">
        Cloudflare D1 records every applied change. This database is not D1, so the list is not available here. Updates still work the same way.
      </Callout>
    );
  }
  return (
    <Card flush>
      <Table
        caption="Applied database changes"
        columns={[
          { key: 'name', label: 'Change' },
          { key: 'at', label: 'Applied' },
        ]}
        rows={migrations.map((m) => ({
          name: <span class="mono trunc">{m.name}</span>,
          at: m.at === null ? <span class="muted">Unknown</span> : <span title={formatDateTime(m.at)}>{timeAgo(m.at)}</span>,
        }))}
        empty={<EmptyState bare icon="layers" title="No database changes recorded yet" body="Step 3 above applies them. Until then the dashboard cannot store anything." />}
      />
    </Card>
  );
}

function FailuresCard({ page, before }: { page: UpdatesPage; before: number | null }) {
  const older = page.nextBefore !== null ? `${BASE}?before=${page.nextBefore}#failed-jobs` : null;
  const rows = page.failures.map((f) => ({
    job: (
      <span class="row-text">
        <b class="trunc" title={f.name}>
          {f.name}
        </b>
        <span class="trunc" title={f.error}>
          {f.error}
        </span>
      </span>
    ),
    when: <span title={formatDateTime(f.failedAt)}>{timeAgo(f.failedAt)}</span>,
    tries: formatNumber(f.attempts),
    state: f.retriedAt ? <Pill tone="neutral">{`Retried ${timeAgo(f.retriedAt)}`}</Pill> : <Pill tone="bad">Failed</Pill>,
    action: <RetryButton failure={f} before={before} />,
  }));
  return (
    <Card flush>
      <Table
        caption="Failed jobs"
        columns={[
          { key: 'job', label: 'Job' },
          { key: 'when', label: 'Failed' },
          { key: 'tries', label: 'Tries', numeric: true, hideOnMobile: true },
          { key: 'state', label: 'Status' },
          { key: 'action', label: 'Actions', srOnly: true },
        ]}
        rows={rows}
        empty={
          before !== null ? (
            <EmptyState bare icon="clock" title="No older failed jobs" actions={<LinkButton href={`${BASE}#failed-jobs`}>Back to newest</LinkButton>} />
          ) : (
            <EmptyState bare icon="shieldcheck" title="No failed jobs" body="Background work is running without problems. A job that fails five times shows up here." />
          )
        }
      />
      {page.failures.length > 0 ? (
        <nav class="pagination" aria-label="Failed job pages">
          <span class="muted">{`Showing ${plural(page.failures.length, 'failed job')}, newest first`}</span>
          <span class="row">
            {before !== null ? (
              <LinkButton size="sm" href={`${BASE}#failed-jobs`}>
                Back to newest
              </LinkButton>
            ) : null}
            {older ? (
              <LinkButton size="sm" href={older} rel="next" icon="right">
                Older
              </LinkButton>
            ) : null}
          </span>
        </nav>
      ) : null}
    </Card>
  );
}

function RetryButton({ failure, before }: { failure: JobFailure; before: number | null }) {
  if (!failure.canRetry) return <span class="muted">Can’t retry</span>;
  if (failure.retriedAt) return <span class="muted">Back on the queue</span>;
  return (
    <form method="post" action={`${BASE}/jobs/${failure.id}/retry`}>
      {before !== null ? <input type="hidden" name="before" value={String(before)} /> : null}
      <ConfirmButton
        id={`retry-${failure.id}`}
        size="sm"
        icon="refresh"
        danger={false}
        title="Retry this job?"
        body="The job goes back on the queue and runs again with a fresh set of tries. If it does something once, like sending an email, it may do it again."
        confirmLabel="Retry job"
      >
        Retry
      </ConfirmButton>
    </form>
  );
}
