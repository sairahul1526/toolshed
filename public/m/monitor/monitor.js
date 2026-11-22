/* Monitor dashboard: reload a screen that is waiting for a first result, and keep the monitor type form in sync. No inline handlers. */
(function () {
  var poll = document.querySelector('[data-poll]');
  if (poll) {
    var every = Math.max(3000, Number(poll.getAttribute('data-poll')) || 5000);
    var left = 24;
    var timer = setInterval(function () {
      if (document.hidden) return;
      left -= 1;
      if (left <= 0) return clearInterval(timer);
      fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (html) {
          if (!html) return;
          var doc = new DOMParser().parseFromString(html, 'text/html');
          if (!doc.querySelector('[data-poll]')) location.reload();
        })
        .catch(function () {});
    }, every);
  }
})();
