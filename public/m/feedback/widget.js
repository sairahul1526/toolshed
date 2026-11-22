/*! Toolshed feedback widget. No dependencies. Add: <script src="https://YOUR-HOST/m/feedback/widget.js" data-portal="your-slug" defer></script> */
(function () {
  'use strict';
  try {
    var s = document.currentScript;
    if (!s || window.ToolshedFeedback) return;
    var a = function (k, f) { return s.getAttribute('data-' + k) || f; };
    var slug = a('portal', '');
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return;
    var origin = new URL(s.src, location.href).origin;
    var mode = a('mode', 'feedback');
    var changelog = mode === 'changelog';
    var label = a('label', changelog ? "What's new" : 'Feedback');
    var pos = a('position', 'right') === 'left' ? 'left' : 'right';
    var target = a('target', '');
    var sso = a('sso', '');
    var key = 'toolshed-feedback-seen:' + slug;
    var latest = 0;
    var host, root, panel, frame, btn, dot, opener;

    function store(get, v) {
      try { return get ? localStorage.getItem(key) : localStorage.setItem(key, v); } catch (e) { return null; }
    }

    var css =
      ':host{all:initial}*{box-sizing:border-box}' +
      '.b{position:fixed;bottom:20px;' + pos + ':20px;z-index:2147483000;font:600 14px/1 system-ui,-apple-system,Segoe UI,sans-serif;padding:12px 16px;border:0;border-radius:999px;background:#1a1a1a;color:#fff;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25)}' +
      '.b:focus-visible,.x:focus-visible{outline:3px solid #6aa3ff;outline-offset:2px}' +
      '.d{position:absolute;top:-3px;right:-3px;width:12px;height:12px;border-radius:50%;background:#e5484d;border:2px solid #fff}.d[hidden]{display:none}' +
      '.p{position:fixed;bottom:76px;' + pos + ':20px;z-index:2147483000;width:min(400px,calc(100vw - 24px));height:min(600px,calc(100vh - 96px));background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden;display:none}' +
      '.p.o{display:block}.x{position:absolute;top:6px;right:6px;width:30px;height:30px;border:0;border-radius:8px;background:rgba(0,0,0,.06);color:#222;font:600 16px/1 system-ui,sans-serif;cursor:pointer;z-index:1}' +
      'iframe{width:100%;height:100%;border:0;display:block;background:#fff}' +
      '@media (max-width:480px){.p{inset:0;width:auto;height:auto;border-radius:0;bottom:0;' + pos + ':0}}' +
      '@media (prefers-reduced-motion:no-preference){.p.o{animation:i .15s ease-out}@keyframes i{from{opacity:0;transform:translateY(8px)}}}';

    function src() {
      var u = origin + (changelog ? '/changelog/' + slug : '/feedback/' + slug + '/embed');
      var q = [];
      if (changelog) q.push('embed=1');
      if (sso) q.push('sso=' + encodeURIComponent(sso));
      return u + (q.length ? '?' + q.join('&') : '');
    }

    function open() {
      if (!root) return;
      opener = document.activeElement;
      if (!frame) {
        frame = document.createElement('iframe');
        frame.title = label;
        frame.src = src();
        frame.setAttribute('loading', 'lazy');
        panel.appendChild(frame);
      }
      panel.classList.add('o');
      btn.setAttribute('aria-expanded', 'true');
      if (changelog && latest) { store(false, String(latest)); dot.hidden = true; }
      try { frame.focus(); } catch (e) { /* ignore */ }
    }

    function close() {
      if (!panel || !panel.classList.contains('o')) return;
      panel.classList.remove('o');
      btn.setAttribute('aria-expanded', 'false');
      try { (opener && opener.focus ? opener : btn).focus(); } catch (e) { /* ignore */ }
    }

    function toggle(e) { if (e && e.preventDefault) e.preventDefault(); panel.classList.contains('o') ? close() : open(); }

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-toolshed-feedback', '');
      root = host.attachShadow({ mode: 'closed' });
      try {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [sheet];
      } catch (e) {
        var st = document.createElement('style');
        st.textContent = css;
        root.appendChild(st);
      }
      panel = document.createElement('div');
      panel.className = 'p';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', label);
      var x = document.createElement('button');
      x.className = 'x';
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.textContent = '×';
      x.addEventListener('click', close);
      panel.appendChild(x);
      root.appendChild(panel);
      if (!target) {
        btn = document.createElement('button');
        btn.className = 'b';
        btn.type = 'button';
        btn.textContent = label;
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
        dot = document.createElement('span');
        dot.className = 'd';
        dot.hidden = true;
        btn.appendChild(dot);
        btn.addEventListener('click', toggle);
        root.appendChild(btn);
      } else {
        btn = document.createElement('button');
        btn.style.display = 'none';
        dot = document.createElement('span');
      }
      document.body.appendChild(host);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      window.addEventListener('message', function (e) {
        if (frame && e.source === frame.contentWindow && e.data && e.data.toolshedFeedback === 'close') close();
      });
    }

    function hookTarget() {
      if (!target) return;
      var els = document.querySelectorAll(target);
      for (var i = 0; i < els.length; i++) els[i].addEventListener('click', function (e) { toggle(e); });
    }

    function checkNew() {
      if (!changelog) return;
      fetch(origin + '/feedback/' + slug + '/latest.json', { mode: 'cors' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          latest = Number(j && j.latest) || 0;
          var seen = Number(store(true)) || 0;
          if (latest && latest > seen && dot) dot.hidden = false;
        })
        .catch(function () { /* the host page does not care */ });
    }

    function ping() {
      try {
        if (sessionStorage.getItem(key + ':ping')) return;
        sessionStorage.setItem(key + ':ping', '1');
      } catch (e) { /* ignore */ }
      fetch(origin + '/feedback/' + slug + '/ping', { method: 'POST', mode: 'cors' }).catch(function () {});
    }

    function init() {
      try {
        build();
        hookTarget();
        checkNew();
        ping();
      } catch (e) { /* never break the host page */ }
    }

    window.ToolshedFeedback = {
      open: function () { try { open(); } catch (e) { /* ignore */ } },
      close: function () { try { close(); } catch (e) { /* ignore */ } },
      identify: function (token) { sso = String(token || ''); if (frame) { frame.src = src(); } },
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch (e) { /* never break the host page */ }
})();
