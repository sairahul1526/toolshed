/**
 * The public generator page. The image is drawn here, in the visitor's browser, with the same
 * engine the server uses: typing costs the workspace nothing, and nothing a visitor types is sent
 * anywhere or stored. Without this script the page still shows the template's own sample image.
 */
import { createStudio, debounce, download, showSvg, svgToPng } from './studio.js';

const form = document.querySelector('[data-images-make]');
if (form) start(form);

/** What a visitor needs to know about a drawing problem. They cannot change the design, so it is kept short. */
const NOTES = {
  text_cut: 'Some text is too long for its box, so the end is cut off.',
  missing_glyphs: 'Some characters cannot be drawn in this font and are left out.',
  complex_script: 'This script needs letter joining, which is not supported yet. It may look wrong.',
};

async function start(form) {
  const preview = document.querySelector('[data-make-preview]');
  const status = document.querySelector('[data-make-status]');
  const png = form.querySelector('[data-make-png]');
  const svg = form.querySelector('[data-make-svg]');
  const say = (text) => {
    if (status) status.textContent = text;
  };

  let made;
  try {
    const res = await fetch(form.dataset.json, { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    made = await res.json();
  } catch {
    // The page stays as the server sent it: the sample image, and the plain form where there is one.
    return;
  }
  const { doc } = made;
  const slug = form.dataset.slug;
  const studio = createStudio({ custom: made.custom, picture: (src) => `/i/${slug}/image?src=${encodeURIComponent(src)}` });
  const names = doc.fields.filter((field) => field.type !== 'image').map((field) => field.name);
  let turn = 0;

  function values() {
    const out = {};
    for (const name of names) {
      const input = form.elements.namedItem(name);
      if (input && typeof input.value === 'string') out[name] = input.value;
    }
    return out;
  }

  async function redraw() {
    const mine = ++turn;
    try {
      const result = await studio.draw(doc, values());
      if (mine !== turn) return null;
      showSvg(preview, result.svg);
      const notes = [...new Set(result.warnings.map((warning) => NOTES[warning.code]).filter(Boolean))];
      say(notes.join(' '));
      return result;
    } catch {
      if (mine === turn) say('The picture could not be drawn. Reload the page and try again.');
      return null;
    }
  }

  async function save(button, kind) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const result = await studio.draw(doc, values());
      const file = kind === 'png' ? await svgToPng(result.svg, doc.width, doc.height) : new Blob([result.svg], { type: 'image/svg+xml' });
      download(file, `${form.dataset.name || slug}.${kind}`);
      say(`Saved as a ${doc.width} × ${doc.height} ${kind.toUpperCase()} file.`);
    } catch {
      say('The file could not be made. Try again, or try another browser.');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  const redrawSoon = debounce(redraw, 100);
  form.addEventListener('input', redrawSoon);
  // Enter in a text box would load the image address; with a script the picture is already up to date.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    redrawSoon();
    redrawSoon.flush();
  });
  const plain = form.querySelector('[data-make-plain]');
  if (plain) plain.hidden = true;
  for (const [button, kind] of [[png, 'png'], [svg, 'svg']]) {
    if (!button) continue;
    button.hidden = false;
    button.addEventListener('click', () => save(button, kind));
  }
  redraw();
}
