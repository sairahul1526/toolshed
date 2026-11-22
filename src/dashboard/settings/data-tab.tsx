/** Data: ask for an export of the whole workspace, download a finished one, and delete the workspace. */
import type { FieldErrors } from '../../core/errors';
import type { ExportItem } from '../../core/export';
import { Button, Callout, Card, EmptyState, Field, formatBytes, formatDateTime, Input, LinkButton, Pill, Section, Table } from '../../ui';
import type { PillTone } from '../../ui';
import { ADMIN_ONLY, BASE, tabHref } from './frame';

const STATUS: Record<ExportItem['status'], { label: string; tone: PillTone }> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Preparing', tone: 'warn' },
  done: { label: 'Ready', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  expired: { label: 'Expired', tone: 'neutral' },
};

/** One line saying where an export stands and what to do about it. */
function detail(e: ExportItem): string {
  if (e.status === 'queued') return 'Waiting to start.';
  if (e.status === 'running') return `${e.tablesDone} of ${e.tablesTotal} tables done.`;
  if (e.status === 'done') return e.expiresAt === null ? 'Ready to download.' : `Download it before ${formatDateTime(e.expiresAt)}.`;
  if (e.status === 'failed') return 'This one didn’t finish. Start a new export.';
  return 'The file was removed after 24 hours. Start a new export.';
}

export interface DataProps {
  exports: ExportItem[];
  canExport: boolean;
  /** Why exporting is switched off for this person right now, such as signed in as someone else. */
  exportBlock: string | null;
  isOwner: boolean;
  orgName: string;
  orgSlug: string;
  /** Why deleting is switched off right now, or null. */
  deleteBlock: string | null;
  errors?: FieldErrors;
}

function ExportSection({ exports, canExport, exportBlock }: Pick<DataProps, 'exports' | 'canExport' | 'exportBlock'>) {
  const busy = exports.some((e) => e.status === 'queued' || e.status === 'running');
  return (
    <Section title="Export everything" description="One ZIP with a JSON and a CSV file for every table: your tools’ data, members, settings and the audit log. Passwords and key secrets are never in it.">
      {!canExport ? <Callout title="Admins only">{ADMIN_ONLY}</Callout> : null}
      {exportBlock ? (
        <Callout tone="warn" title="Not while signed in as someone else">
          {exportBlock}
        </Callout>
      ) : null}
      {canExport ? (
        <>
          <Card
            footer={
              <>
                <span class="note">{busy ? 'An export is running. You can start another when it finishes.' : 'We email you a link when it’s ready. The file can be downloaded for 24 hours.'}</span>
                {busy ? (
                  <LinkButton size="sm" icon="refresh" href={tabHref('data')}>
                    Check again
                  </LinkButton>
                ) : null}
              </>
            }
          >
            <form method="post" action={`${BASE}/export`}>
              <Button type="submit" icon="download" disabled={busy || exportBlock !== null}>
                Start export
              </Button>
            </form>
          </Card>
          <Card flush title="Past exports" description="The latest 20. The file is kept for 24 hours; the record for 90 days.">
            <Table
              caption="Past exports"
              columns={[
                { key: 'started', label: 'Started' },
                { key: 'status', label: 'Status' },
                { key: 'size', label: 'Size', numeric: true, hideOnMobile: true },
                { key: 'action', label: 'Download', srOnly: true },
              ]}
              rows={exports.map((e) => ({
                started: (
                  <span class="row-text">
                    <b>{formatDateTime(e.createdAt)}</b>
                    <span>{detail(e)}</span>
                  </span>
                ),
                status: <Pill tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Pill>,
                size: e.size === null ? '' : formatBytes(e.size),
                action:
                  e.downloadPath === null ? null : (
                    <LinkButton size="sm" icon="download" href={e.downloadPath}>
                      Download
                    </LinkButton>
                  ),
              }))}
              empty={<EmptyState bare icon="download" title="No exports yet" body="Press Start export above. It takes a minute or two for a small workspace." />}
            />
          </Card>
        </>
      ) : null}
    </Section>
  );
}

function DeleteSection({ isOwner, orgName, orgSlug, deleteBlock, errors = {} }: Pick<DataProps, 'isOwner' | 'orgName' | 'orgSlug' | 'deleteBlock' | 'errors'>) {
  return (
    <Section title="Danger zone" description="This can’t be undone.">
      <section class="danger-zone card" aria-label="Danger zone">
        <div class="card-head ruled">
          <h2>Delete this workspace</h2>
        </div>
        <div class="card-body after-head">
          {!isOwner ? (
            <Callout title="Owners only">Only the workspace owner can delete it. Ask the owner if it should go.</Callout>
          ) : (
            <form method="post" action={`${BASE}/delete`} class="form" autocomplete="off">
              {deleteBlock ? (
                <Callout tone="warn" title="Not right now">
                  {deleteBlock}
                </Callout>
              ) : null}
              <p>
                Deleting <b>{orgName}</b> removes everything in it for good: every tool’s data, members, keys, webhooks and settings. Members lose access right away. Export first if you might want any of it.
              </p>
              <Field id="confirm" label={`Type ${orgSlug} to confirm`} error={errors.confirm}>
                <Input id="confirm" name="confirm" autocomplete="off" required invalid={Boolean(errors.confirm)} placeholder={orgSlug} />
              </Field>
              <div>
                <Button type="submit" variant="danger-solid" icon="trash" disabled={deleteBlock !== null}>
                  Delete workspace
                </Button>
              </div>
            </form>
          )}
        </div>
      </section>
    </Section>
  );
}

export function DataTab(props: DataProps) {
  return (
    <>
      <ExportSection exports={props.exports} canExport={props.canExport} exportBlock={props.exportBlock} />
      <DeleteSection isOwner={props.isOwner} orgName={props.orgName} orgSlug={props.orgSlug} deleteBlock={props.deleteBlock} errors={props.errors} />
    </>
  );
}
