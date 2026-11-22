/* Toolshed Forms embed. Include once on any page.
   Inline:  <div data-toolshed-form="https://example.com/f/contact"></div>
   Popup:   <button data-toolshed-form-popup="https://example.com/f/contact">Contact us</button>
   Script:  ToolshedForms.open(url) / ToolshedForms.close()
   Styles are set through the element API so a strict page CSP does not block them. */
(function () {
  'use strict';
  var frames = [];
  var layer = null, lastFocus = null;

  function embedUrl(u) {
    var a = document.createElement('a');
    a.href = u;
    var path = a.pathname.replace(/\/embed\/?$/, '').replace(/\/$/, '') + '/embed';
    return a.protocol + '//' + a.host + path + a.search;
  }
  function style(el, rules) { for (var k in rules) el.style[k] = rules[k]; }

  function frame(url, title) {
    var f = document.createElement('iframe');
    f.src = embedUrl(url);
    f.title = title || 'Form';
    f.setAttribute('loading', 'lazy');
    f.setAttribute('allow', 'clipboard-write');
    style(f, { width: '100%', border: '0', display: 'block', minHeight: '320px', colorScheme: 'normal' });
    frames.push(f);
    return f;
  }

  function inline(el) {
    if (el.getAttribute('data-ready')) return;
    el.setAttribute('data-ready', '1');
    el.appendChild(frame(el.getAttribute('data-toolshed-form'), el.getAttribute('data-title')));
  }

  function close() {
    if (!layer) return;
    document.removeEventListener('keydown', onKey, true);
    layer.parentNode.removeChild(layer);
    layer = null;
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab' || !layer) return;
    var btn = layer.querySelector('button');
    var f = layer.querySelector('iframe');
    // Two stops: the close button and the form. Keep focus inside the dialog.
    if (document.activeElement === btn && e.shiftKey) { e.preventDefault(); f.focus(); }
    else if (document.activeElement === f || !layer.contains(document.activeElement)) { e.preventDefault(); btn.focus(); }
  }

  function open(url, title) {
    close();
    lastFocus = document.activeElement;
    layer = document.createElement('div');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', title || 'Form');
    style(layer, { position: 'fixed', inset: '0', zIndex: '2147483000', background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' });
    var box = document.createElement('div');
    style(box, { position: 'relative', width: '100%', maxWidth: '560px', maxHeight: '100%', overflow: 'auto', borderRadius: '14px', background: '#fff' });
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = 'Close';
    x.setAttribute('aria-label', 'Close form');
    style(x, { position: 'absolute', top: '8px', right: '8px', zIndex: '1', font: '600 13px system-ui,sans-serif', padding: '6px 10px', border: '1px solid #ccc', borderRadius: '8px', background: '#fff', color: '#111', cursor: 'pointer' });
    x.addEventListener('click', close);
    var f = frame(url, title);
    style(f, { minHeight: '420px', paddingTop: '0' });
    box.appendChild(x);
    box.appendChild(f);
    layer.appendChild(box);
    layer.addEventListener('mousedown', function (e) { if (e.target === layer) close(); });
    document.body.appendChild(layer);
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    x.focus();
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'toolshed-form-height') {
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow === e.source && typeof d.height === 'number') frames[i].style.height = Math.min(Math.max(d.height, 200), 20000) + 'px';
      }
    }
  });

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-toolshed-form-popup]') : null;
    if (!t) return;
    e.preventDefault();
    open(t.getAttribute('data-toolshed-form-popup'), t.getAttribute('data-title') || t.textContent);
  });

  function scan() { [].forEach.call(document.querySelectorAll('[data-toolshed-form]'), inline); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  window.ToolshedForms = { open: open, close: close, scan: scan };
})();
