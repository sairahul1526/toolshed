/* Toolshed Forms, public page. Progressive enhancement: the form posts fine without this file.
   The logic section mirrors src/modules/forms/logic.ts; logic.test.ts checks the two agree. */
(function () {
  'use strict';

  // ---- logic mirror -------------------------------------------------------------------------
  var CHOICE = ['single_choice', 'multiple_choice', 'dropdown', 'yes_no'];
  function isNum(v) { return v !== '' && v !== null && v !== undefined && typeof v !== 'boolean' && isFinite(Number(v)); }
  function isEmpty(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0); }
  function norm(v) { return String(v).trim().toLowerCase(); }
  function items(v) { return Array.isArray(v) ? v.map(function (x) { return typeof x === 'object' && x ? String(x.name) : String(x); }) : [String(v)]; }

  function evalCondition(c, values) {
    var v = values[c.field], want = c.value, list;
    switch (c.op) {
      case 'empty': return isEmpty(v);
      case 'not_empty': return !isEmpty(v);
      case 'is':
        if (isEmpty(v)) return false;
        if (Array.isArray(v)) return items(v).some(function (x) { return norm(x) === norm(want); });
        return isNum(v) && isNum(want) ? Number(v) === Number(want) : norm(v) === norm(want);
      case 'is_not': return !evalCondition({ field: c.field, op: 'is', value: want }, values);
      case 'contains': return !isEmpty(v) && items(v).some(function (x) { return norm(x).indexOf(norm(want)) >= 0; });
      case 'not_contains': return !evalCondition({ field: c.field, op: 'contains', value: want }, values);
      case 'any_of':
        list = (Array.isArray(want) ? want : [want]).map(norm);
        return !isEmpty(v) && items(v).some(function (x) { return list.indexOf(norm(x)) >= 0; });
      case 'gt': return isNum(v) && isNum(want) && Number(v) > Number(want);
      case 'gte': return isNum(v) && isNum(want) && Number(v) >= Number(want);
      case 'lt': return isNum(v) && isNum(want) && Number(v) < Number(want);
      case 'lte': return isNum(v) && isNum(want) && Number(v) <= Number(want);
    }
    return false;
  }
  function evalGroup(g, values) {
    if (!g || !g.rules || g.rules.length === 0) return true;
    return g.mode === 'any' ? g.rules.some(function (r) { return evalCondition(r, values); }) : g.rules.every(function (r) { return evalCondition(r, values); });
  }

  function lex(src) {
    var out = [], re = /\s*(?:(\d+(?:\.\d+)?)|\{([A-Za-z][A-Za-z0-9_-]*)\}|([a-z]+)|(>=|<=|==|!=|[-+*\/(),<>]))/y, pos = 0, m;
    while (pos < src.length) {
      if (/^\s*$/.test(src.slice(pos))) break;
      re.lastIndex = pos;
      m = re.exec(src);
      if (!m) return null;
      pos = re.lastIndex;
      if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
      else if (m[2] !== undefined) out.push({ t: 'ref', v: m[2] });
      else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
      else out.push({ t: 'op', v: m[4] });
    }
    return out;
  }
  var FUNCS = ['sum', 'min', 'max', 'round', 'abs', 'if'];

  function allFields(def) {
    var out = [];
    def.pages.forEach(function (p) { p.fields.forEach(function (f) { out.push(f); }); });
    return out;
  }
  function numericValue(field, v) {
    if (v === undefined || isEmpty(v)) return 0;
    if (field && CHOICE.indexOf(field.type) >= 0 && field.options) {
      var picked = Array.isArray(v) ? v.map(String) : [String(v)];
      return picked.reduce(function (sum, id) {
        var o = field.options.filter(function (x) { return x.id === id; })[0];
        return sum + (o && o.points ? o.points : 0);
      }, 0);
    }
    if (Array.isArray(v)) return v.length;
    if (v === 'yes') return 1;
    if (v === 'no') return 0;
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function evalFormula(formula, ref) {
    var toks = lex(formula), i = 0, bad = false;
    if (!toks || toks.length === 0) return 0;
    function peek() { return toks[i]; }
    function eat(v) { var t = toks[i]; if (t && t.t === 'op' && t.v === v) { i++; return true; } return false; }
    function compare() {
      var a = sumExpr();
      for (;;) {
        var t = peek();
        if (!t || t.t !== 'op' || ['>', '<', '>=', '<=', '==', '!='].indexOf(t.v) < 0) return a;
        i++;
        var b = sumExpr();
        a = (t.v === '>' ? a > b : t.v === '<' ? a < b : t.v === '>=' ? a >= b : t.v === '<=' ? a <= b : t.v === '==' ? a === b : a !== b) ? 1 : 0;
      }
    }
    function sumExpr() {
      var a = term();
      for (;;) { if (eat('+')) a += term(); else if (eat('-')) a -= term(); else return a; }
    }
    function term() {
      var a = unary();
      for (;;) {
        if (eat('*')) a *= unary();
        else if (eat('/')) { var b = unary(); a = b === 0 ? 0 : a / b; }
        else return a;
      }
    }
    function unary() { return eat('-') ? -unary() : primary(); }
    function primary() {
      var t = toks[i++];
      if (!t) { bad = true; return 0; }
      if (t.t === 'num') return t.v;
      if (t.t === 'ref') return ref(t.v);
      if (t.t === 'op' && t.v === '(') { var v = compare(); if (!eat(')')) bad = true; return v; }
      if (t.t === 'id' && FUNCS.indexOf(t.v) >= 0 && eat('(')) {
        var args = [];
        if (!eat(')')) {
          do { args.push(compare()); } while (eat(','));
          if (!eat(')')) bad = true;
        }
        switch (t.v) {
          case 'sum': return args.reduce(function (a, b) { return a + b; }, 0);
          case 'min': return args.length ? Math.min.apply(null, args) : 0;
          case 'max': return args.length ? Math.max.apply(null, args) : 0;
          case 'round': return Math.round(args[0] || 0);
          case 'abs': return Math.abs(args[0] || 0);
          default: return (args[0] || 0) !== 0 ? (args[1] || 0) : (args[2] || 0);
        }
      }
      bad = true;
      return 0;
    }
    var result = compare();
    if (bad || i < toks.length || !isFinite(result)) return 0;
    return Math.round(result * 1e6) / 1e6;
  }

  function computeCalcs(def, answers) {
    var fields = {}, out = {};
    allFields(def).forEach(function (f) { fields[f.id] = f; });
    def.calcs.forEach(function (c) {
      out[c.id] = evalFormula(c.formula, function (id) { return id in out ? out[id] : numericValue(fields[id], answers[id]); });
    });
    return out;
  }
  function computeScore(def, answers) {
    var any = false, total = 0;
    allFields(def).forEach(function (f) {
      if (!f.options || !f.options.some(function (o) { return o.points !== undefined; })) return;
      any = true;
      total += numericValue(f, answers[f.id]);
    });
    return any ? total : null;
  }
  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  function walk(def, values) {
    var pages = [], visible = [], forced, i = 0;
    while (i < def.pages.length) {
      var page = def.pages[i];
      if (!evalGroup(page.showIf, values)) { i++; continue; }
      pages.push(page.id);
      page.fields.forEach(function (f) { if (evalGroup(f.showIf, values)) visible.push(f.id); });
      var jump = (page.jump || []).filter(function (j) { return evalGroup(j.when, values); })[0];
      if (!jump) { i++; continue; }
      if (jump.to.indexOf('end:') === 0) { forced = jump.to.slice(4); break; }
      var target = -1;
      def.pages.forEach(function (p, idx) { if (target < 0 && p.id === jump.to) target = idx; });
      i = target > i ? target : i + 1;
    }
    var path = { pages: pages, visible: visible };
    if (forced) path.forcedEnding = forced;
    return path;
  }
  function resolve(def, answers) {
    var first = walk(def, merge(answers, computeCalcs(def, answers))), kept = {};
    Object.keys(answers).forEach(function (id) { if (first.visible.indexOf(id) >= 0) kept[id] = answers[id]; });
    var calcs = computeCalcs(def, kept);
    return { path: walk(def, merge(kept, calcs)), answers: kept, calcs: calcs };
  }
  function pickEnding(def, values, forced) {
    var hit;
    if (forced) { hit = def.endings.filter(function (e) { return e.id === forced; })[0]; if (hit) return hit; }
    hit = def.endings.filter(function (e) { return e.when && e.when.rules.length > 0 && evalGroup(e.when, values); })[0];
    return hit || def.endings.filter(function (e) { return !e.when || e.when.rules.length === 0; })[0] || def.endings[def.endings.length - 1];
  }
  function displayValue(field, v) {
    if (v === undefined || isEmpty(v)) return '';
    function label(id) { var o = field && field.options && field.options.filter(function (x) { return x.id === id; })[0]; return o ? o.label : id; }
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object') return v.map(function (f) { return f.name; }).join(', ');
      return v.map(label).join(', ');
    }
    if (field && CHOICE.indexOf(field.type) >= 0 && field.type !== 'yes_no') return label(v);
    if (field && field.type === 'yes_no') return v === 'yes' ? 'Yes' : 'No';
    if (field && field.type === 'consent') return v === 'yes' ? 'Yes' : 'No';
    return String(v);
  }
  function pipe(text, def, values) {
    if (text.indexOf('{{') < 0) return text;
    var fields = allFields(def);
    return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g, function (_m, name) {
      var f = fields.filter(function (x) { return x.key === name || x.id === name; })[0];
      if (f) return displayValue(f, values[f.id]);
      var c = def.calcs.filter(function (x) { return x.id === name; })[0];
      return c && values[c.id] !== undefined ? String(values[c.id]) : '';
    });
  }

  var logic = { evalCondition: evalCondition, evalGroup: evalGroup, evalFormula: evalFormula, numericValue: numericValue, computeCalcs: computeCalcs, computeScore: computeScore, walk: walk, resolve: resolve, pickEnding: pickEnding, displayValue: displayValue, pipe: pipe, isEmpty: isEmpty };
  if (typeof globalThis !== 'undefined') globalThis.__toolshedFormLogic = logic;
  if (typeof document === 'undefined') return;

  // ---- page ---------------------------------------------------------------------------------
  var defEl = document.getElementById('fm-def');
  var form = document.querySelector('form.fm');
  if (!defEl || !form) return;
  var def = JSON.parse(defEl.textContent || '{}');
  var slug = form.getAttribute('data-slug');
  var root = document.querySelector('.fm-root');
  var embed = root && root.getAttribute('data-embed') === '1';
  var token = form.querySelector('[name=_token]').value;
  var cid = form.querySelector('[data-cid]');
  var pageEls = [].slice.call(form.querySelectorAll('.fm-page'));
  var backBtn = form.querySelector('[data-back]');
  var nextBtn = form.querySelector('[data-next]');
  var submitBtn = form.querySelector('[data-submit-btn]');
  var formError = form.querySelector('[data-form-error]');
  var progress = form.querySelector('[data-progress-bar]');
  var done = document.querySelector('[data-done]');
  var multi = def.pages.length > 1;
  var partial = form.getAttribute('data-partial') === '1';
  var current = 0; // index into path.pages
  var path = { pages: def.pages.map(function (p) { return p.id; }), visible: [] };
  var uploads = {}; // field id -> [{id,name}]
  var busy = false, started = false, saveTimer = 0, sentPages = {};
  var fieldsById = {};
  allFields(def).forEach(function (f) { fieldsById[f.id] = f; });

  cid.value = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 40);

  function beacon(t, k) {
    try { fetch('/f/' + slug + '/e', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: t, k: k, token: token }), keepalive: true }); } catch (e) { /* counting is best effort */ }
  }

  function collect() {
    var a = {};
    allFields(def).forEach(function (f) {
      if (f.type === 'section' || f.type === 'statement') return;
      if (f.type === 'file_upload') { if (uploads[f.id] && uploads[f.id].length) a[f.id] = uploads[f.id].map(function (u) { return u.id; }); return; }
      var els = [].slice.call(form.querySelectorAll('[name="' + f.id + '"]'));
      if (!els.length) return;
      var kind = els[0].type;
      if (kind === 'checkbox') {
        var on = els.filter(function (e) { return e.checked; }).map(function (e) { return e.value; });
        if (on.length) a[f.id] = f.type === 'consent' ? on[0] : on;
      } else if (kind === 'radio') {
        var r = els.filter(function (e) { return e.checked; })[0];
        if (r) a[f.id] = r.value;
      } else if (els[0].value !== '') a[f.id] = els[0].value;
    });
    return a;
  }

  function fieldEl(id) { return form.querySelector('.fm-field[data-field="' + id + '"], [data-field="' + id + '"]'); }

  function refresh() {
    var answers = collect();
    var res = resolve(def, answers);
    path = res.path;
    var vis = {};
    path.visible.forEach(function (id) { vis[id] = true; });
    def.pages.forEach(function (p) {
      p.fields.forEach(function (f) {
        var el = fieldEl(f.id);
        if (!el) return;
        var show = !!vis[f.id];
        el.hidden = !show;
        [].forEach.call(el.querySelectorAll('input,select,textarea'), function (i) { if (f.type !== "file_upload") i.disabled = !show; });
      });
    });
    if (current >= path.pages.length) current = Math.max(0, path.pages.length - 1);
    pageEls.forEach(function (el) {
      var id = el.getAttribute('data-page');
      el.hidden = multi ? path.pages[current] !== id : path.pages.indexOf(id) < 0;
    });
    var last = !multi || current >= path.pages.length - 1 || !!path.forcedEnding && current >= path.pages.length - 1;
    backBtn.hidden = !multi || current === 0;
    nextBtn.hidden = !multi || last;
    submitBtn.hidden = multi && !last;
    if (def.showProgress && multi) {
      progress.hidden = false;
      form.querySelector('[data-bar]').style.width = Math.round(((current + 1) / Math.max(1, path.pages.length)) * 100) + '%';
      form.querySelector('[data-count]').textContent = 'Step ' + (current + 1) + ' of ' + path.pages.length;
    }
    // Pipe answers into labels that carry {{ }}.
    var values = merge(res.answers, res.calcs);
    [].forEach.call(form.querySelectorAll('[data-pipe]'), function (el) { el.textContent = pipe(el.getAttribute('data-pipe'), def, values); });
    resize();
    return res;
  }

  function setError(id, msg) {
    var el = fieldEl(id);
    if (!el) return;
    var out = el.querySelector('.pub-error');
    el.classList.toggle('has-error', !!msg);
    if (out) { out.textContent = msg || ''; out.hidden = !msg; }
    [].forEach.call(el.querySelectorAll('input,select,textarea'), function (i) { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); });
  }
  function clearErrors() { allFields(def).forEach(function (f) { setError(f.id, ''); }); formError.hidden = true; }

  function checkField(f, v) {
    if (f.type === 'section' || f.type === 'statement' || f.type === 'hidden') return '';
    if (isEmpty(v)) return f.required ? (f.type === 'consent' ? 'Tick this box to continue.' : f.type === 'file_upload' ? 'Add a file to continue.' : 'This question needs an answer.') : '';
    var s = String(v);
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Enter an email address like name@example.com.';
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(s)) return 'Enter a link that starts with http:// or https://.';
    if (f.type === 'number' && !isNum(s)) return 'Enter a number.';
    return '';
  }
  function checkPage(pageId) {
    var res = resolve(def, collect()), bad = null;
    var page = def.pages.filter(function (p) { return p.id === pageId; })[0];
    page.fields.forEach(function (f) {
      if (res.path.visible.indexOf(f.id) < 0) return;
      var msg = checkField(f, res.answers[f.id]);
      setError(f.id, msg);
      if (msg && !bad) bad = f.id;
    });
    if (bad) { var el = fieldEl(bad).querySelector('input,select,textarea'); if (el) el.focus(); }
    return !bad;
  }

  function show(i) {
    current = i;
    refresh();
    var cur = pageEls.filter(function (el) { return !el.hidden; })[0];
    if (cur && multi) { var h = cur.querySelector('input:not([type=hidden]),select,textarea'); if (h) h.focus({ preventScroll: false }); }
    if (!sentPages[path.pages[current]]) { sentPages[path.pages[current]] = 1; beacon('page', path.pages[current]); }
  }

  nextBtn.addEventListener('click', function () { if (checkPage(path.pages[current])) show(current + 1); });
  backBtn.addEventListener('click', function () { clearErrors(); show(Math.max(0, current - 1)); });

  function body(extra) {
    var res = resolve(def, collect());
    var o = { answers: res.answers, _token: token, _cid: cid.value, _gotcha: (form.querySelector('[name=_gotcha]') || {}).value || '', _beacon: '1' };
    var acc = form.querySelector('[name=_access]');
    if (acc) o._access = acc.value;
    for (var k in extra) o[k] = extra[k];
    return JSON.stringify(o);
  }

  function resize() {
    if (!embed || !window.parent || window.parent === window) return;
    window.parent.postMessage({ type: 'toolshed-form-height', slug: slug, height: Math.ceil(document.documentElement.scrollHeight) }, '*');
  }

  function showDone(r) {
    form.hidden = true;
    var res = resolve(def, collect());
    var values = merge(res.answers, res.calcs);
    var e = r.ending || pickEnding(def, values, res.path.forcedEnding);
    done.hidden = false;
    done.textContent = '';
    var h = document.createElement('h2'); h.className = 'fm-page-title'; h.textContent = r.ending ? e.title : pipe(e.title || 'Thank you', def, values); done.appendChild(h);
    var text = r.ending ? e.body : pipe(e.body || '', def, values);
    if (text) { var p = document.createElement('p'); p.textContent = text; done.appendChild(p); }
    if (e.buttonLabel && e.buttonUrl && /^https?:\/\//i.test(e.buttonUrl)) { var a = document.createElement('a'); a.className = 'pub-btn'; a.href = e.buttonUrl; a.textContent = e.buttonLabel; a.rel = 'noopener'; done.appendChild(a); }
    var title = document.querySelector('.fm-title'); if (title) title.hidden = true;
    var intro = document.querySelector('[data-intro]'); if (intro) intro.hidden = true;
    progress.hidden = true;
    done.focus();
    resize();
  }

  function fail(err, status) {
    if (err && err.fields) { Object.keys(err.fields).forEach(function (id) { setError(id, err.fields[id]); }); }
    var first = err && err.fields ? Object.keys(err.fields)[0] : null;
    if (first) {
      var pi = -1;
      def.pages.forEach(function (p, idx) { if (pi < 0 && p.fields.some(function (f) { return f.id === first; })) pi = idx; });
      var inPath = path.pages.indexOf(def.pages[pi] && def.pages[pi].id);
      if (multi && inPath >= 0) show(inPath);
      var el = fieldEl(first); if (el) { var i = el.querySelector('input,select,textarea'); if (i) i.focus(); }
    }
    formError.textContent = status === 429 ? 'You have sent a lot of responses. Wait a few minutes and try again.' : (err && err.message) || 'We couldn’t send that. Check your connection and try again.';
    formError.hidden = false;
    resize();
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    clearErrors();
    var ok = true;
    path.pages.forEach(function (id, idx) { if (!checkPage(id) && ok) { ok = false; show(idx); } });
    if (!ok) { formError.textContent = 'Some answers need another look.'; formError.hidden = false; return; }
    busy = true;
    submitBtn.disabled = true;
    submitBtn.setAttribute('aria-busy', 'true');
    var label = submitBtn.textContent;
    submitBtn.textContent = 'Sending';
    fetch('/f/' + slug + '/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body({}) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (r) {
        if (r.status >= 400 || !r.json.ok) return fail(r.json, r.status);
        if (r.json.redirect) { if (embed && window.parent !== window) window.parent.postMessage({ type: 'toolshed-form-done', slug: slug }, '*'); window.location.assign(r.json.redirect); return; }
        if (embed && window.parent !== window) window.parent.postMessage({ type: 'toolshed-form-done', slug: slug }, '*');
        showDone(r.json);
      })
      .catch(function () { fail(null, 0); })
      .then(function () { busy = false; submitBtn.disabled = false; submitBtn.removeAttribute('aria-busy'); submitBtn.textContent = label; });
  });

  // Uploads: each file goes to its own endpoint and comes back as a small reference.
  [].forEach.call(form.querySelectorAll('[data-file]'), function (box) {
    var fid = box.getAttribute('data-field');
    var input = box.querySelector('input[type=file]');
    var list = box.querySelector('[data-list]');
    var max = Number(box.getAttribute('data-max')) || 1;
    var accept = box.getAttribute('data-accept');
    var note = box.querySelector('.fm-nojs');
    input.disabled = false;
    if (note) note.hidden = true;
    if (accept) input.setAttribute('accept', accept.split(',').map(function (e) { return '.' + e; }).join(','));
    if (max > 1) input.multiple = true;
    uploads[fid] = [];
    function draw() {
      list.textContent = '';
      uploads[fid].forEach(function (u, idx) {
        var li = document.createElement('li');
        var t = document.createElement('span'); t.textContent = u.name; li.appendChild(t);
        var b = document.createElement('button'); b.type = 'button'; b.className = 'fm-link'; b.textContent = 'Remove'; b.setAttribute('aria-label', 'Remove ' + u.name);
        b.addEventListener('click', function () { uploads[fid].splice(idx, 1); draw(); schedule(); });
        li.appendChild(b); list.appendChild(li);
      });
    }
    input.addEventListener('change', function () {
      var files = [].slice.call(input.files || []);
      setError(fid, '');
      files.forEach(function (file) {
        if (uploads[fid].length >= max) { setError(fid, 'You can add up to ' + max + (max === 1 ? ' file.' : ' files.')); return; }
        var li = document.createElement('li'); li.textContent = 'Uploading ' + file.name; li.className = 'fm-busy'; list.appendChild(li);
        var fd = new FormData();
        fd.append('file', file); fd.append('field', fid); fd.append('_token', token);
        var acc = form.querySelector('[name=_access]'); if (acc) fd.append('_access', acc.value);
        fetch('/f/' + slug + '/upload', { method: 'POST', body: fd })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (r) { if (r.ok && r.j.file) uploads[fid].push(r.j.file); else setError(fid, (r.j && r.j.message) || 'That file could not be added.'); })
          .catch(function () { setError(fid, 'The upload failed. Check your connection and try again.'); })
          .then(function () { draw(); schedule(); });
      });
      input.value = '';
    });
  });

  // Optional partial saves, only when the form owner turned them on.
  function save() {
    if (!partial || busy) return;
    var res = resolve(def, collect());
    if (!Object.keys(res.answers).length) return;
    fetch('/f/' + slug + '/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body({ partial: true }), keepalive: true }).catch(function () { /* the next change tries again */ });
  }
  function schedule() {
    refresh();
    if (!started) { started = true; beacon('start'); }
    if (!partial) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 2000);
  }
  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);

  // Hidden fields: the server fills them from the address; this covers a form opened from a cached page.
  var qs = new URLSearchParams(window.location.search);
  [].forEach.call(form.querySelectorAll('[data-param]'), function (el) { var v = qs.get(el.getAttribute('data-param')); if (v && !el.value) el.value = v.slice(0, 500); });

  // Enter in a text input on a middle page goes to the next page instead of sending.
  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && multi && !nextBtn.hidden && e.target.tagName === 'INPUT' && e.target.type !== 'submit') { e.preventDefault(); nextBtn.click(); }
  });

  if (window.ResizeObserver && embed) new ResizeObserver(resize).observe(document.documentElement);
  window.addEventListener('pagehide', function () { if (partial && !busy) save(); });
  refresh();
  sentPages[path.pages[0]] = 1;
  beacon('view');
  form.classList.add('is-ready');
})();
