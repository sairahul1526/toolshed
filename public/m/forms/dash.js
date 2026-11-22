/* Forms dashboard helpers: select all, and the "waiting for the first response" check. */
(function () {
  'use strict';
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-select-all')) return;
    var form = t.closest('form');
    if (!form) return;
    [].forEach.call(form.querySelectorAll('input[name="ids"]'), function (b) { b.checked = t.checked; });
  });

  var wait = document.querySelector('[data-wait]');
  if (wait && wait.getAttribute('data-state') !== 'got') {
    var text = wait.querySelector('[data-wait-text]');
    var tries = 0;
    var timer = setInterval(function () {
      if (document.hidden) return;
      if (++tries > 150) { clearInterval(timer); return; }
      fetch(wait.getAttribute('data-url'), { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (j && j.total > 0) {
            clearInterval(timer);
            wait.setAttribute('data-state', 'got');
            text.textContent = 'Received. Your first response is in.';
            if (window.Toolshed && window.Toolshed.toast) window.Toolshed.toast('First response received.', 'ok');
          }
        })
        .catch(function () {});
    }, 4000);
  }
})();
