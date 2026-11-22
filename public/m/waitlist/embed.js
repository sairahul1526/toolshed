/* Waitlist embed: put <div data-toolshed-waitlist="slug"></div> on your page, then load this script. */
(function () {
  var origin = new URL(document.currentScript ? document.currentScript.src : '', location.href).origin;
  var nodes = document.querySelectorAll('[data-toolshed-waitlist]');
  for (var i = 0; i < nodes.length; i++) {
    var slug = nodes[i].getAttribute('data-toolshed-waitlist');
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || nodes[i].firstChild) continue;
    var f = document.createElement('iframe');
    f.src = origin + '/w/' + slug + '/embed';
    f.title = 'Join the waitlist';
    f.loading = 'lazy';
    f.style.border = '0';
    f.style.width = '100%';
    f.style.maxWidth = '480px';
    f.style.height = nodes[i].getAttribute('data-height') || '440px';
    nodes[i].appendChild(f);
  }
})();
