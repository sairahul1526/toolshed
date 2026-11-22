/**
 * The editor's stage: the drawn design with a see-through layer on top that takes the pointer.
 * The picture underneath is the real render, so what is dragged here is exactly what the image
 * URL will show. The overlay is rebuilt after every change, which is why a drag listens on the
 * window instead of on the box that was pressed.
 */
import { el } from './editor-panels.js';

const SVG = 'http://www.w3.org/2000/svg';
/** How far a layer may sit from the canvas corner, and how large it may be. The server checks the same. */
const FAR = 4800;
/** Where the eight grips sit on a box, as fractions of its width and height. */
const GRIPS = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
/** Sizes on screen, in CSS pixels, whatever the size of the design. */
const GRIP = 10;
const THIN = 12;

const within = (value, low, high) => Math.min(high, Math.max(low, value));
export const place = (value) => within(Math.round(value), -FAR, FAR);
export const extent = (value, least) => within(Math.round(value), least, FAR);
/** A line may be flat or upright, so one of its sides can be zero. */
export const leastSide = (layer) => (layer.type === 'line' ? 0 : 1);

function shape(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * The box after one grip is dragged by (dx, dy). The opposite side stays where it is on screen,
 * which for a turned layer means working in the layer's own axes and moving its centre to match.
 */
function resized(from, layer, [gx, gy], dx, dy) {
  const turn = ((layer.rotate || 0) * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const alongX = dx * cos + dy * sin;
  const alongY = -dx * sin + dy * cos;
  // 1 grows the box to the right or down, -1 to the left or up, 0 leaves that side alone.
  const sx = gx === 1 ? 1 : gx === 0 ? -1 : 0;
  const sy = gy === 1 ? 1 : gy === 0 ? -1 : 0;
  const w = extent(from.w + sx * alongX, leastSide(layer));
  const h = extent(from.h + sy * alongY, leastSide(layer));
  const fixedX = (-sx * from.w) / 2;
  const fixedY = (-sy * from.h) / 2;
  const worldX = from.x + from.w / 2 + fixedX * cos - fixedY * sin;
  const worldY = from.y + from.h / 2 + fixedX * sin + fixedY * cos;
  const nextX = (-sx * w) / 2;
  const nextY = (-sy * h) / 2;
  const centreX = worldX - (nextX * cos - nextY * sin);
  const centreY = worldY - (nextX * sin + nextY * cos);
  return { x: place(centreX - w / 2), y: place(centreY - h / 2), w, h };
}

/**
 * @param ed The editor: `doc`, `selected` and `select(id)`.
 * @param on `dragged(layer)` runs on every step of a drag, `dropped()` once when it ends.
 */
export function createStage(ed, on) {
  const image = el('img', { class: 'img-ed-image', alt: 'The design as it looks now', draggable: 'false' });
  const overlay = shape('svg', { class: 'img-ed-overlay', 'aria-hidden': 'true' });
  const canvas = el('div', { class: 'img-ed-canvas', tabindex: '0', role: 'group', 'aria-label': 'The design. Arrow keys move the selected layer.' }, image, overlay);

  /** How many design pixels one screen pixel covers. */
  function unit() {
    const shown = overlay.getBoundingClientRect().width;
    return shown > 0 ? ed.doc.width / shown : 1;
  }

  function draw() {
    const doc = ed.doc;
    // The stage keeps the design's shape, and a tall format stops short of the bottom of the window.
    canvas.style.setProperty('aspect-ratio', `${doc.width} / ${doc.height}`);
    canvas.style.setProperty('max-width', `calc(70vh * ${(doc.width / doc.height).toFixed(4)})`);
    overlay.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
    const px = unit();
    const nodes = [];
    for (const layer of doc.layers) {
      if (layer.hidden) continue;
      // A hairline is hard to press, so a thin layer gets a wider area to catch the pointer.
      const padX = layer.w < THIN * px ? (THIN * px - layer.w) / 2 : 0;
      const padY = layer.h < THIN * px ? (THIN * px - layer.h) / 2 : 0;
      const hit = shape('g', turned(layer));
      hit.append(shape('rect', { class: 'img-ed-hit', 'data-layer': layer.id, x: layer.x - padX, y: layer.y - padY, width: layer.w + padX * 2, height: layer.h + padY * 2 }));
      nodes.push(hit);
    }
    // Pressing picks the topmost layer under the pointer; the grips of the selected one sit above everything.
    const layer = doc.layers.find((x) => x.id === ed.selected && !x.hidden);
    if (layer) {
      const frame = shape('g', turned(layer));
      frame.append(shape('rect', { class: 'img-ed-outline', x: layer.x, y: layer.y, width: layer.w, height: layer.h }));
      for (const [gx, gy] of grips(layer)) {
        frame.append(shape('rect', { class: 'img-ed-handle', 'data-handle': `${gx},${gy}`, x: layer.x + layer.w * gx - (GRIP * px) / 2, y: layer.y + layer.h * gy - (GRIP * px) / 2, width: GRIP * px, height: GRIP * px }));
      }
      nodes.push(frame);
    }
    overlay.replaceChildren(...nodes);
  }

  function turned(layer) {
    if (!layer.rotate) return {};
    return { transform: `rotate(${layer.rotate} ${layer.x + layer.w / 2} ${layer.y + layer.h / 2})` };
  }

  /** A line only has two ends to pull. */
  function grips(layer) {
    return layer.type === 'line' ? [[0, 0], [1, 1]] : GRIPS;
  }

  function point(event) {
    const box = overlay.getBoundingClientRect();
    const px = box.width > 0 ? ed.doc.width / box.width : 1;
    return { x: (event.clientX - box.left) * px, y: (event.clientY - box.top) * px };
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const grip = event.target.getAttribute('data-handle');
    const pressed = event.target.getAttribute('data-layer');
    canvas.focus({ preventScroll: true });
    if (!grip && !pressed) return ed.select(null);
    if (pressed && pressed !== ed.selected) ed.select(pressed);
    const layer = ed.doc.layers.find((x) => x.id === ed.selected);
    if (!layer) return;
    event.preventDefault();
    const start = point(event);
    const from = { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    const pull = grip ? grip.split(',').map(Number) : null;
    let moved = false;

    const move = (step) => {
      const now = point(step);
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      const next = pull ? resized(from, layer, pull, dx, dy) : { ...from, x: place(from.x + dx), y: place(from.y + dy) };
      if (next.x === layer.x && next.y === layer.y && next.w === layer.w && next.h === layer.h) return;
      Object.assign(layer, next);
      moved = true;
      draw();
      on.dragged(layer);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      if (moved) on.dropped();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });

  // Grips are sized in screen pixels, so they are redrawn when the stage changes size.
  window.addEventListener('resize', draw);

  return { canvas, image, draw };
}
