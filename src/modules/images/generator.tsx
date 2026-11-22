/**
 * The public generator page of a template: /i/<slug>/make.
 *
 * A visitor fills in the template's fields, sees the image change and downloads it. The image is
 * drawn in the visitor's own browser, so making one costs the workspace nothing and stores nothing.
 * The page never hands out a signed URL for text a visitor typed: that would let anyone turn the
 * workspace's signature into a free image service.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { orgDb, parseJson } from '../../core/db';
import { errors } from '../../core/errors';
import { baseUrl } from '../../core/net';
import { moduleState } from '../../core/registry';
import { getSetting } from '../../core/settings';
import type { AppEnv } from '../../env';
import { parseAppearance, PublicCard, PublicField, PublicInput, PublicPage } from '../../ui';
import { customFamilies } from './render';
import type { TemplateDoc } from './schema';
import { getSettings } from './settings';
import { SLUG, type TemplateRow } from './templates';
import { imageUrl } from './urls';

const PAGE_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const HEX6 = /^#[0-9a-f]{6}$/i;

type Ctx = Context<AppEnv>;
type PageRow = Pick<TemplateRow, 'org_id' | 'slug' | 'name' | 'open' | 'page' | 'published_doc'>;

interface Found {
  row: PageRow;
  doc: TemplateDoc;
}

/** The template behind a generator page, or a 404 when the page is off, unpublished or the module is off. */
async function find(c: Ctx): Promise<Found> {
  const slug = c.req.param('slug') ?? '';
  const none = errors.not_found('There is no image maker at this address.');
  if (!SLUG.test(slug)) throw none;
  const row = await c.env.DB.prepare('SELECT org_id, slug, name, open, page, published_doc FROM img_templates WHERE slug = ?1').bind(slug).first<PageRow>();
  if (!row || row.page !== 1 || row.published_doc === null) throw none;
  if (!(await moduleState(c.env, row.org_id, 'images')).enabled) throw none;
  const doc = parseJson<TemplateDoc | null>(row.published_doc, null);
  if (!doc) throw none;
  return { row, doc };
}

const generator = new Hono<AppEnv>();

/** The design and the uploaded fonts it uses, for the page's script. Kept out of the HTML so the page stays small. */
generator.get('/i/:slug/make.json', async (c) => {
  const { row, doc } = await find(c);
  const usesUpload = doc.layers.some((layer) => layer.type === 'text' && layer.font?.startsWith('c:'));
  const custom = usesUpload ? await customFamilies(orgDb(c.env.DB, row.org_id)) : [];
  return c.json({ slug: row.slug, name: row.name, doc, custom }, 200, { 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' });
});

generator.get('/i/:slug/make', async (c) => {
  const { row, doc } = await find(c);
  const [look, settings] = await Promise.all([getSetting<Record<string, unknown>>(c.env, row.org_id, 'appearance', {}), getSettings(c.env, row.org_id)]);
  const base = baseUrl(c);
  const open = row.open === 1;
  // The picture a visitor sees before any script runs: the template with its own sample text.
  const first = await imageUrl(c.env, base, row.slug, 'svg', { unsigned: open });
  // A link preview needs PNG, which only exists when this workspace draws PNG on the server.
  const card = settings.serverPng ? await imageUrl(c.env, base, row.slug, 'png', { unsigned: open }) : null;
  const fields = doc.fields.filter((field) => field.type !== 'image');
  const description = `Fill in ${fields.length === 1 ? 'one box' : 'a few boxes'} and download a ${doc.width} × ${doc.height} image.`;

  c.header('content-security-policy', PAGE_CSP);
  c.header('referrer-policy', 'no-referrer');
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  return c.html(
    <PublicPage title={row.name} appearance={parseAppearance(look)} wide description={description} styles={['/m/images/images-public.css']}>
      <meta property="og:title" content={row.name} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content="website" />
      <meta property="og:url" content={`${base}/i/${row.slug}/make`} />
      {card ? <meta property="og:image" content={card} /> : null}
      {card ? <meta name="twitter:card" content="summary_large_image" /> : null}
      <PublicCard class="img-make">
        <h1>{row.name}</h1>
        <p class="pub-note">{fields.length ? 'Change the text and the picture updates. Then download it.' : 'Download this image as a PNG or an SVG file.'}</p>
        <div class="img-make-stage">
          <img class="img-make-preview" data-make-preview src={first} width={doc.width} height={doc.height} alt={`Preview of ${row.name}`} />
        </div>
        <p class="pub-hint" role="status" data-make-status></p>
        {/* Without a script an open template still works: the form goes straight to the image address. */}
        <form method="get" action={open ? `/i/${row.slug}.svg` : `/i/${row.slug}/make`} data-make-form data-images-make data-json={`/i/${row.slug}/make.json`} data-slug={row.slug} data-name={row.slug}>
          {fields.map((field) => {
            const id = `make-${field.name}`;
            const label = field.label || field.name;
            if (field.type === 'color') {
              const picker = HEX6.test(field.default);
              return (
                <PublicField id={id} label={label} hint={picker ? undefined : 'A colour such as #1d4ed8.'}>
                  <input class={picker ? 'img-make-color' : 'pub-input'} id={id} name={field.name} type={picker ? 'color' : 'text'} value={field.default} maxlength={picker ? undefined : 9} data-make-field />
                </PublicField>
              );
            }
            return (
              <PublicField id={id} label={label}>
                <PublicInput id={id} name={field.name} value={field.default} maxlength={Math.min(500, field.maxLength ?? 500)} />
              </PublicField>
            );
          })}
          <div class="img-make-actions">
            <button class="pub-btn" type="button" data-make-png hidden>Download PNG</button>
            <button class="pub-btn ghost" type="button" data-make-svg hidden>Download SVG</button>
            {open && fields.length ? <button class="pub-btn" type="submit" data-make-plain>Open the image</button> : null}
          </div>
          <noscript>
            <p class="pub-note">{open ? 'With JavaScript on, the picture updates as you type and you can download a PNG.' : 'Turn on JavaScript to change the text and download the image.'}</p>
          </noscript>
        </form>
      </PublicCard>
      <script type="module" src="/m/images/make.js"></script>
    </PublicPage>,
  );
});

export { generator };
