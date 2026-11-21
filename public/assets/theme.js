/* Runs before the page is drawn so the right colours show from the first frame (no flash).
   Loaded as a blocking script from <head>; it is a file, not inline code, so a strict CSP works. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  try {
    if (localStorage.getItem('ts-collapsed') === '1') root.classList.add('nav-collapsed');
  } catch (e) {}
  if (root.hasAttribute('data-theme-lock')) return;
  var theme = null;
  try {
    theme = localStorage.getItem('ts-theme');
  } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') {
    var mode = root.getAttribute('data-mode');
    theme = mode === 'light' || mode === 'dark' ? mode : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', theme);
})();
