/* Toolshed Analytics. No cookies, no stored visitor id. Docs: docs/modules/analytics.md */
(function (w, d) {
  var s = d.currentScript;
  if (!s) return;
  var loc = w.location;
  var nav = w.navigator;
  var key = s.getAttribute('data-site');
  var api = s.getAttribute('data-api') || new URL(s.src, loc.href).origin + '/a/e';
  var hashMode = s.hasAttribute('data-hash');
  var manual = s.hasAttribute('data-manual');
  var pings = !s.hasAttribute('data-no-pings');
  var FLAG = 'toolshed_ignore';
  var ref = d.referrer;
  var last, here, seen, since, sent;

  function ignored() {
    try {
      return w.localStorage.getItem(FLAG) == '1';
    } catch (e) {
      return false;
    }
  }

  // The site owner opens their own site with #toolshed-ignore once to stop counting themselves.
  var m = /^#toolshed-(un)?ignore$/.exec(loc.hash);
  if (m) {
    try {
      if (m[1]) w.localStorage.removeItem(FLAG);
      else w.localStorage.setItem(FLAG, '1');
      w.alert(m[1] ? 'Your visits to this site are counted again.' : 'Your visits to this site are no longer counted in this browser.');
    } catch (e) {}
  }

  function skip() {
    return !key || nav.webdriver || ignored() || loc.protocol == 'file:' || /^(localhost|127\.|\[::1\]|0\.0\.0\.0)|\.localhost$/.test(loc.hostname);
  }

  function send(t, name, props, ms, url) {
    if (skip()) return;
    var body = JSON.stringify({ k: key, t: t, n: name, u: url || loc.href, r: t == 'p' ? ref : undefined, p: props, e: ms, h: hashMode ? 1 : undefined });
    try {
      if (nav.sendBeacon && nav.sendBeacon(api, body)) return;
      w.fetch(api, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }).catch(function () {});
    } catch (e) {}
  }

  function tick() {
    if (since) seen += Date.now() - since;
    since = d.visibilityState == 'visible' ? Date.now() : 0;
  }

  // Time on page: one small ping when the tab is hidden or closed after 10 seconds or more in view.
  function ping() {
    tick();
    if (pings && last != null && seen >= 1e4 && sent < 8) {
      sent++;
      // A ping belongs to the page it measured, which a single-page app may already have left.
      send('g', undefined, undefined, Math.round(seen), here);
      seen = 0;
    }
  }

  function page(force) {
    var now = loc.pathname + (hashMode ? loc.hash : '');
    if (!force && now === last) return;
    ping();
    last = now;
    seen = 0;
    sent = 0;
    since = d.visibilityState == 'visible' ? Date.now() : 0;
    send('p');
    ref = here = loc.href;
  }

  function toolshed(name, props) {
    if (name == 'pageview') page(1);
    else if (name) send('e', String(name), props);
  }

  function click(e) {
    if (e.type == 'auxclick' && e.button != 1) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || !/^https?:$/.test(a.protocol)) return;
    if (/\.(pdf|zip|rar|7z|gz|tar|dmg|exe|msi|pkg|apk|csv|xlsx?|docx?|pptx?|mp3|mp4|mov|avi|wav|epub|txt)$/i.test(a.pathname)) send('e', 'File download', { url: a.href });
    else if (a.host != loc.host) send('e', 'Outbound link', { url: a.href });
  }

  function start() {
    var q = (w.toolshed && w.toolshed.q) || [];
    w.toolshed = toolshed;
    if (!manual) {
      page();
      var push = w.history.pushState;
      if (push) {
        w.history.pushState = function () {
          push.apply(this, arguments);
          page();
        };
        w.addEventListener('popstate', function () {
          page();
        });
      }
      if (hashMode) w.addEventListener('hashchange', function () {
        page();
      });
      w.addEventListener('pageshow', function (e) {
        if (e.persisted) page(1);
      });
      try {
        if (w.performance.getEntriesByType('navigation')[0].responseStatus == 404) send('e', '404');
      } catch (e) {}
    }
    d.addEventListener('visibilitychange', function () {
      if (d.visibilityState == 'hidden') ping();
      else tick();
    });
    w.addEventListener('pagehide', ping);
    d.addEventListener('click', click, true);
    d.addEventListener('auxclick', click, true);
    for (var i = 0; i < q.length; i++) toolshed.apply(null, q[i]);
  }

  if (d.prerendering) d.addEventListener('prerenderingchange', start, { once: true });
  else start();
})(window, document);
