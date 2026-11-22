/* Feedback portal: small enhancements. Every page works without this file. */
(function () {
  'use strict';
  var d = document;

  function post(form) {
    var body = new URLSearchParams(new FormData(form));
    return fetch(form.action, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, json: j }; });
    });
  }

  d.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.hasAttribute) return;
    if (form.hasAttribute('data-vote-form')) {
      e.preventDefault();
      var btn = form.querySelector('[data-vote]');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      post(form).then(function (res) {
        btn.disabled = false;
        var j = res.json || {};
        if (j.signIn) { location.href = j.signIn; return; }
        if (j.error) { flash(form, j.error); return; }
        btn.setAttribute('aria-pressed', j.voted ? 'true' : 'false');
        var n = btn.querySelector('[data-count]');
        if (n && !j.hidden) n.textContent = String(j.count);
        var label = btn.getAttribute('aria-label') || '';
        btn.setAttribute('aria-label', j.voted ? label.replace(/^Vote for/, 'Remove your vote from') : label.replace(/^Remove your vote from/, 'Vote for'));
      }).catch(function () { btn.disabled = false; form.submit(); });
      return;
    }
    if (form.hasAttribute('data-busy-form')) {
      var s = form.querySelector('button[type="submit"]');
      if (s) setTimeout(function () { s.disabled = true; s.setAttribute('aria-busy', 'true'); }, 0);
    }
  });

  function flash(form, text) {
    var p = d.createElement('p');
    p.className = 'fb-note bad';
    p.setAttribute('role', 'alert');
    p.textContent = text;
    var host = form.closest('.fb-row, .fb-post-head') || form;
    host.parentNode.insertBefore(p, host.nextSibling);
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 5000);
  }

  // Similar ideas while typing a title.
  var title = d.querySelector('[data-similar-title]');
  var list = d.querySelector('[data-similar]');
  if (title && list) {
    var form = title.form;
    var url = form && form.getAttribute('data-similar-url');
    var timer = 0, seq = 0;
    var ask = function () {
      var q = title.value.trim();
      if (!url || q.length < 4) { list.hidden = true; return; }
      var my = ++seq;
      var board = form.querySelector('[name="board"]');
      var u = url + '?q=' + encodeURIComponent(q) + (board && board.value ? '&board=' + encodeURIComponent(board.value) : '');
      var embed = form.querySelector('[name="embed"]');
      if (embed) u += '&embed=1';
      var vt = form.querySelector('[name="vt"]');
      if (vt) u += '&vt=' + encodeURIComponent(vt.value);
      fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
        if (my !== seq) return;
        list.textContent = '';
        var items = (j && j.items) || [];
        if (!items.length) { list.hidden = true; return; }
        var h = d.createElement('li');
        h.className = 'fb-hint';
        h.textContent = 'Already shared? Vote there instead.';
        list.appendChild(h);
        items.forEach(function (it) {
          var li = d.createElement('li');
          var a = d.createElement('a');
          a.href = it.url;
          a.textContent = it.title + (it.votes === null ? '' : ' (' + it.votes + (it.votes === 1 ? ' vote)' : ' votes)'));
          li.appendChild(a);
          list.appendChild(li);
        });
        list.hidden = false;
      }).catch(function () { list.hidden = true; });
    };
    title.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(ask, 350); });
  }

  // Only offer categories that belong to the chosen board.
  var bsel = d.querySelector('[data-board-select]');
  var csel = d.querySelector('[data-category-select]');
  if (bsel && csel) {
    var sync = function () {
      var opts = csel.querySelectorAll('option[data-board]');
      for (var i = 0; i < opts.length; i++) {
        var on = opts[i].getAttribute('data-board') === bsel.value;
        opts[i].hidden = !on;
        opts[i].disabled = !on;
        if (!on && opts[i].selected) csel.value = '';
      }
    };
    bsel.addEventListener('change', sync);
    sync();
  }

  // Tell a parent page (the widget) how tall the embed is.
  if (d.body.hasAttribute('data-embed') && window.parent !== window) {
    try { window.parent.postMessage({ toolshedFeedback: 'ready' }, '*'); } catch (e) { /* ignore */ }
  }
})();
