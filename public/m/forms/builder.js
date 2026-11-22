/* Toolshed Forms builder. Plain JavaScript, no build step.
   Reads the draft from #fb-data, edits it in memory and saves it to the API a moment after each change. */
(function () {
  'use strict';
  var dataEl = document.getElementById('fb-data');
  if (!dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var form = D.form, def = D.definition, rev = form.rev;
  var API = '/api/v1/forms/' + form.id;
  var LABEL = {};
  D.types.forEach(function (t) { LABEL[t.type] = t.label; });
  var CHOICE = ['single_choice', 'multiple_choice', 'dropdown'];
  var SCALES = ['rating', 'nps', 'csat', 'ces', 'scale'];
  var DISPLAY = ['statement', 'section'];
  var OPS = [['is', 'is'], ['is_not', 'is not'], ['contains', 'contains'], ['not_contains', 'does not contain'], ['any_of', 'is any of'], ['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['empty', 'is empty'], ['not_empty', 'is not empty']];

  var sel = { kind: 'page', id: def.pages[0].id };
  var tab = 'block';
  var undoStack = [], redoStack = [], lastKey = '', lastAt = 0;
  var saveTimer = 0, saving = false, dirty = false, stale = false, retry = 0;
  var uid = 0;

  var canvas = document.getElementById('fb-canvas');
  var inspector = document.getElementById('fb-inspector');
  var statusEl = document.getElementById('fb-status');
  var banner = document.getElementById('fb-banner');
  var undoBtn = document.getElementById('fb-undo');
  var redoBtn = document.getElementById('fb-redo');
  var publishBtn = document.getElementById('fb-publish');
  var liveNote = document.getElementById('fb-live');

  // ---- small helpers ------------------------------------------------------------------------
  function el(tag, props) {
    var n = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') n[k] = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }
  function rnd(prefix) { return prefix + Math.random().toString(36).slice(2, 8); }
  function nid() { return 'fb' + (++uid); }
  function toast(m, kind) { if (window.Toolshed && window.Toolshed.toast) window.Toolshed.toast(m, kind || 'ok'); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function allFields() { var out = []; def.pages.forEach(function (p) { p.fields.forEach(function (f) { out.push(f); }); }); return out; }
  function locate(id) {
    for (var pi = 0; pi < def.pages.length; pi++) {
      var fi = def.pages[pi].fields.findIndex(function (f) { return f.id === id; });
      if (fi >= 0) return { pi: pi, fi: fi, page: def.pages[pi], field: def.pages[pi].fields[fi] };
    }
    return null;
  }
  function pageOf(id) { return def.pages.filter(function (p) { return p.id === id; })[0]; }
  function slugKey(text) {
    var b = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    return /^[a-z]/.test(b) ? b : ('q_' + (b || 'field')).slice(0, 36);
  }
  function uniqueKey(text) {
    var taken = {};
    allFields().forEach(function (f) { taken[f.key] = 1; });
    var base = slugKey(text), key = base;
    for (var n = 2; taken[key]; n++) key = base.slice(0, 36) + '_' + n;
    return key;
  }
  function blank(type) {
    var f = { id: rnd('q_'), type: type, label: '', key: '', required: false };
    f.key = uniqueKey(LABEL[type] || type);
    if (CHOICE.indexOf(type) >= 0) f.options = [{ id: 'o1', label: 'Option 1' }, { id: 'o2', label: 'Option 2' }];
    if (type === 'rating') { f.min = 1; f.max = 5; }
    if (type === 'nps') { f.min = 0; f.max = 10; f.minLabel = 'Not likely'; f.maxLabel = 'Very likely'; }
    if (type === 'csat') { f.min = 1; f.max = 5; f.minLabel = 'Very unsatisfied'; f.maxLabel = 'Very satisfied'; }
    if (type === 'ces') { f.min = 1; f.max = 7; f.minLabel = 'Very difficult'; f.maxLabel = 'Very easy'; }
    if (type === 'scale') { f.min = 1; f.max = 10; }
    if (type === 'file_upload') { f.maxSizeMb = 10; f.maxFiles = 1; f.accept = ['pdf', 'png', 'jpg', 'jpeg']; }
    if (type === 'hidden') f.param = f.key;
    return f;
  }

  // ---- history (undo and redo) and saving ---------------------------------------------------
  function snapshot(key) {
    var now = Date.now();
    if (key && key === lastKey && now - lastAt < 900) { lastAt = now; return; }
    undoStack.push(JSON.stringify(def));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    lastKey = key || ''; lastAt = now;
    syncHistoryButtons();
  }
  function syncHistoryButtons() { undoBtn.disabled = undoStack.length === 0; redoBtn.disabled = redoStack.length === 0; }
  function jump(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(def));
    def = JSON.parse(from.pop());
    lastKey = '';
    if (!locate(sel.id) && !pageOf(sel.id) && sel.kind !== 'ending' && sel.kind !== 'form') sel = { kind: 'page', id: def.pages[0].id };
    renderAll();
    scheduleSave();
    syncHistoryButtons();
  }
  function setStatus(text, tone) {
    statusEl.textContent = text;
    statusEl.setAttribute('data-tone', tone || '');
  }
  function showBanner(msg, withReload) {
    banner.textContent = '';
    if (!msg) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.appendChild(el('span', { text: msg + ' ' }));
    if (withReload) banner.appendChild(el('button', { type: 'button', class: 'btn sm', text: 'Reload the editor', on: { click: function () { dirty = false; location.reload(); } } }));
  }
  function changed(structural) {
    dirty = true;
    renderCanvas();
    if (structural) renderInspector();
    scheduleSave();
  }
  function scheduleSave() {
    dirty = true;
    if (stale) return;
    setStatus('Unsaved changes', 'pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 800);
  }
  function save() {
    if (saving || stale) { if (saving) saveTimer = setTimeout(save, 400); return Promise.resolve(); }
    saving = true;
    setStatus('Saving', 'pending');
    var sent = JSON.stringify(def);
    return fetch(API + '/draft', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition: def, rev: rev }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (r) {
        if (r.status === 200) {
          rev = r.j.rev; retry = 0;
          showBanner('');
          if (JSON.stringify(def) === sent) { dirty = false; setStatus('All changes saved', 'ok'); } else scheduleSave();
          liveNote.hidden = !r.j.unpublishedChanges;
          publishBtn.disabled = false;
        } else if (r.status === 409) {
          stale = true;
          setStatus('Not saved', 'bad');
          showBanner('Someone changed this form in another tab or on another device. Reload to get their version. Your latest edits here were not saved.', true);
        } else {
          setStatus('Not saved', 'bad');
          var first = r.j && r.j.fields ? Object.keys(r.j.fields)[0] : null;
          showBanner((r.j && r.j.message ? r.j.message : 'The form could not be saved.') + (first ? ' ' + r.j.fields[first] : ''), false);
        }
      })
      .catch(function () {
        setStatus('Not saved. Retrying', 'bad');
        retry = Math.min(retry + 1, 5);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 1500 * retry);
      })
      .then(function () { saving = false; });
  }
  window.addEventListener('beforeunload', function (e) { if (dirty && !stale) { e.preventDefault(); e.returnValue = ''; } });

  // ---- canvas -------------------------------------------------------------------------------
  var dragId = null;
  function summary(f) {
    if (f.type === 'section') return f.label || 'Section heading';
    return f.label || 'Untitled ' + (LABEL[f.type] || f.type).toLowerCase();
  }
  function select(kind, id, focus) {
    sel = { kind: kind, id: id };
    if (kind === 'field') tab = 'block'; else if (kind === 'page') tab = 'page'; else if (kind === 'ending') tab = 'endings';
    renderCanvas(focus ? id : null);
    renderInspector();
  }
  function moveField(id, dir) {
    var at = locate(id);
    if (!at) return;
    var ni = at.fi + dir;
    snapshot('');
    if (ni >= 0 && ni < at.page.fields.length) {
      at.page.fields.splice(at.fi, 1);
      at.page.fields.splice(ni, 0, at.field);
    } else {
      var np = def.pages[at.pi + dir];
      if (!np) return;
      at.page.fields.splice(at.fi, 1);
      if (dir < 0) np.fields.push(at.field); else np.fields.unshift(at.field);
    }
    changed(false);
    renderCanvas(id);
  }
  function addBlock(page, type, index) {
    if (allFields().length >= 200) { toast('A form can have up to 200 blocks.', 'error'); return; }
    snapshot('');
    var f = blank(type);
    var at = index === undefined ? page.fields.length : index;
    page.fields.splice(at, 0, f);
    sel = { kind: 'field', id: f.id }; tab = 'block';
    changed(true);
    renderCanvas(f.id);
    var first = inspector.querySelector('textarea, input');
    if (first) first.focus();
  }
  function removeField(id) {
    var at = locate(id);
    if (!at) return;
    snapshot('');
    at.page.fields.splice(at.fi, 1);
    var next = at.page.fields[at.fi] || at.page.fields[at.fi - 1];
    sel = next ? { kind: 'field', id: next.id } : { kind: 'page', id: at.page.id };
    tab = next ? 'block' : 'page';
    changed(true);
    renderCanvas(sel.id);
    toast('Block removed. Use Undo to bring it back.', 'info');
  }
  function dupField(id) {
    var at = locate(id);
    if (!at) return;
    snapshot('');
    var c = clone(at.field);
    c.id = rnd('q_'); c.key = uniqueKey(at.field.key + '_copy'); c.showIf = at.field.showIf ? clone(at.field.showIf) : undefined;
    at.page.fields.splice(at.fi + 1, 0, c);
    sel = { kind: 'field', id: c.id };
    changed(true);
    renderCanvas(c.id);
  }
  function addPage() {
    if (def.pages.length >= 30) { toast('A form can have up to 30 pages.', 'error'); return; }
    snapshot('');
    var p = { id: rnd('p_'), title: '', fields: [] };
    def.pages.push(p);
    sel = { kind: 'page', id: p.id };
    changed(true);
  }
  function removePage(id) {
    if (def.pages.length < 2) return;
    var p = pageOf(id);
    if (p.fields.length && !window.confirm('Remove this page and its ' + p.fields.length + ' block' + (p.fields.length === 1 ? '' : 's') + '? You can undo this.')) return;
    snapshot('');
    def.pages = def.pages.filter(function (x) { return x.id !== id; });
    def.pages.forEach(function (x) { if (x.jump) x.jump = x.jump.filter(function (j) { return j.to !== id; }); });
    sel = { kind: 'page', id: def.pages[0].id };
    changed(true);
  }
  function movePage(id, dir) {
    var i = def.pages.findIndex(function (p) { return p.id === id; });
    var j = i + dir;
    if (j < 0 || j >= def.pages.length) return;
    snapshot('');
    var p = def.pages.splice(i, 1)[0];
    def.pages.splice(j, 0, p);
    changed(false);
  }

  function paletteSelect(page) {
    var s = el('select', { class: 'input fb-add', 'aria-label': 'Add a block to ' + (page.title || 'this page') });
    s.appendChild(el('option', { value: '', text: 'Add a block' }));
    var groups = {};
    D.types.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    Object.keys(groups).forEach(function (g) {
      var og = el('optgroup', { label: g });
      groups[g].forEach(function (t) { og.appendChild(el('option', { value: t.type, text: t.label })); });
      s.appendChild(og);
    });
    s.addEventListener('change', function () { if (s.value) { var t = s.value; s.value = ''; addBlock(page, t); } });
    return s;
  }

  function dropIndex(ul, y) {
    var items = [].slice.call(ul.querySelectorAll(':scope > .fb-block'));
    for (var i = 0; i < items.length; i++) { var r = items[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return i; }
    return items.length;
  }

  function badges(f) {
    var out = [];
    if (f.required) out.push(el('span', { class: 'fb-badge', text: 'Required' }));
    if (f.showIf && f.showIf.rules && f.showIf.rules.length) out.push(el('span', { class: 'fb-badge', text: 'Logic' }));
    if (f.options && f.options.some(function (o) { return o.points !== undefined; })) out.push(el('span', { class: 'fb-badge', text: 'Scored' }));
    return out;
  }

  function renderCanvas(focusId) {
    canvas.textContent = '';
    def.pages.forEach(function (p, pi) {
      var head = el('div', { class: 'fb-page-head' },
        el('button', { type: 'button', class: 'fb-page-pick', 'aria-pressed': sel.kind === 'page' && sel.id === p.id ? 'true' : 'false', on: { click: function () { select('page', p.id); } } },
          el('b', { text: 'Page ' + (pi + 1) }), p.title ? el('span', { text: p.title }) : null,
          p.showIf && p.showIf.rules.length ? el('span', { class: 'fb-badge', text: 'Logic' }) : null,
          p.jump && p.jump.length ? el('span', { class: 'fb-badge', text: 'Jumps' }) : null),
        el('span', { class: 'fb-tools' },
          el('button', { type: 'button', class: 'btn sm ghost', text: 'Up', 'aria-label': 'Move page ' + (pi + 1) + ' up', disabled: pi === 0, on: { click: function () { movePage(p.id, -1); } } }),
          el('button', { type: 'button', class: 'btn sm ghost', text: 'Down', 'aria-label': 'Move page ' + (pi + 1) + ' down', disabled: pi === def.pages.length - 1, on: { click: function () { movePage(p.id, 1); } } }),
          def.pages.length > 1 ? el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove', 'aria-label': 'Remove page ' + (pi + 1), on: { click: function () { removePage(p.id); } } }) : null));
      var ul = el('ul', { class: 'fb-blocks', role: 'list', 'data-page': p.id, 'aria-label': 'Blocks on page ' + (pi + 1) });
      ul.addEventListener('dragover', function (e) { if (!dragId) return; e.preventDefault(); ul.setAttribute('data-over', '1'); });
      ul.addEventListener('dragleave', function () { ul.removeAttribute('data-over'); });
      ul.addEventListener('drop', function (e) {
        e.preventDefault(); ul.removeAttribute('data-over');
        if (!dragId) return;
        var at = locate(dragId);
        if (!at) return;
        var idx = dropIndex(ul, e.clientY);
        snapshot('');
        at.page.fields.splice(at.fi, 1);
        if (at.page === p && at.fi < idx) idx--;
        p.fields.splice(idx, 0, at.field);
        dragId = null;
        changed(false);
        renderCanvas(at.field.id);
      });
      p.fields.forEach(function (f, fi) {
        var on = sel.kind === 'field' && sel.id === f.id;
        var pick = el('button', { type: 'button', class: 'fb-pick', 'data-id': f.id, 'aria-pressed': on ? 'true' : 'false', 'aria-describedby': 'fb-keys' },
          el('span', { class: 'fb-type', text: LABEL[f.type] || f.type }),
          el('span', { class: 'fb-label', text: summary(f) }),
          el('span', { class: 'fb-badges' }, badges(f)));
        pick.addEventListener('click', function () { select('field', f.id); });
        pick.addEventListener('keydown', function (e) {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveField(f.id, e.key === 'ArrowUp' ? -1 : 1); }
          else if (e.key === 'Delete') { e.preventDefault(); removeField(f.id); }
        });
        var li = el('li', { class: 'fb-block', draggable: 'true', 'data-selected': on ? '1' : '0' },
          el('span', { class: 'fb-grip', 'aria-hidden': 'true', text: '::' }), pick,
          el('span', { class: 'fb-tools' },
            el('button', { type: 'button', class: 'btn sm ghost', text: 'Up', 'aria-label': 'Move up: ' + summary(f), on: { click: function () { moveField(f.id, -1); } } }),
            el('button', { type: 'button', class: 'btn sm ghost', text: 'Down', 'aria-label': 'Move down: ' + summary(f), on: { click: function () { moveField(f.id, 1); } } }),
            el('button', { type: 'button', class: 'btn sm ghost', text: 'Copy', 'aria-label': 'Duplicate: ' + summary(f), on: { click: function () { dupField(f.id); } } }),
            el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove', 'aria-label': 'Remove: ' + summary(f), on: { click: function () { removeField(f.id); } } })));
        li.addEventListener('dragstart', function (e) { dragId = f.id; li.setAttribute('data-dragging', '1'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.id); } });
        li.addEventListener('dragend', function () { dragId = null; li.removeAttribute('data-dragging'); });
        ul.appendChild(li);
        void fi;
      });
      if (!p.fields.length) ul.appendChild(el('li', { class: 'fb-empty', text: 'This page has no blocks yet. Add one below.' }));
      canvas.appendChild(el('section', { class: 'fb-page', 'aria-label': 'Page ' + (pi + 1) }, head, ul, el('div', { class: 'fb-add-row' }, paletteSelect(p))));
    });
    canvas.appendChild(el('div', { class: 'fb-add-row' }, el('button', { type: 'button', class: 'btn', text: 'Add a page', on: { click: addPage } })));
    if (focusId) { var t = canvas.querySelector('[data-id="' + focusId + '"]'); if (t) t.focus(); }
  }

  // ---- inspector controls -------------------------------------------------------------------
  function field(label, control, hint) {
    var id = control.id || (control.id = nid());
    var wrap = el('div', { class: 'field' }, el('label', { for: id, text: label }), control);
    if (hint) wrap.appendChild(el('p', { class: 'hint', text: hint }));
    return wrap;
  }
  function textInput(obj, prop, o) {
    o = o || {};
    var n = el(o.multi ? 'textarea' : 'input', { class: 'input', value: obj[prop] === undefined ? '' : obj[prop], placeholder: o.placeholder, rows: o.multi ? 3 : null, type: o.multi ? null : (o.type || 'text'), maxlength: o.max });
    n.addEventListener('input', function () {
      snapshot((obj.id || '') + prop);
      var v = n.value;
      if (o.number) { if (v === '') delete obj[prop]; else obj[prop] = Number(v); }
      else if (v === '' && o.optional) delete obj[prop];
      else obj[prop] = v;
      if (o.after) o.after(v);
      changed(false);
    });
    return n;
  }
  function check(label, obj, prop, after) {
    var cb = el('input', { type: 'checkbox', checked: !!obj[prop] });
    cb.addEventListener('change', function () { snapshot(''); obj[prop] = cb.checked; if (after) after(); changed(true); });
    return el('label', { class: 'fb-check' }, cb, el('span', { text: label }));
  }
  function selectInput(options, value, onchange) {
    var s = el('select', { class: 'input' });
    options.forEach(function (o) { s.appendChild(el('option', { value: o[0], text: o[1], selected: String(o[0]) === String(value) })); });
    s.addEventListener('change', function () { snapshot(''); onchange(s.value); });
    return s;
  }

  // Conditions: a list of rules joined by "all" or "any".
  function sources(excludeId) {
    var out = [];
    allFields().forEach(function (f) { if (f.id !== excludeId && DISPLAY.indexOf(f.type) < 0 && f.type !== 'file_upload') out.push([f.id, f.label || LABEL[f.type]]); });
    def.calcs.forEach(function (c) { out.push([c.id, 'Calculation: ' + c.name]); });
    return out;
  }
  function valueControl(rule) {
    var f = allFields().filter(function (x) { return x.id === rule.field; })[0];
    if (rule.op === 'empty' || rule.op === 'not_empty') return null;
    var opts = null;
    if (f && f.options && (rule.op === 'is' || rule.op === 'is_not')) opts = f.options.map(function (o) { return [o.id, o.label]; });
    if (f && (f.type === 'yes_no' || f.type === 'consent') && (rule.op === 'is' || rule.op === 'is_not')) opts = [['yes', 'Yes'], ['no', 'No']];
    if (opts) {
      if (!rule.value || !opts.some(function (o) { return o[0] === rule.value; })) rule.value = opts[0][0];
      var s = selectInput(opts, rule.value, function (v) { rule.value = v; changed(false); });
      s.setAttribute('aria-label', 'Value');
      return s;
    }
    var cur = Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value === undefined ? '' : String(rule.value));
    var i = el('input', { class: 'input', value: cur, 'aria-label': rule.op === 'any_of' ? 'Values, separated by commas' : 'Value', placeholder: rule.op === 'any_of' ? 'a, b, c' : 'Value' });
    i.addEventListener('input', function () {
      snapshot('rule' + rule.field);
      rule.value = rule.op === 'any_of' ? i.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : i.value;
      changed(false);
    });
    return i;
  }
  function ruleEditor(getGroup, setGroup, label, excludeId) {
    var box = el('div', { class: 'fb-rules' });
    var g = getGroup();
    var src = sources(excludeId);
    box.appendChild(el('p', { class: 'fb-rules-title', text: label }));
    if (!g || !g.rules.length) box.appendChild(el('p', { class: 'hint', text: 'No rule. This always applies.' }));
    else {
      if (g.rules.length > 1) box.appendChild(selectInput([['all', 'All of these are true'], ['any', 'Any of these is true']], g.mode, function (v) { g.mode = v; changed(false); }));
      g.rules.forEach(function (r, i) {
        var row = el('div', { class: 'fb-rule', role: 'group', 'aria-label': 'Rule ' + (i + 1) });
        var fs = selectInput(src, r.field, function (v) { r.field = v; r.value = undefined; changed(true); });
        fs.setAttribute('aria-label', 'Question');
        var os = selectInput(OPS, r.op, function (v) { r.op = v; changed(true); });
        os.setAttribute('aria-label', 'Condition');
        row.appendChild(fs); row.appendChild(os);
        var vc = valueControl(r);
        if (vc) row.appendChild(vc);
        row.appendChild(el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove', 'aria-label': 'Remove rule ' + (i + 1), on: { click: function () { snapshot(''); g.rules.splice(i, 1); if (!g.rules.length) setGroup(null); changed(true); } } }));
        box.appendChild(row);
      });
    }
    var add = el('button', { type: 'button', class: 'btn sm', text: g && g.rules.length ? 'Add another rule' : 'Add a rule', disabled: src.length === 0, on: { click: function () {
      snapshot('');
      var grp = getGroup() || { mode: 'all', rules: [] };
      if (grp.rules.length >= 20) return;
      grp.rules.push({ field: src[0][0], op: 'is' });
      setGroup(grp); changed(true);
    } } });
    box.appendChild(add);
    if (src.length === 0) box.appendChild(el('p', { class: 'hint', text: 'Add a question first. Rules read answers to other questions.' }));
    return box;
  }

  // ---- inspector panels ---------------------------------------------------------------------
  function optionsEditor(f) {
    var box = el('div', { class: 'fb-opts' });
    box.appendChild(el('p', { class: 'fb-rules-title', text: 'Choices' }));
    var scored = f.options.some(function (o) { return o.points !== undefined; });
    f.options.forEach(function (o, i) {
      var row = el('div', { class: 'fb-opt' });
      var lab = textInput(o, 'label', { max: 200 });
      lab.setAttribute('aria-label', 'Choice ' + (i + 1));
      row.appendChild(lab);
      if (scored) { var pt = textInput(o, 'points', { number: true, type: 'number', optional: true }); pt.setAttribute('aria-label', 'Points for choice ' + (i + 1)); pt.className = 'input fb-points'; row.appendChild(pt); }
      row.appendChild(el('button', { type: 'button', class: 'btn sm ghost', text: 'Up', 'aria-label': 'Move choice ' + (i + 1) + ' up', disabled: i === 0, on: { click: function () { snapshot(''); f.options.splice(i - 1, 0, f.options.splice(i, 1)[0]); changed(true); } } }));
      row.appendChild(el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove', 'aria-label': 'Remove choice ' + (i + 1), disabled: f.options.length < 2, on: { click: function () { snapshot(''); f.options.splice(i, 1); changed(true); } } }));
      box.appendChild(row);
    });
    box.appendChild(el('div', { class: 'fb-row' },
      el('button', { type: 'button', class: 'btn sm', text: 'Add a choice', on: { click: function () { if (f.options.length >= 100) return; snapshot(''); f.options.push({ id: 'o' + (f.options.length + 1) + rnd('').slice(0, 3), label: 'Option ' + (f.options.length + 1) }); changed(true); } } }),
      el('button', { type: 'button', class: 'btn sm', text: scored ? 'Turn off points' : 'Score these choices', on: { click: function () { snapshot(''); f.options.forEach(function (o) { if (scored) delete o.points; else o.points = 0; }); changed(true); } } })));
    if (scored) box.appendChild(el('p', { class: 'hint', text: 'Each response gets the sum of the points of the choices it picked. Use it in rules, endings and calculations.' }));
    return box;
  }

  function blockPanel(f) {
    var p = el('div', { class: 'fb-panel' });
    p.appendChild(el('p', { class: 'fb-kind', text: LABEL[f.type] || f.type }));
    var isDisplay = DISPLAY.indexOf(f.type) >= 0;
    p.appendChild(field(f.type === 'section' ? 'Heading' : f.type === 'statement' ? 'Text' : 'Question', textInput(f, 'label', { multi: true, max: 500 })));
    if (f.type !== 'section' && f.type !== 'hidden') p.appendChild(field('Help text', textInput(f, 'description', { multi: true, optional: true, max: 1000 }), 'Shown under the question. Optional.'));
    if (!isDisplay && f.type !== 'hidden') p.appendChild(check('Required', f, 'required', null));
    if (['short_text', 'long_text', 'email', 'number', 'phone', 'url'].indexOf(f.type) >= 0) p.appendChild(field('Placeholder', textInput(f, 'placeholder', { optional: true, max: 200 })));
    if (f.options && CHOICE.indexOf(f.type) >= 0) p.appendChild(optionsEditor(f));
    if (SCALES.indexOf(f.type) >= 0) {
      if (f.type === 'rating' || f.type === 'scale') {
        p.appendChild(el('div', { class: 'fb-row' }, field('From', textInput(f, 'min', { number: true, type: 'number' })), field('To', textInput(f, 'max', { number: true, type: 'number' }))));
      }
      p.appendChild(el('div', { class: 'fb-row' }, field('Low end label', textInput(f, 'minLabel', { optional: true, max: 60 })), field('High end label', textInput(f, 'maxLabel', { optional: true, max: 60 }))));
    }
    if (f.type === 'file_upload') {
      var acc = el('input', { class: 'input', value: (f.accept || []).join(', ') });
      acc.addEventListener('input', function () { snapshot('accept'); f.accept = acc.value.split(',').map(function (x) { return x.trim().replace(/^\./, '').toLowerCase(); }).filter(Boolean); changed(false); });
      p.appendChild(field('Accepted file types', acc, 'Extensions, separated by commas. Programs and scripts are never accepted.'));
      p.appendChild(el('div', { class: 'fb-row' }, field('Largest file, in MB', textInput(f, 'maxSizeMb', { number: true, type: 'number' })), field('Number of files', textInput(f, 'maxFiles', { number: true, type: 'number' }))));
    }
    if (f.type === 'hidden') p.appendChild(field('URL parameter', textInput(f, 'param', { optional: true, max: 40 }), 'Filled from the link, for example ?' + (f.param || f.key) + '=value. Stored with the response and never shown.'));
    if (f.type !== 'section') {
      var key = textInput(f, 'key', { max: 40 });
      p.appendChild(field('Key', key, 'Used in piped answers like {{' + f.key + '}}, links and plain HTML posts. Letters, digits and underscores.'));
    }
    if (f.type !== 'hidden') {
      p.appendChild(ruleEditor(function () { return f.showIf; }, function (g) { if (g) f.showIf = g; else delete f.showIf; }, 'Show this block only when', f.id));
    }
    return p;
  }

  function pagePanel(pg) {
    var p = el('div', { class: 'fb-panel' });
    p.appendChild(field('Page title', textInput(pg, 'title', { optional: true, max: 200 }), 'Shown above the blocks on this page. Optional.'));
    p.appendChild(ruleEditor(function () { return pg.showIf; }, function (g) { if (g) pg.showIf = g; else delete pg.showIf; }, 'Show this page only when', null));
    p.appendChild(el('p', { class: 'fb-rules-title', text: 'After this page' }));
    p.appendChild(el('p', { class: 'hint', text: 'The first jump whose rule is true wins. With none, the form goes to the next page. Jumps only go forward.' }));
    var jumps = pg.jump || [];
    var idx = def.pages.indexOf(pg);
    var dests = [];
    def.pages.forEach(function (x, i) { if (i > idx) dests.push([x.id, 'Page ' + (i + 1) + (x.title ? ': ' + x.title : '')]); });
    def.endings.forEach(function (e) { dests.push(['end:' + e.id, 'Ending: ' + (e.title || 'Untitled')]); });
    jumps.forEach(function (j, i) {
      var row = el('div', { class: 'fb-jump' });
      row.appendChild(ruleEditor(function () { return j.when; }, function (g) { j.when = g || { mode: 'all', rules: [] }; }, 'Jump ' + (i + 1) + ' when', null));
      var to = selectInput(dests, j.to, function (v) { j.to = v; changed(false); });
      to.setAttribute('aria-label', 'Go to');
      row.appendChild(field('Go to', to));
      row.appendChild(el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove this jump', on: { click: function () { snapshot(''); pg.jump.splice(i, 1); if (!pg.jump.length) delete pg.jump; changed(true); } } }));
      p.appendChild(row);
    });
    p.appendChild(el('button', { type: 'button', class: 'btn sm', text: 'Add a jump', disabled: dests.length === 0, on: { click: function () {
      snapshot('');
      (pg.jump = pg.jump || []).push({ when: { mode: 'all', rules: [] }, to: dests[0][0] });
      changed(true);
    } } }));
    return p;
  }

  function endingsPanel() {
    var p = el('div', { class: 'fb-panel' });
    p.appendChild(el('p', { class: 'hint', text: 'People see the first ending whose rule is true. An ending with no rule is the fallback. Use {{key}} to put an answer in the text.' }));
    var cur = def.endings.filter(function (e) { return e.id === sel.id; })[0] || def.endings[0];
    sel = { kind: 'ending', id: cur.id };
    p.appendChild(selectInput(def.endings.map(function (e, i) { return [e.id, (i + 1) + '. ' + (e.title || 'Untitled')]; }), cur.id, function (v) { sel = { kind: 'ending', id: v }; renderInspector(); }));
    p.lastChild.setAttribute('aria-label', 'Choose an ending');
    p.appendChild(field('Title', textInput(cur, 'title', { max: 200 })));
    p.appendChild(field('Message', textInput(cur, 'body', { multi: true, max: 2000 })));
    p.appendChild(field('Button label', textInput(cur, 'buttonLabel', { optional: true, max: 60 })));
    p.appendChild(field('Button link', textInput(cur, 'buttonUrl', { optional: true, max: 1000, placeholder: 'https://' })));
    p.appendChild(field('Send people to this address instead', textInput(cur, 'redirectUrl', { optional: true, max: 1000, placeholder: 'https://' }), 'Skips the message above.'));
    if (cur.redirectUrl) p.appendChild(check('Add their answers to the address', cur, 'passAnswers', null));
    p.appendChild(ruleEditor(function () { return cur.when; }, function (g) { if (g) cur.when = g; else delete cur.when; }, 'Show this ending only when', null));
    p.appendChild(el('div', { class: 'fb-row' },
      el('button', { type: 'button', class: 'btn sm', text: 'Add an ending', disabled: def.endings.length >= 10, on: { click: function () { snapshot(''); var e = { id: rnd('e_'), title: 'Thank you', body: '', passAnswers: false }; def.endings.push(e); sel = { kind: 'ending', id: e.id }; changed(true); } } }),
      el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove this ending', disabled: def.endings.length < 2, on: { click: function () {
        snapshot('');
        def.endings = def.endings.filter(function (e) { return e.id !== cur.id; });
        def.pages.forEach(function (pg) { if (pg.jump) pg.jump = pg.jump.filter(function (j) { return j.to !== 'end:' + cur.id; }); });
        sel = { kind: 'ending', id: def.endings[0].id }; changed(true);
      } } })));
    return p;
  }

  function calcsPanel() {
    var p = el('div', { class: 'fb-panel' });
    p.appendChild(el('p', { class: 'hint', text: 'A calculation is a number worked out from answers. Write {key} for an answer, with + - * / and sum, min, max, round, abs, if. Choices count as their points. Example: round(sum({budget}, {seats}) / 2).' }));
    var refs = allFields().filter(function (f) { return DISPLAY.indexOf(f.type) < 0 && f.type !== 'file_upload'; }).map(function (f) { return '{' + f.id + '}'; });
    p.appendChild(el('p', { class: 'hint', text: 'Questions you can use: ' + (refs.slice(0, 12).join(' ') || 'none yet') + (refs.length > 12 ? ' and more' : '') }));
    def.calcs.forEach(function (c, i) {
      var row = el('div', { class: 'fb-calc' });
      row.appendChild(field('Name', textInput(c, 'name', { max: 60 })));
      row.appendChild(field('Formula', textInput(c, 'formula', { max: 500 })));
      row.appendChild(el('p', { class: 'hint', text: 'Use it as {{' + c.id + '}} in text or pick it in a rule.' }));
      row.appendChild(el('button', { type: 'button', class: 'btn sm ghost', text: 'Remove', 'aria-label': 'Remove calculation ' + (i + 1), on: { click: function () { snapshot(''); def.calcs.splice(i, 1); changed(true); } } }));
      p.appendChild(row);
    });
    p.appendChild(el('button', { type: 'button', class: 'btn sm', text: 'Add a calculation', disabled: def.calcs.length >= 20, on: { click: function () { snapshot(''); def.calcs.push({ id: rnd('c_'), name: 'Total', formula: '' }); changed(true); } } }));
    return p;
  }

  function formPanel() {
    var p = el('div', { class: 'fb-panel' });
    var hasIntro = !!def.intro;
    var cb = el('input', { type: 'checkbox', checked: hasIntro });
    cb.addEventListener('change', function () { snapshot(''); if (cb.checked) def.intro = { title: '', body: '', buttonLabel: 'Start' }; else delete def.intro; changed(true); });
    p.appendChild(el('label', { class: 'fb-check' }, cb, el('span', { text: 'Show a short introduction above the form' })));
    if (def.intro) {
      p.appendChild(field('Introduction', textInput(def.intro, 'body', { multi: true, max: 2000 })));
    }
    p.appendChild(field('Submit button label', textInput(def, 'submitLabel', { max: 40 })));
    p.appendChild(check('Show progress on multi-page forms', def, 'showProgress', null));
    return p;
  }

  var TABS = [['block', 'Block'], ['page', 'Page'], ['endings', 'Endings'], ['calcs', 'Calculations'], ['form', 'Form']];
  function renderInspector() {
    inspector.textContent = '';
    var list = el('div', { class: 'fb-tabs', role: 'tablist', 'aria-label': 'Editor sections' });
    TABS.forEach(function (t) {
      var b = el('button', { type: 'button', role: 'tab', id: 'fb-tab-' + t[0], 'aria-selected': tab === t[0] ? 'true' : 'false', tabindex: tab === t[0] ? '0' : '-1', 'aria-controls': 'fb-panel', text: t[1] });
      b.addEventListener('click', function () { tab = t[0]; renderInspector(); });
      b.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        var i = TABS.findIndex(function (x) { return x[0] === tab; });
        tab = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
        renderInspector();
        var nb = document.getElementById('fb-tab-' + tab); if (nb) nb.focus();
      });
      list.appendChild(b);
    });
    inspector.appendChild(list);
    var body = el('div', { id: 'fb-panel', role: 'tabpanel', 'aria-labelledby': 'fb-tab-' + tab, tabindex: '0' });
    if (tab === 'block') {
      var at = sel.kind === 'field' ? locate(sel.id) : null;
      body.appendChild(at ? blockPanel(at.field) : el('p', { class: 'hint fb-none', text: 'Select a block on the left to edit it, or add one.' }));
    } else if (tab === 'page') {
      var pg = (sel.kind === 'page' ? pageOf(sel.id) : null) || (sel.kind === 'field' && locate(sel.id) ? locate(sel.id).page : def.pages[0]);
      body.appendChild(pagePanel(pg));
    } else if (tab === 'endings') body.appendChild(endingsPanel());
    else if (tab === 'calcs') body.appendChild(calcsPanel());
    else body.appendChild(formPanel());
    inspector.appendChild(body);
  }
  function renderAll() { renderCanvas(); renderInspector(); }

  // ---- publish, history, shortcuts ----------------------------------------------------------
  function publish() {
    publishBtn.disabled = true;
    publishBtn.setAttribute('aria-busy', 'true');
    clearTimeout(saveTimer);
    var go = function () {
      return fetch(API + '/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok) { showBanner((r.j && r.j.message) || 'The form could not be published.', false); toast('Not published', 'error'); return; }
          liveNote.hidden = true;
          toast('Published. The changes are live.', 'ok');
          var share = document.getElementById('fb-share'); if (share) share.hidden = false;
          setStatus('Published', 'ok');
        })
        .catch(function () { toast('Could not reach the server. Try again.', 'error'); })
        .then(function () { publishBtn.disabled = false; publishBtn.removeAttribute('aria-busy'); });
    };
    (dirty ? save() : Promise.resolve()).then(go);
  }
  publishBtn.addEventListener('click', publish);
  undoBtn.addEventListener('click', function () { jump(undoStack, redoStack); });
  redoBtn.addEventListener('click', function () { jump(redoStack, undoStack); });

  var hist = document.getElementById('fb-history-list');
  var histBtn = document.querySelector('[data-open="fb-history"]');
  function loadHistory() {
    hist.textContent = '';
    hist.appendChild(el('p', { class: 'hint', text: 'Loading versions' }));
    fetch(API + '/versions').then(function (r) { return r.json(); }).then(function (j) {
      hist.textContent = '';
      if (!j.items || !j.items.length) { hist.appendChild(el('p', { class: 'hint', text: 'No earlier versions yet. A version is kept each time you publish, and every few minutes while you edit.' })); return; }
      var ul = el('ul', { class: 'fb-versions', role: 'list' });
      j.items.forEach(function (v) {
        var when = new Date(v.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        var b = el('button', { type: 'button', class: 'btn sm', text: 'Restore', 'aria-label': 'Restore the version from ' + when, on: { click: function () {
          if (!window.confirm('Restore this version into the editor? Your current draft is kept as a version first.')) return;
          b.disabled = true;
          fetch(API + '/versions/' + v.id + '/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, x: x }; }); })
            .then(function (r) {
              if (!r.ok) { toast((r.x && r.x.message) || 'Could not restore that version.', 'error'); b.disabled = false; return; }
              def = r.x.definition; rev = r.x.rev; undoStack = []; redoStack = []; stale = false; dirty = false;
              sel = { kind: 'page', id: def.pages[0].id }; tab = 'page';
              renderAll(); syncHistoryButtons(); setStatus('All changes saved', 'ok'); showBanner('');
              liveNote.hidden = !r.x.unpublishedChanges;
              histBtn.closest('body').querySelector('#fb-history').close();
              toast('Version restored.', 'ok');
            });
        } } });
        ul.appendChild(el('li', {}, el('span', {}, el('b', { text: v.kind === 'published' ? 'Published' : 'Saved while editing' }), ' ', el('span', { class: 'hint', text: when + ', ' + v.questions + (v.questions === 1 ? ' question' : ' questions') })), b));
      });
      hist.appendChild(ul);
    }).catch(function () { hist.textContent = ''; hist.appendChild(el('p', { class: 'hint', text: 'Could not load versions. Check your connection and open this again.' })); });
  }
  if (histBtn) histBtn.addEventListener('click', loadHistory);

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) jump(redoStack, undoStack); else jump(undoStack, redoStack);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); jump(redoStack, undoStack); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); clearTimeout(saveTimer); save(); }
  });

  renderAll();
  syncHistoryButtons();
  setStatus('All changes saved', 'ok');
})();
