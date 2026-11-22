/** Settings: defaults for new links, folders, blocked domains and abuse reports. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { Button, Callout, Card, ConfirmButton, EmptyState, Field, Input, PageHeader, Pill, Select, Table, formatNumber, timeAgo } from '../../ui';
import { addBlocked, listBlocked, listReports, removeBlocked, resolveReport } from './abuse';
import { flashAndGo, HOME, page, plainError, readForm, safely, text, writer } from './dash-shared';
import { ctxOf } from './ctx';
import { createFolder, deleteFolder, listFolders, renameFolder } from './folders';
import { getSettings, saveSettings } from './settings';

export const settingsScreen = new Hono<AppEnv>();
const SET = `${HOME}/settings`;

settingsScreen.get('/settings', (c) =>
  safely(c, 'Settings', async () => {
    const ctx = ctxOf(c);
    const [settings, folders, blocked, reports] = await Promise.all([getSettings(ctx.env, ctx.orgId), listFolders(ctx), listBlocked(ctx), listReports(ctx, 'all')]);
    const open = reports.filter((r) => r.status === 'open');
    return (
      <>
        <PageHeader title="Settings" description="Defaults, folders and protection against misuse." />
        {open.length ? <Callout tone="warn" title={`${open.length} open ${open.length === 1 ? 'report' : 'reports'}`}>Someone reported a link or bio page. Review it below.</Callout> : null}
        <Card title="Reports" description="People can report any short link from its notice page." flush>
          <Table
            caption="Reports about links"
            columns={[{ key: 'what', label: 'Link' }, { key: 'reason', label: 'Reason' }, { key: 'status', label: 'Status', hideOnMobile: true }, { key: 'actions', label: 'Actions', srOnly: true }]}
            rows={reports.slice(0, 30).map((r) => ({
              what: <div class="lk-cell"><span class="mono">/{r.code}</span>{r.details ? <span class="muted lk-dest">{r.details}</span> : null}<span class="muted lk-dest">{timeAgo(r.created_at)}</span></div>,
              reason: r.reason,
              status: <Pill tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status === 'open' ? 'Open' : r.status === 'dismissed' ? 'Dismissed' : 'Acted on'}</Pill>,
              actions: r.status === 'open' ? (
                <form method="post" action={`${SET}/reports/${r.id}`} class="lk-row-actions">
                  <Button type="submit" name="action" value="dismiss" size="sm">Dismiss</Button>
                  <Button type="submit" name="action" value="disable" size="sm">Disable link</Button>
                  <ConfirmButton id={`rep-${r.id}`} title="Delete the reported link?" body="It stops working and its stats are removed." confirmLabel="Delete link" name="action" value="delete" size="sm">Delete link</ConfirmButton>
                </form>
              ) : null,
            }))}
            empty={<EmptyState icon="shield" title="No reports" body="Nothing has been reported." bare />}
          />
        </Card>
        <Card title="Blocked domains" description="Nobody in this workspace can link to these sites. Links already pointing there are switched off.">
          <form method="post" action={`${SET}/blocklist`} class="lk-quick">
            <label class="sr-only" for="bl-domain">Domain to block</label>
            <Input id="bl-domain" name="domain" placeholder="example.com" required autocomplete="off" autocapitalize="off" spellcheck={false} />
            <Button type="submit">Block domain</Button>
          </form>
          {blocked.length ? (
            <ul class="lk-chips">
              {blocked.map((b) => (
                <li class="chip">
                  <span class="mono">{b.domain}</span>
                  <form method="post" action={`${SET}/blocklist/${b.id}/delete`}><button class="icon-btn sm" type="submit" aria-label={`Unblock ${b.domain}`}>×</button></form>
                </li>
              ))}
            </ul>
          ) : <p class="muted">No blocked domains.</p>}
        </Card>
        <Card title="Defaults for new links">
          <form method="post" action={SET} class="stack">
            <div class="grid-2">
              <Field id="s-rt" label="Redirect type"><Select id="s-rt" name="defaultRedirectType" value={String(settings.defaultRedirectType)} options={[{ value: '302', label: '302 temporary' }, { value: '301', label: '301 permanent' }, { value: '307', label: '307 temporary, keeps the method' }]} /></Field>
              <Field id="s-cl" label="Random code length" hint="5 to 12 characters."><Input id="s-cl" name="codeLength" type="number" min={5} max={12} value={String(settings.codeLength)} /></Field>
            </div>
            <div><Button type="submit" variant="primary">Save defaults</Button></div>
          </form>
        </Card>
        <Card title="Folders" description="Group links. A link lives in one folder.">
          <form method="post" action={`${SET}/folders`} class="lk-quick">
            <label class="sr-only" for="fo-name">Folder name</label>
            <Input id="fo-name" name="name" placeholder="Folder name" maxlength={60} required />
            <Button type="submit">Add folder</Button>
          </form>
          {folders.length ? (
            <ul class="lk-folders">
              {folders.map((f) => (
                <li>
                  <form method="post" action={`${SET}/folders/${f.id}`} class="lk-quick">
                    <label class="sr-only" for={`fo-${f.id}`}>Folder name</label>
                    <Input id={`fo-${f.id}`} name="name" value={f.name} maxlength={60} />
                    <span class="muted">{formatNumber(f.links)} links</span>
                    <Button type="submit" size="sm">Rename</Button>
                    <ConfirmButton id={`fo-del-${f.id}`} title={`Delete “${f.name}”?`} body="The links stay, they just are not in a folder any more." confirmLabel="Delete folder" formAction={`${SET}/folders/${f.id}/delete`} size="sm">Delete</ConfirmButton>
                  </form>
                </li>
              ))}
            </ul>
          ) : <p class="muted">No folders yet.</p>}
        </Card>
        <Callout tone="info" title="Not yet">Custom domains are not part of this version. Short links use this app’s own address.</Callout>
      </>
    );
  }),
);

async function done(c: Parameters<typeof flashAndGo>[0], run: () => Promise<string>): Promise<Response> {
  writer(c);
  try {
    return flashAndGo(c, 'ok', await run(), SET);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, SET);
  }
}

settingsScreen.post('/settings', async (c) => {
  const f = await readForm(c);
  return done(c, async () => {
    await saveSettings(c.env, ctxOf(c).orgId, { defaultRedirectType: Number(text(f, 'defaultRedirectType')), codeLength: text(f, 'codeLength') });
    await auditFromRequest(c, { action: 'links.settings.updated', summary: 'Changed Links defaults', meta: {} });
    return 'Defaults saved.';
  });
});

settingsScreen.post('/settings/folders', async (c) => {
  const f = await readForm(c);
  return done(c, async () => {
    const folder = await createFolder(ctxOf(c), { name: text(f, 'name') });
    await auditFromRequest(c, { action: 'links.folder.created', targetType: 'folder', targetId: folder.id, summary: `Created folder ${folder.name}`, meta: {} });
    return 'Folder added.';
  });
});

settingsScreen.post('/settings/folders/:id', async (c) => {
  const f = await readForm(c);
  return done(c, async () => {
    await renameFolder(ctxOf(c), c.req.param('id'), { name: text(f, 'name') });
    await auditFromRequest(c, { action: 'links.folder.updated', targetType: 'folder', targetId: c.req.param('id'), summary: 'Renamed a folder', meta: {} });
    return 'Folder renamed.';
  });
});

settingsScreen.post('/settings/folders/:id/delete', (c) =>
  done(c, async () => {
    await deleteFolder(ctxOf(c), c.req.param('id'));
    await auditFromRequest(c, { action: 'links.folder.deleted', targetType: 'folder', targetId: c.req.param('id'), summary: 'Deleted a folder', meta: {} });
    return 'Folder deleted.';
  }),
);

settingsScreen.post('/settings/blocklist', async (c) => {
  const f = await readForm(c);
  return done(c, async () => {
    const r = await addBlocked(ctxOf(c), { domain: text(f, 'domain') });
    await auditFromRequest(c, { action: 'links.blocklist.added', targetType: 'blocklist', targetId: r.domain.id, summary: `Blocked ${r.domain.domain}`, meta: { disabledLinks: r.disabledLinks } });
    return `${r.domain.domain} is blocked. ${r.disabledLinks} ${r.disabledLinks === 1 ? 'link was' : 'links were'} switched off.`;
  });
});

settingsScreen.post('/settings/blocklist/:id/delete', (c) =>
  done(c, async () => {
    const back = await removeBlocked(ctxOf(c), c.req.param('id'));
    await auditFromRequest(c, { action: 'links.blocklist.removed', targetType: 'blocklist', targetId: c.req.param('id'), summary: 'Unblocked a domain', meta: { restored: back } });
    return 'Domain unblocked.';
  }),
);

settingsScreen.post('/settings/reports/:id', async (c) => {
  const f = await readForm(c);
  const action = text(f, 'action');
  return done(c, async () => {
    if (action !== 'dismiss' && action !== 'disable' && action !== 'delete') throw new Error('Unknown action');
    await resolveReport(ctxOf(c), c.req.param('id'), action);
    await auditFromRequest(c, { action: `links.report.${action}`, targetType: 'report', targetId: c.req.param('id'), summary: `Report ${action}`, meta: {} });
    return action === 'dismiss' ? 'Report dismissed.' : action === 'disable' ? 'The link is switched off.' : 'The link is deleted.';
  });
});
