/* Small helpers for the Analytics screens. Every screen works without this file:
   it saves a click on the range picker and keeps two numbers fresh while the tab is open. */
(function () {
  'use strict';

  // The range picker submits itself, so its "Show" button can go.
  document.querySelectorAll('form[data-an-auto]').forEach(function (form) {
    form.classList.add('an-auto');
    form.addEventListener('change', function (e) {
      if (e.target && e.target.matches('select, input[type=checkbox]')) form.submit();
    });
  });

  // Ask politely: only while the tab is showing, never two requests at once, and not for ever.
  function poll(url, everyMs, tries, done) {
    var busy = false;
    var timer = setInterval(function () {
      if (busy || document.hidden) return;
      if (tries-- <= 0) return clearInterval(timer);
      busy = true;
      fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { if (data && done(data) === false) clearInterval(timer); })
        .catch(function () {})
        .then(function () { busy = false; });
    }, everyMs);
  }

  var live = document.querySelector('[data-an-live]');
  if (live) {
    var n = live.querySelector('[data-an-live-n]');
    poll(live.getAttribute('data-an-live'), 60000, 240, function (data) {
      if (n && typeof data.visitors === 'number') n.textContent = data.visitors.toLocaleString();
    });
  }

  var wait = document.querySelector('[data-an-wait]');
  if (wait) {
    poll(wait.getAttribute('data-an-wait'), 5000, 120, function (data) {
      if (!data.first_hit_at) return true;
      location.reload();
      return false;
    });
  }
})();
