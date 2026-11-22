/**
 * The layer editor. It keeps the design, the selection and the undo steps, draws the preview with the
 * same engine the server uses, and saves the draft as it changes. The stage and the panels live in
 * their own files; this one decides what happens when something changes.
 * Without this script the page still has a plain form for text, sizes and colours.
 */
import { call, createStudio, debounce, describeWarning, showSvg } from './studio.js';
import { usedFields } from './engine/index.js';
import { MAX_LAYERS, el, layerName, renderFields, renderLayers, renderProps } from './editor-panels.js';
import { createStage, extent, leastSide, place } from './editor-stage.js';

const STEPS = 100;
const STARTERS = {
  text: (doc) => ({ type: 'text', name: 'Text', text: 'New text', font: 'inter', weight: 800, size: Math.max(16, Math.round(doc.width / 25)), color: '#111827', fit: 'shrink', maxLines: 2, w: Math.round(doc.width * 0.6), h: Math.round(doc.height * 0.25) }),
  rect: (doc) => ({ type: 'rect', name: 'Rectangle', fill: '#2563eb', w: Math.round(doc.width * 0.3), h: Math.round(doc.height * 0.3) }),
  ellipse: (doc) => ({ type: 'ellipse', name: 'Ellipse', fill: '#2563eb', w: Math.round(Math.min(doc.width, doc.height) * 0.3), h: Math.round(Math.min(doc.width, doc.height) * 0.3) }),
  line: (doc) => ({ type: 'line', name: 'Line', stroke: '#111827', strokeWidth: 4, w: Math.round(doc.width * 0.4), h: 0 }),
  image: (doc) => ({ type: 'image', name: 'Picture', src: '', fit: 'cover', w: Math.round(Math.min(doc.width, doc.height) * 0.4), h: Math.round(Math.min(doc.width, doc.height) * 0.4) }),
};
const ADD = [['text', 'Add text'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['image', 'Picture']];

const mount = document.querySelector('[data-images-editor]');
if (mount) start(mount);

function start(mount) {
  const api = mount.dataset.api;
  const id = mount.dataset.template;
  let doc = JSON.parse(mount.dataset.doc);
  let selected = null;
  /** Values tried in the fields panel. They only change the preview and are never saved. */
  const values = {};
  /** Field rows the person has opened, so they stay open when the panel is drawn again. */
  const openFields = new Set();
  const studio = createStudio({ custom: JSON.parse(mount.dataset.custom || '[]'), picture: (src) => `${api}/picture?src=${encodeURIComponent(src)}` });

  const hosts = { layers: el('section', { class: 'img-ed-panel' }), fields: el('section', { class: 'img-ed-panel' }), props: el('section', { class: 'img-ed-panel img-ed-props' }) };
  /** A panel in a collapsible section, so the picture stays in view while a person works. */
  const section = (title, host, open, extra = '') => el('details', { class: `img-ed-sect${extra}`, open }, el('summary', { text: title }), host);
  const problems = el('ul', { class: 'img-problems', role: 'status', hidden: true });
  const undoButton = el('button', { type: 'button', class: 'btn sm', text: 'Undo', disabled: true, click: () => travel(-1) });
  const redoButton = el('button', { type: 'button', class: 'btn sm', text: 'Redo', disabled: true, click: () => travel(1) });
  const addButtons = ADD.map(([kind, label]) => el('button', { type: 'button', class: 'btn sm', text: label, click: () => addLayer(kind) }));

  const ed = {
    get doc() {
      return doc;
    },
    get selected() {
      return selected;
    },
    values,
    openFields,
    hosts,
    catalog: studio.catalog,
    pictures: JSON.parse(mount.dataset.pictures || '[]'),
    allowed: JSON.parse(mount.dataset.hosts || '[]'),
    assetsHref: mount.dataset.assetsHref,
    select,
    changed,
    preview,
    moveLayer,
    toggleLayer,
    duplicateLayer,
    removeLayer,
  };
  const stage = createStage(ed, {
    dragged(layer) {
      preview();
      syncBoxes(layer);
    },
    dropped() {
      saveSoon();
      commitNow();
    },
  });

  mount.replaceChildren(
    el('div', { class: 'img-ed-bar', role: 'toolbar', 'aria-label': 'Add layers, undo and redo' }, addButtons, el('span', { class: 'img-ed-gap' }), undoButton, redoButton),
    el(
      'div',
      { class: 'img-ed-main' },
      el('div', { class: 'img-ed-side' }, section('Layers', hosts.layers, true), section('Fields', hosts.fields, false)),
      el('div', { class: 'img-ed-center' }, stage.canvas, el('p', { class: 'hint', text: 'Drag a layer to move it, or pull a corner to resize it. With the keyboard: arrow keys move it, Shift moves it 10 at a time, Alt changes its size, Delete removes it.' }), problems),
      section('Settings', hosts.props, true, ' img-ed-props'),
    ),
  );
  const fallback = document.querySelector('[data-editor-fallback]');
  if (fallback) fallback.hidden = true;

  const current = () => doc.layers.find((layer) => layer.id === selected);

  // --- Drawing ----------------------------------------------------------------------------------

  let frame = 0;
  let turn = 0;
  let shownProblems = '';
  let shownUsage = '';

  /** Draws at most once a frame, and drops an older drawing that finishes after a newer one. */
  function preview() {
    if (frame) return;
    frame = requestAnimationFrame(async () => {
      frame = 0;
      const mine = ++turn;
      try {
        const result = await studio.draw(doc, values);
        if (mine !== turn) return;
        showSvg(stage.image, result.svg);
        report(result.warnings.map((warning) => describeWarning(doc, warning)));
        for (const note of hosts.props.querySelectorAll('[data-fit-note]')) {
          const layer = doc.layers.find((x) => x.id === note.getAttribute('data-fit-note'));
          const drawn = result.sizes[note.getAttribute('data-fit-note')];
          note.textContent = layer && drawn && drawn < layer.size - 0.01 ? `Drawn at ${Math.round(drawn * 10) / 10} px so it fits the box.` : '';
        }
      } catch {
        if (mine === turn) report(['The preview could not be drawn. Undo the last change, or reload the page.']);
      }
    });
  }

  function report(lines) {
    const missing = usedFields(doc).filter((name) => !doc.fields.some((field) => field.name === name));
    const all = [...new Set([...missing.map((name) => `A layer uses {{${name}}}, which is not a field yet. Add it under Fields, or the design cannot be saved.`), ...lines])];
    // The list is read out when it changes, so it is only touched when it really does.
    if (all.join('\n') === shownProblems) return;
    shownProblems = all.join('\n');
    problems.replaceChildren(...all.map((line) => el('li', { text: line })));
    problems.hidden = all.length === 0;
  }

  /** Puts a dragged or nudged layer's numbers into the boxes that show them. */
  function syncBoxes(layer) {
    for (const key of ['x', 'y', 'w', 'h']) {
      const box = hosts.props.querySelector(`[data-prop="${key}"]`);
      if (box && box !== document.activeElement) box.value = String(layer[key]);
    }
  }

  function syncBar() {
    for (const button of addButtons) button.disabled = doc.layers.length >= MAX_LAYERS;
    undoButton.disabled = index === 0 && JSON.stringify(doc) === steps[0];
    redoButton.disabled = index >= steps.length - 1;
  }

  function panels() {
    renderLayers(hosts.layers, ed);
    renderProps(hosts.props, ed);
    renderFields(hosts.fields, ed);
    shownUsage = usage();
  }

  /** Which fields exist and which are used: when this changes, the fields panel is out of date. */
  const usage = () => `${doc.fields.map((field) => `${field.name}:${field.type}`).join()}|${usedFields(doc).join()}`;

  /**
   * Call after any change to the design. `scope` says which panels the change made stale:
   * 'list' for the layer list, 'all' for everything. The panel being typed in is left alone otherwise.
   */
  function changed(scope) {
    if (scope === 'all') panels();
    else {
      if (scope === 'list') renderLayers(hosts.layers, ed);
      if (usage() !== shownUsage) {
        renderFields(hosts.fields, ed);
        shownUsage = usage();
      }
    }
    stage.draw();
    preview();
    saveSoon();
    commitSoon();
    syncBar();
  }

  function select(next) {
    selected = next;
    renderLayers(hosts.layers, ed);
    renderProps(hosts.props, ed);
    stage.draw();
    // The size the text was drawn at is filled in by the next drawing.
    if (next) preview();
  }

  // --- Layers -----------------------------------------------------------------------------------

  function freshId() {
    for (;;) {
      const next = `l${Math.random().toString(36).slice(2, 8)}`;
      if (!doc.layers.some((layer) => layer.id === next)) return next;
    }
  }

  function addLayer(kind) {
    if (doc.layers.length >= MAX_LAYERS) return;
    const base = STARTERS[kind](doc);
    // Each new layer lands a little further along, so two added in a row do not hide each other.
    const shift = (doc.layers.length % 8) * 16;
    const layer = { id: freshId(), ...base, x: Math.round((doc.width - base.w) / 2) + shift, y: Math.round((doc.height - base.h) / 2) + shift };
    doc.layers.push(layer);
    selected = layer.id;
    changed('all');
    commitNow();
    stage.canvas.focus({ preventScroll: true });
  }

  function moveLayer(layerId, by) {
    const from = doc.layers.findIndex((layer) => layer.id === layerId);
    const to = from + by;
    if (from < 0 || to < 0 || to >= doc.layers.length) return;
    doc.layers.splice(to, 0, ...doc.layers.splice(from, 1));
    changed('list');
    commitNow();
  }

  function toggleLayer(layerId) {
    const layer = doc.layers.find((x) => x.id === layerId);
    if (!layer) return;
    if (layer.hidden) delete layer.hidden;
    else layer.hidden = true;
    changed('list');
    commitNow();
  }

  function duplicateLayer(layerId) {
    const at = doc.layers.findIndex((layer) => layer.id === layerId);
    if (at < 0 || doc.layers.length >= MAX_LAYERS) return;
    const source = doc.layers[at];
    const copy = { ...structuredClone(source), id: freshId(), name: `${layerName(source)} copy`.slice(0, 60), x: place(source.x + 24), y: place(source.y + 24) };
    doc.layers.splice(at + 1, 0, copy);
    selected = copy.id;
    changed('all');
    commitNow();
  }

  function removeLayer(layerId) {
    const at = doc.layers.findIndex((layer) => layer.id === layerId);
    if (at < 0) return;
    doc.layers.splice(at, 1);
    if (selected === layerId) selected = null;
    changed('all');
    commitNow();
    // The button that was pressed is gone, so the keyboard goes back to the stage.
    stage.canvas.focus({ preventScroll: true });
  }

  // --- History ----------------------------------------------------------------------------------

  const steps = [JSON.stringify(doc)];
  let index = 0;

  function commit() {
    const now = JSON.stringify(doc);
    if (now === steps[index]) return;
    steps.splice(index + 1, steps.length, now);
    if (steps.length > STEPS) steps.shift();
    index = steps.length - 1;
    syncBar();
  }
  /** Typing makes one step per pause, not one per letter. */
  const commitSoon = debounce(commit, 400);
  function commitNow() {
    commitSoon.flush();
    commit();
  }

  function travel(by) {
    commitNow();
    const to = index + by;
    if (to < 0 || to >= steps.length) return;
    index = to;
    doc = JSON.parse(steps[index]);
    if (!current()) selected = null;
    panels();
    stage.draw();
    preview();
    saveSoon();
    syncBar();
  }

  // --- Keyboard ---------------------------------------------------------------------------------

  stage.canvas.addEventListener('keydown', (event) => {
    const layer = current();
    const command = event.ctrlKey || event.metaKey;
    if (!layer) return;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[event.key];
    if (arrow && !command) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      if (event.altKey) {
        layer.w = extent(layer.w + arrow[0] * step, leastSide(layer));
        layer.h = extent(layer.h + arrow[1] * step, leastSide(layer));
      } else {
        layer.x = place(layer.x + arrow[0] * step);
        layer.y = place(layer.y + arrow[1] * step);
      }
      syncBoxes(layer);
      changed();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeLayer(layer.id);
    } else if (event.key === 'Escape') {
      select(null);
    } else if (command && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateLayer(layer.id);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    // Inside a text box the browser's own undo is what people expect.
    if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    travel(key === 'y' || event.shiftKey ? 1 : -1);
  });

  // --- Saving -----------------------------------------------------------------------------------

  const status = document.querySelector('[data-editor-status]');
  const publishForm = document.querySelector('[data-editor-publish]');
  const publishButton = document.querySelector('[data-editor-publish-button]');
  let unsaved = false;
  let failed = false;
  let leaving = false;
  let running = null;

  function say(text, bad) {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('field-error', Boolean(bad));
  }

  async function saveAll() {
    while (unsaved && !leaving) {
      unsaved = false;
      say('Saving…');
      try {
        const { template } = await call(`${api}/templates/${id}`, { method: 'PATCH', json: { doc } });
        failed = false;
        if (unsaved) continue;
        say(template.unpublishedChanges ? (template.published ? 'Saved. Publish to change your image URLs.' : 'Saved as a draft. Publish it to get image URLs.') : 'Saved. This is the published design.');
        if (publishButton) publishButton.disabled = !template.unpublishedChanges;
      } catch (err) {
        failed = true;
        const lines = [...new Set(Object.values(err.fields || {}))].slice(0, 3);
        say(`Not saved. ${lines.length ? lines.join(' ') : err.message}`, true);
        break;
      }
    }
    return !failed;
  }

  /** One save runs at a time. A change made while one is on its way is sent as soon as it lands. */
  function save() {
    if (!running) {
      running = saveAll().finally(() => {
        running = null;
      });
    }
    return running;
  }
  const saveLater = debounce(save, 800);
  function saveSoon() {
    unsaved = true;
    saveLater();
  }

  /** Sends anything still waiting and says whether the server now has the design on screen. */
  async function settle() {
    commitNow();
    saveLater.flush();
    if (failed) unsaved = true;
    return unsaved || running ? save() : true;
  }

  if (publishForm && publishButton) {
    publishButton.addEventListener('click', async (event) => {
      if (leaving || (!unsaved && !running && !failed)) return;
      // Publishing takes the draft the server has, so the newest changes have to arrive first.
      event.preventDefault();
      publishButton.disabled = true;
      publishButton.setAttribute('aria-busy', 'true');
      const saved = await settle();
      publishButton.removeAttribute('aria-busy');
      publishButton.disabled = false;
      if (!saved) return;
      leaving = true;
      publishForm.requestSubmit(publishButton);
    });
  }
  // Dropping the changes must not race a save that would put them straight back.
  for (const form of document.querySelectorAll('.img-publish form')) {
    if (form !== publishForm) form.addEventListener('submit', () => (leaving = true));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveLater.flush();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!leaving && (unsaved || running || failed)) event.preventDefault();
  });

  panels();
  stage.draw();
  syncBar();
  preview();
}
