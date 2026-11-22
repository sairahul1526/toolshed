/**
 * The "Use" page of a template. As the fields change it redraws the preview in the browser,
 * asks the server for a fresh signed URL, and keeps every copy button in step. "Make a PNG" draws
 * the image on a canvas and stores it, which is how share images work on the free Workers plan.
 * Without this script the page still works: the form reloads it with the new values.
 */
import { call, createStudio, debounce, showSvg, svgToPng } from './studio.js';

const root = document.querySelector('[data-images-share]');
if (root) start(root);

function start(root) {
  const form = root.querySelector('[data-share-form]');
  const preview = root.querySelector('[data-share-preview]');
  const status = root.querySelector('[data-share-status]');
  const api = root.dataset.api;
  const id = root.dataset.template;
  const doc = JSON.parse(root.dataset.doc);
  const canWrite = root.dataset.canWrite === '1';
  const serverPng = root.dataset.serverPng === '1';
  const studio = createStudio({
    custom: JSON.parse(root.dataset.custom || '[]'),
    // Only members may ask the server for an outside picture, so a viewer keeps the server-drawn preview.
    picture: canWrite ? (src) => `${api}/picture?src=${encodeURIComponent(src)}` : undefined,
  });
  /** The latest request of each kind wins; an older answer that arrives late is dropped. */
  let drawTurn = 0;
  let linkTurn = 0;
  let baked = false;

  const say = (text, bad) => {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('field-error', Boolean(bad));
    status.classList.toggle('muted', !bad);
  };

  function values() {
    const out = {};
    for (const input of form.querySelectorAll('[data-field]')) out[input.dataset.field] = input.value;
    return out;
  }

  function options() {
    const data = new FormData(form);
    const width = parseInt(String(data.get('width') || ''), 10);
    const expires = parseInt(String(data.get('expires') || ''), 10);
    return {
      format: data.get('format') === 'png' ? 'png' : 'svg',
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      expiresIn: Number.isFinite(expires) && expires > 0 ? expires : undefined,
      pin: data.get('pin') === '1',
      unsigned: data.get('unsigned') === '1',
    };
  }

  /** The same address the form would load, so a reload or a shared link shows the same values. */
  function pageQuery() {
    const query = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (typeof value === 'string' && value !== '') query.set(key, value);
    return query;
  }

  function serverPreview() {
    const query = new URLSearchParams({ live: '1' });
    for (const [name, value] of Object.entries(values())) query.set(`f.${name}`, value);
    preview.src = `${location.pathname}/preview.svg?${query}`;
  }

  async function redraw() {
    const turn = ++drawTurn;
    if (!canWrite) return serverPreview();
    try {
      const result = await studio.draw(doc, values());
      if (turn === drawTurn) showSvg(preview, result.svg);
    } catch {
      if (turn === drawTurn) serverPreview();
    }
  }

  function setCode(holder, code) {
    if (!holder) return;
    const text = holder.querySelector('code');
    const copy = holder.querySelector('[data-copy]');
    if (text) text.textContent = code;
    if (copy) copy.setAttribute('data-copy', code);
  }

  function showTags(tags) {
    setCode(root.querySelector('[data-share-tags]'), tags);
    const copy = root.querySelector('[data-share-copy-tags]');
    if (copy) copy.setAttribute('data-copy', tags);
  }

  function showLink(link) {
    const box = root.querySelector('[data-share-url]');
    const copy = root.querySelector('[data-share-copy-url]');
    if (box) box.value = link.url;
    if (copy) copy.setAttribute('data-copy', link.url);
    const escaped = link.url.replace(/&/g, '&amp;');
    setCode(root.querySelector('[data-share-html]'), `<img src="${escaped}" width="${link.width}" height="${link.height}" alt="">`);
    showTags(link.metaTags);
    baked = false;
  }

  async function relink() {
    if (!canWrite || !root.querySelector('[data-share-url]')) return;
    const turn = ++linkTurn;
    try {
      const link = await call(`${api}/templates/${id}/url`, { method: 'POST', json: { values: values(), ...options() } });
      if (turn !== linkTurn) return;
      // A stored PNG belongs to the values it was made from, so the tags fall back once those change.
      const stale = baked && !serverPng;
      showLink(link);
      say(stale ? 'The image changed. Press Make a PNG again to store this version.' : '');
    } catch (err) {
      if (turn === linkTurn) say(err.message, true);
    }
  }

  const redrawSoon = debounce(redraw, 120);
  const relinkSoon = debounce(relink, 400);

  function changed() {
    history.replaceState(null, '', `${location.pathname}?${pageQuery()}`.replace(/\?$/, ''));
    redrawSoon();
    relinkSoon();
  }

  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    changed();
    redrawSoon.flush();
    relinkSoon.flush();
  });
  // The button reloads the page when there is no script. With one, every change is already live.
  const update = form.querySelector('button[type="submit"]');
  if (update) update.hidden = true;

  const bake = root.querySelector('[data-share-bake]');
  if (bake && canWrite) {
    bake.hidden = false;
    bake.addEventListener('click', async () => {
      bake.disabled = true;
      bake.setAttribute('aria-busy', 'true');
      say('Drawing the PNG in your browser…');
      try {
        const width = options().width;
        const result = await studio.draw(doc, values(), width);
        const size = /^<svg[^>]* width="([0-9.]+)" height="([0-9.]+)"/.exec(result.svg);
        const png = await svgToPng(result.svg, Math.round(Number(size[1])), Math.round(Number(size[2])));
        const query = new URLSearchParams(values());
        if (width) query.set('w', String(width));
        const stored = await call(`${api}/templates/${id}/bake?${query}`, { method: 'POST', body: png, type: 'image/png' });
        showTags(stored.metaTags);
        baked = true;
        say(`PNG stored (${Math.max(1, Math.round(stored.image.bytes / 1024))} KB). The meta tags now point at it. It keeps this look even if the design changes.`);
        if (window.Toolshed) window.Toolshed.toast('PNG stored. Copy the meta tags.');
      } catch (err) {
        say(err.message || 'The PNG could not be made. Try again.', true);
      } finally {
        bake.disabled = false;
        bake.removeAttribute('aria-busy');
      }
    });
  }
  watchFirstRequest(root, api, id);
  redraw();
}

/** Turns "Waiting for your first request" into "Received" the moment an image URL is opened. */
function watchFirstRequest(root, api, id) {
  const line = root.querySelector('[data-share-wait]');
  if (!line || root.dataset.first === '1') return;
  let tries = 0;
  const timer = setInterval(async () => {
    if (document.hidden) return;
    tries += 1;
    // Five minutes of looking is enough; after that the "Check again" link is still there.
    if (tries > 60) return clearInterval(timer);
    try {
      const { template } = await call(`${api}/templates/${id}`);
      if (!template.firstRequestAt) return;
      clearInterval(timer);
      const dot = document.createElement('span');
      dot.className = 'dot ok';
      line.replaceChildren(dot, ' Received. Your first image request just arrived.');
    } catch {
      // A missed check is not worth a message; the next one tries again.
    }
  }, 5000);
}
