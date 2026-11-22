/* Links dashboard: select all rows, and download a QR code as PNG. No third-party code, no inline handlers. */
(function () {
  'use strict';

  document.addEventListener('change', function (event) {
    var box = event.target;
    if (!(box instanceof HTMLInputElement) || !box.hasAttribute('data-select-all')) return;
    var form = box.closest('form');
    if (!form) return;
    form.querySelectorAll('input[data-select-row]').forEach(function (row) {
      row.checked = box.checked;
    });
  });

  function toast(message) {
    var region = document.querySelector('.toast-region');
    if (!region) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    region.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-qr-png]') : null;
    if (!target) return;
    event.preventDefault();
    var src = target.getAttribute('data-qr-png');
    var name = target.getAttribute('data-qr-name') || 'qr.png';
    var image = new Image();
    image.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || 512;
      canvas.height = image.naturalHeight || 512;
      var context = canvas.getContext('2d');
      if (!context) return toast('Your browser can’t make PNG files. Use the SVG download.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) return toast('We couldn’t make the PNG. Use the SVG download.');
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }, 'image/png');
    };
    image.onerror = function () { toast('We couldn’t load the QR code. Try again.'); };
    image.src = src;
  });
})();
