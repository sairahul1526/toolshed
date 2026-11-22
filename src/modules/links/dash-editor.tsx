/** One link: the editor with every setting, its QR code, a stats summary, and archive and delete. */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { Button, Callout, Card, ConfirmButton, CopyField, DangerZone, EditorBar, Field, Input, LinkButton, Sparkline, formatNumber } from '../../ui';
import { flashAndGo, HOME, page, plainError, readForm, valuesOf, writer } from './dash-shared';
import { LinkFields, toInput, valuesFromView, type Values } from './dash-form';
import { StatePill } from './dash-links';
import { ctxOf } from './ctx';
import { listFolders } from './folders';
import { deleteLink, getLink, sparklines, updateLink } from './links';

export const editor = new Hono<AppEnv>();

const hex = (s: string | undefined, fallback: string): string => (s && /^[0-9a-fA-F]{6}$/.test(s.replace('#', '')) ? s.replace('#', '').toLowerCase() : fallback);
const int = (s: string | undefined, lo: number, hi: number, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
};

function QrCard({ code, q, id }: { code: string; q: Record<string, string>; id: string }) {
  const fg = hex(q.qr_fg, '000000');
  const bg = hex(q.qr_bg, 'ffffff');
  const margin = int(q.qr_margin, 0, 10, 2);
  const size = int(q.qr_size, 96, 2048, 512);
  const params = `fg=${fg}&bg=${bg}&margin=${margin}&size=${size}`;
  return (
    <Card title="QR code" description="Scans count as clicks and show up as QR scans in your stats." id="qr">
      <div class="lk-ready">
        <form method="get" action={`${HOME}/${id}`} class="lk-ready-main stack">
          <div class="grid-2">
            <Field id="qr-fg" label="Dots colour"><input id="qr-fg" class="input lk-color" type="color" name="qr_fg" value={`#${fg}`} /></Field>
            <Field id="qr-bg" label="Background colour"><input id="qr-bg" class="input lk-color" type="color" name="qr_bg" value={`#${bg}`} /></Field>
          </div>
          <div class="grid-2">
            <Field id="qr-m" label="Margin" hint="Quiet border, 0 to 10 squares."><Input id="qr-m" name="qr_margin" type="number" min={0} max={10} value={String(margin)} /></Field>
            <Field id="qr-s" label="Size in pixels" hint="96 to 2048."><Input id="qr-s" name="qr_size" type="number" min={96} max={2048} step={16} value={String(size)} /></Field>
          </div>
          <div class="lk-actions">
            <Button type="submit">Update preview</Button>
            <LinkButton href={`/l/qr/${code}?${params}&download=1`} icon="download">Download SVG</LinkButton>
            <Button data-qr-png={`/l/qr/${code}?${params}`} data-qr-name={`${code}-qr.png`} icon="download">Download PNG</Button>
          </div>
        </form>
        <img class="lk-qr" src={`/l/qr/${code}?${params}`} width="160" height="160" alt={`QR code for /${code}`} />
      </div>
    </Card>
  );
}

async function show(c: Context<AppEnv>, idOrCode: string, override?: { v: Values; errors: Record<string, string> }, status?: 422) {
  const ctx = ctxOf(c);
  const [link, folders] = await Promise.all([getLink(ctx, idOrCode), listFolders(ctx)]);
  const trend = (await sparklines(ctx, [link.id], 30)).get(link.id) ?? [];
  const month = trend.reduce((a, b) => a + b, 0);
  const v = override?.v ?? valuesFromView(link);
  const errors = override?.errors ?? {};
  const title = link.title || `/${link.code}`;
  const body = (
    <>
      <EditorBar
        back={{ href: HOME, label: 'Links' }}
        title={title}
        status={<StatePill state={link.state} />}
        actions={
          <>
            <LinkButton href={link.shortUrl} target="_blank" rel="noopener" icon="out" size="sm">Open</LinkButton>
            <Button type="submit" form="link-form" variant="primary">Save changes</Button>
          </>
        }
      />
      {link.state === 'disabled' ? <Callout tone="bad" title="This link is disabled">{link.disabledReason ?? 'It was switched off.'} Change the destination to a safe address to bring it back.</Callout> : null}
      {Object.keys(errors).length ? <Callout tone="bad" title="Some fields need fixing">Check the highlighted fields below.</Callout> : null}
      <Card title="Share it" description="Anyone with this address is sent to the destination.">
        <CopyField label="short link" value={link.shortUrl} />
        <div class="lk-month">
          <div><b>{formatNumber(link.clicks)}</b> <span class="muted">clicks in total</span></div>
          <div class="lk-month-chart"><Sparkline values={trend} label={`Clicks per day for /${link.code}, last 30 days`} /></div>
          <div><b>{formatNumber(month)}</b> <span class="muted">in the last 30 days</span></div>
          <LinkButton href={`${HOME}/stats?link=${link.id}`} icon="chart" size="sm">See stats</LinkButton>
        </div>
      </Card>
      <form id="link-form" method="post" action={`${HOME}/${link.id}`}>
        <LinkFields v={v} errors={errors} folders={folders} base={ctx.base} hasPassword={link.hasPassword} editing />
      </form>
      <QrCard code={link.code} q={c.req.query()} id={link.id} />
      <form method="post" action={`${HOME}/${link.id}/archive`}>
        <DangerZone
          items={[
            { title: link.status === 'archived' ? 'Restore this link' : 'Archive this link', description: link.status === 'archived' ? 'It starts working again right away.' : 'It stops working, but you keep its history and can restore it.', action: <Button type="submit" formAction={`${HOME}/${link.id}/${link.status === 'archived' ? 'restore' : 'archive'}`}>{link.status === 'archived' ? 'Restore' : 'Archive'}</Button> },
            { title: 'Duplicate this link', description: 'Make a copy with a new random code.', action: <Button type="submit" formAction={`${HOME}/${link.id}/duplicate`}>Duplicate</Button> },
            { title: 'Delete this link', description: 'The short link stops working and its click history is removed. This can’t be undone.', action: <ConfirmButton id="delete-link" title="Delete this link?" body={`/${link.code} will stop working for everyone and its stats are removed.`} confirmLabel="Delete link" formAction={`${HOME}/${link.id}/delete`} variant="danger" icon="trash">Delete</ConfirmButton> },
          ]}
        />
      </form>
    </>
  );
  return page(c, title, body, [{ label: 'Links', href: HOME }, { label: title }], status);
}

editor.get('/:id', (c) => show(c, c.req.param('id')));

editor.post('/:id', async (c) => {
  writer(c);
  const f = await readForm(c);
  const id = c.req.param('id');
  try {
    const link = await updateLink(ctxOf(c), id, toInput(f, true));
    await auditFromRequest(c, { action: 'links.link.updated', targetType: 'link', targetId: link.id, summary: `Updated /${link.code}`, meta: { code: link.code } });
    return flashAndGo(c, 'ok', 'Saved.', `${HOME}/${link.id}`);
  } catch (e) {
    const { fields, message } = plainError(e);
    return show(c, id, { v: valuesOf(f), errors: Object.keys(fields).length ? fields : { url: message } }, 422);
  }
});

editor.post('/:id/delete', async (c) => {
  writer(c);
  const gone = await deleteLink(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.link.deleted', targetType: 'link', targetId: gone.id, summary: `Deleted /${gone.code}`, meta: { code: gone.code } });
  return flashAndGo(c, 'ok', `Deleted /${gone.code}.`, HOME);
});
