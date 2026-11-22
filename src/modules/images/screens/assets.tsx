/** Uploaded pictures and fonts: upload, copy the address, delete. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import { errors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, ConfirmButton, EmptyState, Field, PageHeader, Table, Tabs, formatBytes, timeAgo } from '../../../ui';
import { deleteAsset, listAssets, uploadAsset, MAX_ASSETS, type Asset } from '../assets';
import { HOME, More, canWrite, fileIn, flashAndGo, page, plainError, query, readForm, writer, type Ctx } from '../dash-shared';
import { scopeOf } from '../http';
import { MAX_FONT_BYTES } from '../render';

type Kind = 'image' | 'font';

function about(asset: Asset): string {
  if (asset.font) return `${asset.font.family}, weight ${asset.font.weight}${asset.font.variable ? ' (variable font, drawn at its default weight)' : ''}`;
  return asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Picture';
}

async function assetsPage(c: Ctx, state: { message?: string; error?: string } = {}): Promise<Response> {
  const s = scopeOf(c);
  const write = canWrite(c);
  const kind: Kind = c.req.query('kind') === 'font' ? 'font' : 'image';
  const cursor = c.req.query('cursor');
  const list = await listAssets(s.db, { kind, limit: 24, cursor: cursor ?? null });

  const rows = list.items.map((asset) => ({
    preview: asset.kind === 'image' ? <img class="img-thumb small" src={asset.path} alt="" width={asset.width ?? undefined} height={asset.height ?? undefined} loading="lazy" /> : <span class="img-fontmark" aria-hidden="true">Aa</span>,
    name: (
      <div class="img-cell">
        <span class="img-name">{asset.name}</span>
        <span class="muted img-small">{about(asset)}</span>
      </div>
    ),
    size: formatBytes(asset.bytes),
    added: timeAgo(new Date(asset.createdAt)),
    actions: (
      <span class="img-actions">
        <Button size="sm" icon="copy" data-copy={asset.kind === 'image' ? asset.ref : `${s.base}${asset.path}`} data-copied={asset.kind === 'image' ? 'Copied. Paste it into a picture layer or a picture field.' : 'File address copied.'}>
          {asset.kind === 'image' ? 'Copy reference' : 'Copy address'}
        </Button>
        {write ? (
          <form method="post" action={`${HOME}/assets/${asset.id}/delete${query({ kind })}`}>
            <ConfirmButton
              id={`del-${asset.id}`}
              size="sm"
              icon="trash"
              title={`Delete ${asset.name}?`}
              body={asset.kind === 'font' ? 'Templates that use this font fall back to Inter. Images already made keep their look.' : 'Templates that use this picture show an empty box where it was. Images already made keep their look.'}
              confirmLabel="Delete file"
            >
              Delete
            </ConfirmButton>
          </form>
        ) : null}
      </span>
    ),
  }));

  return page(c, 'Assets', (
    <>
      <PageHeader title="Assets" description="Your own pictures and fonts, for use in templates." />
      {state.message ? <Callout tone="bad" title="Not uploaded">{state.message}</Callout> : null}
      {write ? (
        <Card title="Upload a file" description={`A PNG, JPEG, WebP or GIF picture up to 2 MB, or a TrueType (.ttf) font up to ${Math.round(MAX_FONT_BYTES / (1024 * 1024))} MB. ${MAX_ASSETS} files at most.`}>
          <form method="post" action={`${HOME}/assets${query({ kind })}`} enctype="multipart/form-data" class="form">
            <Field id="asset-file" label="File" error={state.error} hint="Anyone who has a file’s address can download it, so do not upload anything private.">
              <input class="input" id="asset-file" type="file" name="file" required accept="image/png,image/jpeg,image/webp,image/gif,.ttf,font/ttf" aria-invalid={state.error ? 'true' : undefined} />
            </Field>
            <div class="img-row">
              <Button type="submit" variant="primary" icon="upload">Upload</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <Tabs
        label="Kind of file"
        active={kind}
        items={[
          { id: 'image', label: 'Pictures', href: `${HOME}/assets` },
          { id: 'font', label: 'Fonts', href: `${HOME}/assets?kind=font` },
        ]}
      />
      {rows.length === 0 && !cursor ? (
        <EmptyState
          icon={kind === 'font' ? 'type' : 'image'}
          title={kind === 'font' ? 'No fonts yet' : 'No pictures yet'}
          body={kind === 'font' ? 'Templates can use Inter, Libre Baskerville and JetBrains Mono without any upload. Upload a .ttf file to use your own.' : write ? 'Upload a logo or a photo, then pick it in a picture layer.' : 'Workspace members can upload logos and photos here.'}
        />
      ) : (
        <Table
          caption={kind === 'font' ? 'Fonts' : 'Pictures'}
          columns={[
            { key: 'preview', label: 'Preview', srOnly: true },
            { key: 'name', label: 'File' },
            { key: 'size', label: 'Size', numeric: true },
            { key: 'added', label: 'Added', hideOnMobile: true },
            { key: 'actions', label: 'Actions', srOnly: true },
          ]}
          rows={rows}
        />
      )}
      <More href={list.nextCursor ? `${HOME}/assets${query({ kind, cursor: list.nextCursor })}` : null} label="Show more files" />
    </>
  ), { status: state.message ? 422 : 200 });
}

const assets = new Hono<AppEnv>();

assets.get('/assets', (c) => assetsPage(c));

assets.post('/assets', async (c) => {
  writer(c);
  const s = scopeOf(c);
  try {
    const file = fileIn(await readForm(c), 'file');
    if (!file) throw errors.validation_failed('Choose a file to upload.', { file: 'Choose a file to upload.' });
    if (file.size > MAX_FONT_BYTES) throw errors.too_large('That file is too large. Pictures can be 2 MB and fonts 5 MB.');
    const asset = await uploadAsset(s.env, s.db, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, s.actor);
    await auditFromRequest(c, { action: 'images.asset.uploaded', targetType: 'image_asset', targetId: asset.id, summary: `Uploaded the ${asset.kind === 'font' ? 'font' : 'picture'} "${asset.name}"` });
    return flashAndGo(c, 'ok', asset.font ? `Uploaded. Pick “${asset.font.family}” as the font of a text layer.` : 'Uploaded. Pick it in a picture layer.', `${HOME}/assets${query({ kind: asset.kind === 'font' ? 'font' : undefined })}`);
  } catch (err) {
    const { message, fields } = plainError(err);
    return assetsPage(c, { message, error: fields.file ?? message });
  }
});

assets.post('/assets/:id/delete', async (c) => {
  writer(c);
  const s = scopeOf(c);
  const back = `${HOME}/assets${query({ kind: c.req.query('kind') === 'font' ? 'font' : undefined })}`;
  try {
    const asset = await deleteAsset(s.env, s.db, c.req.param('id'));
    await auditFromRequest(c, { action: 'images.asset.deleted', targetType: 'image_asset', targetId: asset.id, summary: `Deleted the ${asset.kind === 'font' ? 'font' : 'picture'} "${asset.name}"` });
    return flashAndGo(c, 'ok', `Deleted ${asset.name}.`, back);
  } catch (err) {
    return flashAndGo(c, 'error', plainError(err).message, back);
  }
});

export { assets };
