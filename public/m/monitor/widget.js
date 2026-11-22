/* Status widget. Add <script src=".../m/monitor/widget.js" data-status-page="https://host/status/slug" defer></script>.
   Shows one small pill that links to the page. Reads status.json from the same place. No cookies, no tracking. */
(function () {
  var s = document.currentScript;
  if (!s) return;
  var page = (s.getAttribute('data-status-page') || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(page)) return;
  var host = document.createElement('span');
  host.setAttribute('data-monitor-widget', '');
  s.parentNode.insertBefore(host, s);
  var root = host.attachShadow({ mode: 'open' });
  var css = document.createElement('style');
  css.textContent =
    ':host{display:inline-block}a{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid #d0d5dd;border-radius:999px;font:500 13px/1.2 system-ui,sans-serif;color:#1d2939;background:#fff;text-decoration:none}' +
    'a:focus-visible{outline:2px solid #2f55d4;outline-offset:2px}i{width:9px;height:9px;border-radius:50%;background:#98a2b3}' +
    '.none i{background:#1a7f4b}.minor i{background:#a35f00}.major i,.critical i{background:#b42318}.maintenance i{background:#3b5bdb}' +
    '@media (prefers-color-scheme:dark){a{background:#171717;color:#f2f4f7;border-color:#3a3a3a}}';
  var a = document.createElement('a');
  a.href = page;
  a.rel = 'noopener';
  a.className = 'loading';
  var dot = document.createElement('i');
  var label = document.createElement('span');
  label.textContent = 'Status';
  a.appendChild(dot);
  a.appendChild(label);
  root.appendChild(css);
  root.appendChild(a);
  fetch(page + '/status.json', { mode: 'cors', credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (d) {
      var o = (d && d.status) || {};
      var code = o.indicator || '';
      a.className = String(code);
      label.textContent = String(o.description || 'Status');
    })
    .catch(function () { label.textContent = 'Status page'; });
})();
