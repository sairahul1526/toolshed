/** Bio pages: a list, and an editor for the profile, colours and blocks. Blocks have up and down buttons, so no script is needed. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import type { FieldErrors } from '../../core/errors';
import {
  Button, Callout, Card, Checkbox, ConfirmButton, CopyField, DangerZone, EditorBar, EmptyState, Field, Input, LinkButton, PageHeader, Pill, Segmented, Select, Table, Textarea, formatNumber,
} from '../../ui';
import type { Context } from 'hono';
import { addBlock, createBio, deleteBio, deleteBlock, getBio, listBios, moveBlock, PLATFORMS, updateBio, updateBlock, type BioView, type BlockView } from './bios';
import { checked, flashAndGo, HOME, page, plainError, readForm, safely, text, valuesOf, writer, type Form } from './dash-shared';
import { ctxOf } from './ctx';

export const bioScreen = new Hono<AppEnv>();
const BIO = `${HOME}/bio`;

const KINDS = [
  { value: 'link', label: 'Link button' },
  { value: 'heading', label: 'Heading' },
  { value: 'text', label: 'Text' },
  { value: 'social', label: 'Social link' },
];
const PLATFORM_OPTIONS = PLATFORMS.map((p) => ({ value: p, label: p === 'x' ? 'X' : p[0]!.toUpperCase() + p.slice(1) }));

bioScreen.get('/bio', (c) =>
  safely(c, 'Bio pages', async () => {
    const ctx = ctxOf(c);
    const bios = await listBios(ctx);
    return (
      <>
        <PageHeader title="Bio pages" description="One page of links for your profile. It loads fast and works without JavaScript." />
        <Card title="New bio page" description="Pick a name. You can add links after.">
          <form method="post" action={BIO} class="lk-quick">
            <label class="sr-only" for="b-name">Name</label>
            <Input id="b-name" name="name" required maxlength={80} placeholder="Your name or brand" autocomplete="off" />
            <label class="sr-only" for="b-code">Address</label>
            <Input id="b-code" name="code" maxlength={64} placeholder="address (optional)" prefix={`${ctx.base.replace(/^https?:\/\//, '')}/`} autocomplete="off" autocapitalize="off" spellcheck={false} />
            <Button type="submit" variant="primary">Create</Button>
          </form>
        </Card>
        <Card flush>
          <Table
            caption="Bio pages"
            columns={[{ key: 'name', label: 'Page' }, { key: 'status', label: 'Status', hideOnMobile: true }, { key: 'blocks', label: 'Blocks', numeric: true }, { key: 'views', label: 'Views', numeric: true }]}
            rows={bios.map((b) => ({
              name: <div class="lk-cell"><a class="lk-name" href={`${BIO}/${b.id}`}>{b.name || `/${b.code}`}</a><span class="mono muted lk-short">{b.shortUrl.replace(/^https?:\/\//, '')}</span></div>,
              status: <Pill tone={b.published ? 'good' : 'neutral'}>{b.published ? 'Published' : 'Draft'}</Pill>,
              blocks: formatNumber(b.blockCount),
              views: formatNumber(b.views),
            }))}
            empty={<EmptyState icon="user" title="No bio pages yet" body="Make one page that holds all your links, then share it in your profile." bare />}
          />
        </Card>
      </>
    );
  }),
);

bioScreen.post('/bio', async (c) => {
  writer(c);
  const f = await readForm(c);
  try {
    const bio = await createBio(ctxOf(c), { name: text(f, 'name'), code: text(f, 'code') || undefined });
    await auditFromRequest(c, { action: 'links.bio.created', targetType: 'bio', targetId: bio.id, summary: `Created bio page /${bio.code}`, meta: { code: bio.code } });
    return flashAndGo(c, 'ok', 'Bio page created. Add your first link below.', `${BIO}/${bio.id}`);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, BIO);
  }
});

function BlockForm({ b, first, last }: { b: BlockView; first: boolean; last: boolean }) {
  const action = `${BIO}/blocks/${b.id}`;
  const label = b.title || b.url || b.body.slice(0, 30) || 'block';
  return (
    <li class="lk-block">
      <form method="post" action={action}>
        <div class="lk-block-head">
          <b>{KINDS.find((k) => k.value === b.kind)?.label}</b>
          <span class="muted">{formatNumber(b.clicks)} clicks in 30 days</span>
        </div>
        <input type="hidden" name="kind" value={b.kind} />
        <div class="grid-2">
          {b.kind === 'text' ? null : <Field id={`bt-${b.id}`} label={b.kind === 'social' ? 'Label' : 'Title'} optional={b.kind === 'social'}><Input id={`bt-${b.id}`} name="title" value={b.title} maxlength={120} /></Field>}
          {b.kind === 'link' || b.kind === 'social' ? <Field id={`bu-${b.id}`} label="Address"><Input id={`bu-${b.id}`} name="url" value={b.url} /></Field> : null}
          {b.kind === 'social' ? <Field id={`bp-${b.id}`} label="Platform"><Select id={`bp-${b.id}`} name="platform" value={b.platform} options={PLATFORM_OPTIONS} /></Field> : null}
        </div>
        {b.kind === 'text' ? <Field id={`bb-${b.id}`} label="Text"><Textarea id={`bb-${b.id}`} name="body" rows={2} value={b.body} maxlength={1000} /></Field> : null}
        <div class="lk-block-actions">
          <Checkbox name="visible" label="Show on the page" checked={b.visible} />
          <span class="lk-spacer" />
          <Button type="submit" formAction={`${action}/move?dir=up`} size="sm" disabled={first} aria-label={`Move ${label} up`} icon="left">Up</Button>
          <Button type="submit" formAction={`${action}/move?dir=down`} size="sm" disabled={last} aria-label={`Move ${label} down`} icon="right">Down</Button>
          <Button type="submit" size="sm" variant="primary">Save</Button>
          <ConfirmButton id={`rm-${b.id}`} title="Remove this block?" body="It disappears from the page and its click count is removed." confirmLabel="Remove" formAction={`${action}/delete`} size="sm" icon="trash">Remove</ConfirmButton>
        </div>
      </form>
    </li>
  );
}

async function bioEditor(c: Context<AppEnv>, id: string, override?: { v: Record<string, string>; errors: FieldErrors }, status?: 422) {
  const ctx = ctxOf(c);
  const bio = await getBio(ctx, id);
  const v = override?.v ?? profileValues(bio);
  const errors = override?.errors ?? {};
  const custom = (v.theme ?? 'workspace') === 'custom';
  return page(c, bio.name || 'Bio page', (
    <>
      <EditorBar
        back={{ href: BIO, label: 'Bio pages' }}
        title={bio.name || `/${bio.code}`}
        status={<Pill tone={bio.published ? 'good' : 'neutral'}>{bio.published ? 'Published' : 'Draft'}</Pill>}
        actions={<><LinkButton href={bio.shortUrl} target="_blank" rel="noopener" size="sm" icon="out">Open</LinkButton><Button type="submit" form="bio-form" variant="primary">Save profile</Button></>}
      />
      {Object.keys(errors).length ? <Callout tone="bad" title="Some fields need fixing">Check the highlighted fields below.</Callout> : null}
      <Card title="Share it" description={`${formatNumber(bio.views)} views in total.`}><CopyField label="bio page address" value={bio.shortUrl} /></Card>
      <form id="bio-form" method="post" action={`${BIO}/${bio.id}`} class="lk-sections">
        <Card title="Profile">
          <div class="stack">
            <div class="grid-2">
              <Field id="p-name" label="Name" error={errors.name}><Input id="p-name" name="name" value={v.name ?? ''} maxlength={80} /></Field>
              <Field id="p-avatar" label="Picture address" optional hint="A public https address. It is the only outside image a bio page loads." error={errors.avatarUrl}><Input id="p-avatar" name="avatarUrl" type="url" value={v.avatarUrl ?? ''} /></Field>
            </div>
            <Field id="p-bio" label="About" optional><Textarea id="p-bio" name="bio" rows={2} value={v.bio ?? ''} maxlength={500} /></Field>
            <Checkbox name="published" label="Published: anyone with the address can see it" checked={v.published === 'on'} />
          </div>
        </Card>
        <Card title="Look" description="Use the workspace colours, or choose your own.">
          <div class="stack">
            <Segmented name="theme" label="Colours" value={v.theme ?? 'workspace'} options={[{ value: 'workspace', label: 'Workspace colours' }, { value: 'custom', label: 'My own colours' }]} />
            <div class="grid-2">
              {([['background', 'Background'], ['text', 'Text'], ['accent', 'Buttons'], ['buttonText', 'Button text']] as const).map(([k, label]) => (
                <Field id={`c-${k}`} label={label} error={errors[`colors.${k}`] ?? errors.colors}><input id={`c-${k}`} class="input lk-color" type="color" name={`color_${k}`} value={v[`color_${k}`] ?? '#000000'} /></Field>
              ))}
            </div>
            {!custom ? <p class="muted lk-small">Your own colours are saved but only used when you pick “My own colours”.</p> : null}
          </div>
        </Card>
        <Card title="Search and sharing" description="How the page looks in search results and chat previews.">
          <div class="stack">
            <Field id="s-t" label="Title" optional><Input id="s-t" name="seoTitle" value={v.seoTitle ?? ''} maxlength={120} /></Field>
            <Field id="s-d" label="Description" optional><Textarea id="s-d" name="seoDescription" rows={2} value={v.seoDescription ?? ''} maxlength={300} /></Field>
            <Field id="s-i" label="Preview image address" optional><Input id="s-i" name="seoImage" type="url" value={v.seoImage ?? ''} /></Field>
            <Checkbox name="noindex" label="Ask search engines not to list this page" checked={v.noindex === 'on'} />
          </div>
        </Card>
      </form>
      <Card title="Blocks" description="Shown in this order. Each block counts its own clicks.">
        {bio.blocks.length ? <ol class="lk-blocks">{bio.blocks.map((b, i) => <BlockForm b={b} first={i === 0} last={i === bio.blocks.length - 1} />)}</ol> : <EmptyState icon="list" title="No blocks yet" body="Add a link, heading, text or social link below." bare />}
        <form method="post" action={`${BIO}/${bio.id}/blocks`} class="lk-add">
          <h3>Add a block</h3>
          <div class="grid-2">
            <Field id="n-kind" label="Type"><Select id="n-kind" name="kind" options={KINDS} value="link" /></Field>
            <Field id="n-title" label="Title" optional><Input id="n-title" name="title" maxlength={120} /></Field>
            <Field id="n-url" label="Address" optional hint="For links and social links."><Input id="n-url" name="url" type="url" /></Field>
            <Field id="n-plat" label="Platform" optional hint="For social links."><Select id="n-plat" name="platform" options={PLATFORM_OPTIONS} value="website" /></Field>
          </div>
          <Field id="n-body" label="Text" optional hint="For text blocks."><Textarea id="n-body" name="body" rows={2} maxlength={1000} /></Field>
          <Button type="submit" icon="plus">Add block</Button>
        </form>
      </Card>
      <form method="post" action={`${BIO}/${bio.id}/delete`}>
        <DangerZone items={[{ title: 'Delete this bio page', description: 'The address stops working and its blocks and views are removed. This can’t be undone.', action: <ConfirmButton id="delete-bio" title="Delete this bio page?" body={`/${bio.code} will stop working for everyone.`} confirmLabel="Delete page" icon="trash">Delete</ConfirmButton> }]} />
      </form>
    </>
  ), [{ label: 'Links', href: HOME }, { label: 'Bio pages', href: BIO }, { label: bio.name || bio.code }], status);
}

function profileValues(b: BioView): Record<string, string> {
  const v: Record<string, string> = {
    name: b.name, bio: b.bio, avatarUrl: b.avatarUrl, theme: b.theme, seoTitle: b.seo.title, seoDescription: b.seo.description, seoImage: b.seo.image,
    color_background: b.colors.background, color_text: b.colors.text, color_accent: b.colors.accent, color_buttonText: b.colors.buttonText,
  };
  if (b.published) v.published = 'on';
  if (b.noindex) v.noindex = 'on';
  return v;
}

const profileInput = (f: Form) => ({
  name: text(f, 'name'), bio: text(f, 'bio'), avatarUrl: text(f, 'avatarUrl'), theme: text(f, 'theme') === 'custom' ? 'custom' : 'workspace',
  published: checked(f, 'published'), noindex: checked(f, 'noindex'),
  colors: { background: text(f, 'color_background'), text: text(f, 'color_text'), accent: text(f, 'color_accent'), buttonText: text(f, 'color_buttonText') },
  seo: { title: text(f, 'seoTitle'), description: text(f, 'seoDescription'), image: text(f, 'seoImage') },
});

const blockInputOf = (f: Form) => ({
  kind: text(f, 'kind'), title: text(f, 'title'), url: text(f, 'url'), body: text(f, 'body'),
  ...(text(f, 'platform') ? { platform: text(f, 'platform') } : {}), visible: checked(f, 'visible'),
});

// Block routes first: "blocks" must not be read as a page id.
bioScreen.post('/bio/blocks/:blockId', async (c) => {
  writer(c);
  const f = await readForm(c);
  const { blockId } = c.req.param();
  try {
    const block = await updateBlock(ctxOf(c), blockId, blockInputOf(f));
    await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio_block', targetId: block.id, summary: 'Updated a bio block', meta: {} });
    return flashAndGo(c, 'ok', 'Block saved.', back(c));
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, back(c));
  }
});

const back = (c: Context<AppEnv>): string => {
  const ref = c.req.header('referer');
  try {
    const u = new URL(ref ?? '');
    return u.pathname.startsWith(BIO) ? u.pathname : BIO;
  } catch {
    return BIO;
  }
};

bioScreen.post('/bio/blocks/:blockId/move', async (c) => {
  writer(c);
  await moveBlock(ctxOf(c), c.req.param('blockId'), c.req.query('dir') === 'up' ? 'up' : 'down');
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio_block', targetId: c.req.param('blockId'), summary: 'Reordered bio blocks', meta: {} });
  return c.redirect(back(c), 303);
});

bioScreen.post('/bio/blocks/:blockId/delete', async (c) => {
  writer(c);
  await deleteBlock(ctxOf(c), c.req.param('blockId'));
  await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio_block', targetId: c.req.param('blockId'), summary: 'Removed a bio block', meta: {} });
  return flashAndGo(c, 'ok', 'Block removed.', back(c));
});

bioScreen.get('/bio/:id', (c) => bioEditor(c, c.req.param('id')));

bioScreen.post('/bio/:id', async (c) => {
  writer(c);
  const f = await readForm(c);
  const id = c.req.param('id');
  try {
    const bio = await updateBio(ctxOf(c), id, profileInput(f));
    await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio', targetId: bio.id, summary: `Updated bio page /${bio.code}`, meta: { code: bio.code } });
    return flashAndGo(c, 'ok', 'Saved.', `${BIO}/${bio.id}`);
  } catch (e) {
    const { fields, message } = plainError(e);
    return bioEditor(c, id, { v: valuesOf(f), errors: Object.keys(fields).length ? fields : { name: message } }, 422);
  }
});

bioScreen.post('/bio/:id/blocks', async (c) => {
  writer(c);
  const f = await readForm(c);
  const id = c.req.param('id');
  try {
    await addBlock(ctxOf(c), id, { ...blockInputOf(f), visible: true });
    await auditFromRequest(c, { action: 'links.bio.updated', targetType: 'bio', targetId: id, summary: 'Added a bio block', meta: {} });
    return flashAndGo(c, 'ok', 'Block added.', `${BIO}/${id}`);
  } catch (e) {
    return flashAndGo(c, 'error', plainError(e).message, `${BIO}/${id}`);
  }
});

bioScreen.post('/bio/:id/delete', async (c) => {
  writer(c);
  await deleteBio(ctxOf(c), c.req.param('id'));
  await auditFromRequest(c, { action: 'links.bio.deleted', targetType: 'bio', targetId: c.req.param('id'), summary: 'Deleted a bio page', meta: {} });
  return flashAndGo(c, 'ok', 'Bio page deleted.', BIO);
});
