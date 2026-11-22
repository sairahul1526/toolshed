/* Mail editor toolbar: inserts Markdown around the selection. No third-party code, no inline handlers. */
(function () {
  'use strict';

  var SNIPPETS = {
    bold: { before: '**', after: '**', sample: 'bold text' },
    italic: { before: '_', after: '_', sample: 'italic text' },
    heading: { before: '## ', after: '', sample: 'Heading', line: true },
    link: { before: '[', after: '](https://example.com)', sample: 'link text' },
    button: { before: '::button[', after: '](https://example.com)', sample: 'Read more' },
    image: { before: '![', after: '](https://example.com/image.png)', sample: 'Describe the image' },
    divider: { before: '\n\n---\n\n', after: '', sample: '' },
    tag: { before: '{{first_name|there}}', after: '', sample: '' },
  };

  document.addEventListener('click', function (event) {
    var button = event.target instanceof Element ? event.target.closest('[data-ml-fmt]') : null;
    if (!button || button.disabled) return;
    var form = button.closest('form');
    var area = form && form.querySelector('textarea[name="body"]');
    var snippet = SNIPPETS[button.getAttribute('data-ml-fmt')];
    if (!area || !snippet) return;
    event.preventDefault();
    var start = area.selectionStart;
    var end = area.selectionEnd;
    var value = area.value;
    var chosen = value.slice(start, end) || snippet.sample;
    var prefix = snippet.line && start > 0 && value.charAt(start - 1) !== '\n' ? '\n' : '';
    var insert = prefix + snippet.before + chosen + snippet.after;
    area.value = value.slice(0, start) + insert + value.slice(end);
    var from = start + prefix.length + snippet.before.length;
    area.focus();
    area.setSelectionRange(from, from + chosen.length);
  });
})();
