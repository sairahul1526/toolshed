/**
 * The editor's three panels: the layer list, the fields, and the properties of whatever is selected.
 * Each `render…` call rebuilds its panel from the design, so the panels can never drift from it.
 * A control writes straight into the design and only ever writes a value the server would accept;
 * anything else is marked as wrong and left out until it is fixed.
 */
import { usedFields } from './engine/index.js';

export const MAX_LAYERS = 40;
const MAX_FIELDS = 20;
const KINDS = { text: 'Text', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', image: 'Picture' };
const WEIGHTS = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HEX6 = /^#[0-9a-f]{6}$/i;
const REFERENCE = /^\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const PICTURE = /^(?:asset:[a-z0-9_]{4,64}|https:\/\/[^\s"'<>]{4,580})$/;
/** Names the image URL uses itself, so a field cannot take them. */
const RESERVED = ['sig', 'w', 'v', 'exp'];

export const layerName = (layer) => layer.name || KINDS[layer.type] || layer.id;

const AS_PROPERTY = new Set(['value', 'checked', 'disabled', 'hidden', 'selected']);

/** A DOM element in one call. A function is an event listener; `text` is the text content. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (AS_PROPERTY.has(key)) node[key] = value;
    else if (typeof value === 'function') node.addEventListener(key, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

/** Rebuilds a panel and puts the keyboard focus back on the control that had it. */
function rebuild(host, ...children) {
  const held = host.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;
  host.replaceChildren(...children.flat().filter(Boolean));
  if (held) host.querySelector(`[data-focus="${CSS.escape(held)}"]`)?.focus();
}

let serial = 0;

function field(label, control, { hint, input = control } = {}) {
  input.id = `img-ed-${++serial}`;
  return el('div', { class: 'img-ed-field' }, el('label', { class: 'lbl', for: input.id, text: label }), control, hint ? el('p', { class: 'hint', text: hint }) : null);
}

function flag(input, bad) {
  if (bad) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/** A number box. `scale` shows a stored fraction as a percentage. */
function number(target, key, label, { min, max, step = 1, whole = false, optional = false, scale = 1, hint, placeholder }, changed) {
  const shown = () => (target[key] === undefined ? '' : String(Math.round(target[key] * scale * 100) / 100));
  const input = el('input', { class: 'input', type: 'number', min: min * scale, max: max * scale, step, value: shown(), placeholder, 'data-prop': key, 'data-focus': key });
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    const parsed = Number(raw) / scale;
    if (raw === '' ? !optional : !Number.isFinite(parsed)) return flag(input, true);
    flag(input, false);
    if (raw === '') delete target[key];
    else target[key] = Math.min(max, Math.max(min, whole ? Math.round(parsed) : parsed));
    changed();
  });
  // A number outside the range was pulled back into it, so show what was really kept.
  input.addEventListener('change', () => {
    if (target[key] === undefined) return;
    input.value = shown();
    flag(input, false);
  });
  return field(label, input, { hint });
}

/** A colour: a hex value or a field such as {{accent}}, with a picker beside it for plain hex. */
function paint(target, key, label, { optional = false, hexOnly = false, hint }, changed) {
  const now = target[key] ?? '';
  const text = el('input', { class: 'input mono', type: 'text', value: now, maxlength: 40, spellcheck: 'false', autocomplete: 'off', placeholder: optional ? 'None' : '#000000', 'data-focus': key });
  const picker = el('input', { class: 'img-ed-swatch', type: 'color', value: HEX6.test(now) ? now : '#000000', 'aria-label': `${label}: pick a colour` });
  text.addEventListener('input', () => {
    const value = text.value.trim();
    const fine = value === '' ? optional : HEX.test(value) || (!hexOnly && REFERENCE.test(value));
    flag(text, !fine);
    if (!fine) return;
    if (value === '') delete target[key];
    else target[key] = value;
    if (HEX6.test(value)) picker.value = value;
    changed();
  });
  picker.addEventListener('input', () => {
    text.value = picker.value;
    target[key] = picker.value;
    flag(text, false);
    changed();
  });
  return field(label, el('div', { class: 'img-ed-paint' }, text, picker), { input: text, hint: hint ?? (hexOnly ? undefined : 'A hex colour, or a field such as {{accent}}.') });
}

/** A drop-down. `read` turns the chosen text back into the stored value; an empty choice removes it. */
function choice(target, key, label, options, { read = (value) => value, hint, value = target[key] } = {}, changed) {
  const select = el('select', { class: 'input', 'data-focus': key }, options.map((option) => el('option', { value: option.value, text: option.label, selected: String(option.value) === String(value ?? '') })));
  select.addEventListener('change', () => {
    if (select.value === '') delete target[key];
    else target[key] = read(select.value);
    changed();
  });
  return field(label, select, { hint });
}

function check(target, key, label, { on = true, off, hint } = {}, changed) {
  const box = el('input', { type: 'checkbox', checked: target[key] === on, 'data-focus': key });
  box.addEventListener('change', () => {
    if (box.checked) target[key] = on;
    else if (off === undefined) delete target[key];
    else target[key] = off;
    changed();
  });
  return el('label', { class: 'check img-ed-field' }, box, el('span', {}, el('b', { text: label }), hint ? el('span', { text: hint }) : null));
}

function line(target, key, label, { maxlength, hint, placeholder, optional = true, valid = () => true }, changed) {
  const input = el('input', { class: 'input', type: 'text', value: target[key] ?? '', maxlength, placeholder, autocomplete: 'off', 'data-focus': key });
  input.addEventListener('input', () => {
    const fine = valid(input.value);
    flag(input, !fine);
    if (!fine) return;
    if (input.value === '' && optional) delete target[key];
    else target[key] = input.value;
    changed();
  });
  return field(label, input, { hint });
}

const heading = (text) => el('h3', { class: 'img-ed-h', text });
const group = (...children) => el('div', { class: 'img-ed-grid' }, ...children);
const small = (label, about, run, extra = {}) => el('button', { type: 'button', class: 'btn sm ghost', text: label, 'aria-label': about, click: run, ...extra });

// --- Layers -------------------------------------------------------------------------------------

export function renderLayers(host, ed) {
  const layers = ed.doc.layers;
  const rows = layers
    .map((layer, index) => {
      const name = layerName(layer);
      const on = layer.id === ed.selected;
      return el(
        'li',
        { class: `img-ed-layer${on ? ' on' : ''}${layer.hidden ? ' off' : ''}` },
        el('button', { type: 'button', class: 'img-ed-layer-name', 'aria-pressed': String(on), 'data-focus': `pick:${layer.id}`, click: () => ed.select(layer.id) }, el('span', { class: 'img-ed-kind', text: KINDS[layer.type] }), el('span', { class: 'trunc', text: name })),
        el(
          'span',
          { class: 'img-ed-acts' },
          small('Up', `Move ${name} forward`, () => ed.moveLayer(layer.id, 1), { disabled: index === layers.length - 1, 'data-focus': `up:${layer.id}` }),
          small('Down', `Move ${name} back`, () => ed.moveLayer(layer.id, -1), { disabled: index === 0, 'data-focus': `down:${layer.id}` }),
          small(layer.hidden ? 'Show' : 'Hide', `${layer.hidden ? 'Show' : 'Hide'} ${name}`, () => ed.toggleLayer(layer.id), { 'data-focus': `hide:${layer.id}` }),
        ),
      );
    })
    .reverse();
  rebuild(
    host,
    heading('Layers'),
    rows.length ? el('ol', { class: 'img-ed-layers' }, rows) : el('p', { class: 'muted', text: 'No layers yet. Add one from the bar above.' }),
    el('button', { type: 'button', class: `img-ed-layer-name img-ed-canvas-pick${ed.selected ? '' : ' on'}`, 'aria-pressed': String(!ed.selected), 'data-focus': 'pick:', text: 'Canvas and background', click: () => ed.select(null) }),
  );
}

// --- Properties ---------------------------------------------------------------------------------

function nearestWeight(family, wanted) {
  let best = family.faces[0]?.weight ?? 400;
  for (const face of family.faces) {
    const gap = Math.abs(face.weight - wanted);
    const bestGap = Math.abs(best - wanted);
    if (gap < bestGap || (gap === bestGap && face.weight > best)) best = face.weight;
  }
  return best;
}

function textControls(layer, ed) {
  const plain = () => ed.changed();
  const families = ed.catalog.families;
  const family = families.find((x) => x.id === (layer.font || ed.catalog.fallback));
  const fonts = families.map((x) => ({ value: x.id, label: x.name }));
  if (!family) fonts.unshift({ value: layer.font, label: 'A font that is no longer here' });
  const weights = (family || families[0]).faces.map((face) => ({ value: face.weight, label: WEIGHTS[face.weight] || String(face.weight) }));

  const area = el('textarea', { class: 'input', rows: 3, maxlength: 2000, value: layer.text, 'data-focus': 'text' });
  area.addEventListener('input', () => {
    layer.text = area.value;
    plain();
  });
  const insert = ed.doc.fields.length
    ? el('select', { class: 'input', 'aria-label': 'Put a field into the text', 'data-focus': 'insert' }, el('option', { value: '', text: 'Put in a field…' }), ed.doc.fields.filter((x) => x.type === 'text').map((x) => el('option', { value: x.name, text: x.label || x.name })))
    : null;
  insert?.addEventListener('change', () => {
    if (!insert.value) return;
    area.setRangeText(`{{${insert.value}}}`, area.selectionStart, area.selectionEnd, 'end');
    insert.value = '';
    area.dispatchEvent(new Event('input'));
    area.focus();
  });

  return [
    heading('Text'),
    field('What it says', el('div', { class: 'img-ed-stack' }, area, insert), { input: area, hint: 'A field in double braces, such as {{title}}, is filled in by the image URL.' }),
    group(
      choice(layer, 'font', 'Font', fonts, { value: layer.font || ed.catalog.fallback }, () => {
        const next = families.find((x) => x.id === layer.font);
        if (next) layer.weight = nearestWeight(next, layer.weight ?? 400);
        ed.changed('all');
      }),
      choice(layer, 'weight', 'Weight', weights, { read: Number, value: family ? nearestWeight(family, layer.weight ?? 400) : layer.weight }, plain),
    ),
    group(number(layer, 'size', 'Size', { min: 4, max: 800 }, plain), paint(layer, 'color', 'Colour', { hint: '' }, plain)),
    el('p', { class: 'hint', 'data-fit-note': layer.id }),
    check(layer, 'fit', 'Shrink long text to fit the box', { on: 'shrink', off: 'none' }, plain),
    group(
      number(layer, 'maxLines', 'Lines at most', { min: 0, max: 50, whole: true, optional: true, placeholder: 'Any' }, plain),
      number(layer, 'minSize', 'Smallest size', { min: 4, max: 800, optional: true, placeholder: 'Auto' }, plain),
    ),
    group(
      choice(layer, 'align', 'Align', [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }], { value: layer.align || 'left' }, plain),
      choice(layer, 'valign', 'In the box', [{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }], { value: layer.valign || 'top' }, plain),
    ),
    group(
      number(layer, 'lineHeight', 'Line height', { min: 0.6, max: 3, step: 0.05, optional: true, placeholder: '1.2' }, plain),
      number(layer, 'letterSpacing', 'Letter spacing', { min: -0.2, max: 1, step: 0.01, optional: true, placeholder: '0' }, plain),
    ),
    check(layer, 'upper', 'All capitals', {}, plain),
  ];
}

function shapeControls(layer, ed) {
  const plain = () => ed.changed();
  if (layer.type === 'line') {
    return [heading('Line'), group(paint(layer, 'stroke', 'Colour', { hint: '' }, plain), number(layer, 'strokeWidth', 'Thickness', { min: 0.5, max: 200, step: 0.5, optional: true, placeholder: '2' }, plain))];
  }
  return [
    heading(KINDS[layer.type]),
    paint(layer, 'fill', 'Fill', { optional: true }, plain),
    group(paint(layer, 'fill2', 'Fade to', { optional: true, hint: 'A second colour makes a gradient.' }, plain), number(layer, 'angle', 'Fade angle', { min: -360, max: 360, optional: true, placeholder: '90' }, plain)),
    group(paint(layer, 'stroke', 'Outline', { optional: true, hint: '' }, plain), number(layer, 'strokeWidth', 'Outline width', { min: 0, max: 200, optional: true, placeholder: '0' }, plain)),
    layer.type === 'rect' ? number(layer, 'radius', 'Corner radius', { min: 0, max: 2400, optional: true, placeholder: '0' }, plain) : null,
  ];
}

function pictureControls(layer, ed, typingAddress) {
  const plain = () => ed.changed();
  const fields = ed.doc.fields.filter((x) => x.type === 'image');
  const outside = layer.src.startsWith('https://');
  const known = ed.pictures.some((x) => x.ref === layer.src);
  const options = [
    { value: '', label: 'No picture yet' },
    ...ed.pictures.map((x) => ({ value: x.ref, label: x.name })),
    ...fields.map((x) => ({ value: `{{${x.name}}}`, label: `Field: ${x.label || x.name}` })),
    { value: 'https://', label: 'A picture on another site' },
  ];
  if (layer.src && !outside && !known && !options.some((x) => x.value === layer.src)) options.push({ value: layer.src, label: 'A picture that is not in this list' });
  const select = el('select', { class: 'input', 'data-focus': 'src' }, options.map((x) => el('option', { value: x.value, text: x.label, selected: x.value === (outside ? 'https://' : layer.src) })));
  select.addEventListener('change', () => {
    // An address is typed in the box that appears next, so the layer stays empty until it is complete.
    layer.src = select.value === 'https://' ? '' : select.value;
    ed.changed();
    renderProps(ed.hosts.props, ed, select.value === 'https://');
  });
  const sites = ed.allowed.length ? `Allowed sites: ${ed.allowed.join(', ')}. An admin can add more in Settings.` : 'No outside sites are allowed yet. Upload the picture instead, or ask an admin to allow its site in Settings.';
  return [
    heading('Picture'),
    field('Which picture', select, { hint: 'Each picture is fetched once and kept, never loaded from another site while an image is drawn.' }),
    outside || typingAddress ? line(layer, 'src', 'Address', { maxlength: 580, placeholder: 'https://images.example.com/photo.jpg', optional: false, valid: (value) => value === '' || PICTURE.test(value), hint: sites }, plain) : null,
    el('p', { class: 'hint' }, el('a', { class: 'link', href: ed.assetsHref, text: 'Upload pictures' }), ' to use your own.'),
    group(
      choice(layer, 'fit', 'When the shape differs', [{ value: 'cover', label: 'Fill the box' }, { value: 'contain', label: 'Show all of it' }], { value: layer.fit || 'cover' }, plain),
      number(layer, 'radius', 'Corner radius', { min: 0, max: 2400, optional: true, placeholder: '0' }, plain),
    ),
  ];
}

function canvasControls(ed) {
  const doc = ed.doc;
  const plain = () => ed.changed();
  return [
    heading('Canvas'),
    group(number(doc, 'width', 'Width', { min: 16, max: 2400, whole: true }, plain), number(doc, 'height', 'Height', { min: 16, max: 2400, whole: true }, plain)),
    paint(doc, 'background', 'Background', {}, plain),
    group(paint(doc, 'background2', 'Fade to', { optional: true, hint: 'A second colour makes a gradient.' }, plain), number(doc, 'backgroundAngle', 'Fade angle', { min: -360, max: 360, optional: true, placeholder: '90' }, plain)),
    el('p', { class: 'hint', text: 'Pick a layer in the list or on the picture to change it.' }),
  ];
}

/** `typingAddress` keeps the address box open right after "A picture on another site" is chosen. */
export function renderProps(host, ed, typingAddress = false) {
  const layer = ed.doc.layers.find((x) => x.id === ed.selected);
  if (!layer) return rebuild(host, canvasControls(ed));
  const plain = () => ed.changed();
  const own = layer.type === 'text' ? textControls(layer, ed) : layer.type === 'image' ? pictureControls(layer, ed, typingAddress) : shapeControls(layer, ed);
  rebuild(
    host,
    line(layer, 'name', 'Layer name', { maxlength: 60, placeholder: KINDS[layer.type] }, () => ed.changed('list')),
    own,
    heading('Place and size'),
    group(number(layer, 'x', 'Left', { min: -4800, max: 4800, whole: true }, plain), number(layer, 'y', 'Top', { min: -4800, max: 4800, whole: true }, plain)),
    group(number(layer, 'w', 'Width', { min: 0, max: 4800, whole: true }, plain), number(layer, 'h', 'Height', { min: 0, max: 4800, whole: true }, plain)),
    group(
      number(layer, 'rotate', 'Turn, in degrees', { min: -360, max: 360, optional: true, placeholder: '0' }, plain),
      number(layer, 'opacity', 'See-through, in %', { min: 0, max: 1, scale: 100, optional: true, placeholder: '100' }, plain),
    ),
    el(
      'div',
      { class: 'img-row' },
      el('button', { type: 'button', class: 'btn sm', text: 'Duplicate', 'data-focus': 'duplicate', click: () => ed.duplicateLayer(layer.id) }),
      el('button', { type: 'button', class: 'btn sm danger', text: 'Delete layer', 'data-focus': 'delete', click: () => ed.removeLayer(layer.id) }),
    ),
  );
}

// --- Fields -------------------------------------------------------------------------------------

function fieldRow(entry, index, used, ed) {
  const plain = () => ed.changed();
  const sample =
    entry.type === 'color'
      ? paint(entry, 'default', 'Colour when the URL leaves it out', { hexOnly: true }, plain)
      : line(entry, 'default', entry.type === 'image' ? 'Picture when the URL leaves it out' : 'Text when the URL leaves it out', { maxlength: 2000, optional: false, placeholder: entry.type === 'image' ? 'asset:… or https://…' : '', valid: (value) => entry.type !== 'image' || value === '' || PICTURE.test(value) }, plain);
  const tryIt = el('input', { class: 'input', type: 'text', value: ed.values[entry.name] ?? '', maxlength: 2000, placeholder: 'Shown here only, never saved', autocomplete: 'off', 'data-focus': `try:${entry.name}` });
  tryIt.addEventListener('input', () => {
    if (tryIt.value === '') delete ed.values[entry.name];
    else ed.values[entry.name] = tryIt.value;
    ed.preview();
  });
  return el(
    'fieldset',
    { class: 'img-ed-fieldset' },
    el('legend', {}, el('code', { text: `{{${entry.name}}}` }), used ? null : el('span', { class: 'muted', text: ' not used yet' })),
    group(
      line(entry, 'label', 'Label', { maxlength: 60, placeholder: entry.name }, plain),
      choice(entry, 'type', 'Holds', [{ value: 'text', label: 'Text' }, { value: 'color', label: 'A colour' }, { value: 'image', label: 'A picture' }], {}, () => {
        // A colour field must start from a real colour, and a text limit means nothing for the others.
        if (entry.type === 'color' && !HEX.test(entry.default)) entry.default = '#000000';
        if (entry.type !== 'text') delete entry.maxLength;
        ed.changed('all');
      }),
    ),
    sample,
    entry.type === 'text' ? number(entry, 'maxLength', 'Longest text allowed', { min: 1, max: 2000, whole: true, optional: true, placeholder: '500' }, plain) : null,
    field('Try another value', tryIt, { hint: entry.type === 'text' ? 'Paste a long one to check how it wraps and shrinks.' : undefined }),
    used
      ? el('p', { class: 'hint', text: 'A layer uses this field. Take it out of the layer before deleting it.' })
      : el('button', { type: 'button', class: 'btn sm danger', text: 'Delete field', 'data-focus': `drop:${entry.name}`, click: () => {
          ed.doc.fields.splice(index, 1);
          delete ed.values[entry.name];
          ed.changed('all');
        } }),
  );
}

function nameProblem(name, doc) {
  if (!FIELD_NAME.test(name)) return 'Start with a letter, then letters, numbers or underscores (32 at most).';
  if (RESERVED.includes(name)) return 'That name is used by the image URL itself. Pick another.';
  if (doc.fields.some((x) => x.name === name)) return 'There is already a field with that name.';
  return doc.fields.length >= MAX_FIELDS ? `A template can have ${MAX_FIELDS} fields at most.` : '';
}

export function renderFields(host, ed) {
  const doc = ed.doc;
  const used = new Set(usedFields(doc));
  const add = (name) => {
    doc.fields.push({ name, label: name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '), type: 'text', default: 'Sample text', maxLength: 120 });
    ed.changed('all');
  };
  // A layer can name a field before it exists; the design cannot be saved until it does.
  const missing = [...used].filter((name) => !doc.fields.some((x) => x.name === name));
  const box = el('input', { class: 'input mono', type: 'text', maxlength: 32, placeholder: 'subtitle', autocomplete: 'off', spellcheck: 'false', 'data-focus': 'new-field' });
  const problem = el('p', { class: 'err-text', role: 'alert', hidden: true });
  const submit = (event) => {
    event.preventDefault();
    const name = box.value.trim();
    const wrong = nameProblem(name, doc);
    problem.textContent = wrong;
    problem.hidden = !wrong;
    flag(box, Boolean(wrong));
    if (!wrong) add(name);
  };
  rebuild(
    host,
    heading('Fields'),
    el('p', { class: 'hint', text: 'A field is a part of the image the URL can change, such as ?title=Hello.' }),
    missing.map((name) => el('p', { class: 'err-text' }, `A layer uses {{${name}}}, which is not a field yet. `, small('Add it', `Add the field ${name}`, () => add(name), { class: 'btn sm', 'data-focus': `add:${name}` }))),
    doc.fields.map((entry, index) => fieldRow(entry, index, used.has(entry.name), ed)),
    el('form', { class: 'img-ed-add', submit }, field('New field name', box, { hint: 'This is the name used in the URL.' }), problem, el('button', { type: 'submit', class: 'btn sm', text: 'Add field', 'data-no-busy': true })),
  );
}
