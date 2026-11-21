/* Toolshed UI behaviour. Plain JavaScript, no build step, no inline handlers.
   Everything attaches through data-* attributes, and every page still works without it
   (forms post, links navigate); this file only adds the pop-ups, copying and small conveniences. */
(function () {
  'use strict';

  var root = document.documentElement;
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ---------- toast ---------- */
  var region = null;
  function toastRegion() {
    if (!region) {
      region = $('.toast-region');
      if (!region) {
        region = document.createElement('div');
        region.className = 'toast-region';
        region.setAttribute('aria-live', 'polite');
        document.body.appendChild(region);
      }
    }
    return region;
  }
  function dismiss(el, ms) {
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 250);
    }, ms);
  }
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast show' + (kind === 'error' ? ' error' : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    toastRegion().appendChild(el);
    dismiss(el, kind === 'error' ? 7000 : 3500);
  }
  $$('[data-toast-auto]').forEach(function (el) { dismiss(el, el.classList.contains('error') ? 8000 : 5000); });

  /* ---------- theme ---------- */
  function syncThemeButtons() {
    var dark = root.getAttribute('data-theme') === 'dark';
    $$('[data-theme-btn]').forEach(function (b) { b.setAttribute('aria-pressed', dark ? 'true' : 'false'); });
  }
  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    store.set('ts-theme', theme);
    syncThemeButtons();
    document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }
  syncThemeButtons();

  /* ---------- dialogs, menus, panels ---------- */
  var menuTrigger = null;
  function closeMenus() {
    $$('.menu.open').forEach(function (m) { m.classList.remove('open'); });
    if (menuTrigger) menuTrigger.setAttribute('aria-expanded', 'false');
  }
  function openMenu(id, trigger) {
    var menu = document.getElementById('menu-' + id);
    if (!menu) return;
    var wasOpen = menu.classList.contains('open');
    closeMenus();
    if (wasOpen) return;
    menuTrigger = trigger;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    menu.classList.add('open');
    var r = trigger.getBoundingClientRect();
    var left = r.right - menu.offsetWidth;
    var top = r.bottom + 6;
    if (left < 8) left = Math.min(r.left, innerWidth - menu.offsetWidth - 8);
    if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 6);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = top + 'px';
    var first = $('a, button', menu);
    if (first && trigger.dataset.menuKey) first.focus();
  }

  var inspTrigger = null;
  function closeInspector() {
    $$('.inspector.open').forEach(function (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); });
    var scrim = $('.insp-scrim');
    if (scrim) scrim.classList.remove('open');
    if (inspTrigger && inspTrigger.focus) inspTrigger.focus({ preventScroll: true });
    inspTrigger = null;
  }
  function openInspector(id, trigger) {
    var el = document.getElementById(id);
    if (!el) return;
    closeInspector();
    inspTrigger = trigger || null;
    var scrim = $('.insp-scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'insp-scrim';
      scrim.addEventListener('click', closeInspector);
      document.body.appendChild(scrim);
    }
    el.classList.add('open');
    scrim.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    var focus = $('input:not([type=hidden]), select, textarea, button', $('.insp-body', el) || el);
    if (focus) setTimeout(function () { focus.focus({ preventScroll: true }); }, 60);
  }

  function selectTab(tab) {
    var list = tab.closest('[role="tablist"]');
    $$('[role="tab"]', list).forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    list.dispatchEvent(new CustomEvent('tabchange', { bubbles: true, detail: tab.id }));
  }

  /* ---------- command menu (Ctrl or Cmd + K) ---------- */
  function openCommand() {
    var dlg = document.getElementById('command');
    if (!dlg || !dlg.showModal) return;
    var list = $('[data-command-list]', dlg);
    if (!list.children.length) {
      $$('.side nav a[href]').forEach(function (a) {
        var li = document.createElement('li');
        var link = document.createElement('a');
        link.href = a.getAttribute('href');
        var label = a.querySelector('.hide-c');
        link.textContent = label ? label.textContent : a.textContent;
        li.appendChild(link);
        list.appendChild(li);
      });
    }
    var input = $('input', dlg);
    input.value = '';
    filterCommand('');
    if (!dlg.open) dlg.showModal();
    input.focus();
  }
  function filterCommand(q) {
    var query = q.trim().toLowerCase();
    var shown = 0;
    $$('[data-command-list] li').forEach(function (li) {
      var hit = !query || li.textContent.toLowerCase().indexOf(query) !== -1;
      li.hidden = !hit;
      if (hit) shown++;
    });
    var empty = $('[data-command-empty]');
    if (empty) empty.hidden = shown !== 0;
  }

  /* ---------- clicks ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;

    if (t.closest('[data-theme-btn]')) {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      return;
    }
    var collapse = t.closest('[data-collapse]');
    if (collapse) {
      var on = !root.classList.contains('nav-collapsed');
      root.classList.toggle('nav-collapsed', on);
      store.set('ts-collapsed', on ? '1' : '0');
      collapse.setAttribute('aria-expanded', on ? 'false' : 'true');
      return;
    }
    var app = $('.app');
    if (t.closest('[data-drawer]') && app) { app.classList.add('drawer'); return; }
    if (app && (t.closest('.scrim') || (app.classList.contains('drawer') && t.closest('.side a')))) app.classList.remove('drawer');

    if (t.closest('[data-command]')) { e.preventDefault(); openCommand(); return; }

    var menuTrigger2 = t.closest('[data-menu]');
    if (menuTrigger2) { e.preventDefault(); e.stopPropagation(); openMenu(menuTrigger2.getAttribute('data-menu'), menuTrigger2); return; }
    if (!t.closest('.menu')) closeMenus();
    else if (t.closest('.menu a, .menu button')) setTimeout(closeMenus, 0);

    var opener = t.closest('[data-open]');
    if (opener) {
      e.preventDefault();
      var dlg = document.getElementById(opener.getAttribute('data-open'));
      if (dlg && dlg.showModal) {
        dlg.showModal();
        var f = $('[autofocus], input:not([type=hidden]):not([readonly]), select, textarea', dlg);
        if (f) setTimeout(function () { f.focus(); }, 30);
      }
      return;
    }
    var closer = t.closest('[data-close]');
    if (closer) {
      var parent = closer.closest('dialog');
      if (parent) parent.close();
      if (closer.closest('.inspector')) closeInspector();
      return;
    }
    if (t instanceof HTMLDialogElement) { t.close(); return; }

    var tab = t.closest('[role="tab"]');
    if (tab && tab.closest('[role="tablist"]')) { selectTab(tab); return; }

    var insp = t.closest('[data-inspect]');
    if (insp) {
      var inner = t.closest('button, a, select, input, label');
      if (!inner || inner === insp || !insp.contains(inner)) { openInspector(insp.getAttribute('data-inspect'), insp); return; }
    }

    var copyBtn = t.closest('[data-copy]');
    if (copyBtn) {
      var value = copyBtn.getAttribute('data-copy') || '';
      var done = function () { toast(copyBtn.getAttribute('data-copied') || 'Copied.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, function () { toast('Could not copy. Select the text and copy it by hand.', 'error'); });
      else toast('Could not copy. Select the text and copy it by hand.', 'error');
      return;
    }

    var note = t.closest('[data-toast]');
    if (note) { if (note.tagName === 'A') e.preventDefault(); toast(note.getAttribute('data-toast')); return; }

    var eye = t.closest('[data-toggle-password]');
    if (eye) {
      var input = $('input', eye.parentElement);
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', show ? 'true' : 'false');
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      eye.setAttribute('title', show ? 'Hide password' : 'Show password');
    }
  });

  /* ---------- keys ---------- */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && $('#command')) { e.preventDefault(); openCommand(); return; }
    if (e.key === 'Escape') {
      var cmd = $('#command[open]');
      if (cmd) { e.preventDefault(); cmd.close(); }
      closeMenus();
      closeInspector();
      var app = $('.app');
      if (app) app.classList.remove('drawer');
    }
    var tab = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
    if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
      var tabs = $$('[role="tab"]', tab.closest('[role="tablist"]'));
      var i = tabs.indexOf(tab);
      var next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    }
    var trigger = e.target instanceof Element ? e.target.closest('[data-menu]') : null;
    if (trigger && e.key === 'ArrowDown') { trigger.dataset.menuKey = '1'; openMenu(trigger.getAttribute('data-menu'), trigger); delete trigger.dataset.menuKey; e.preventDefault(); }
    var inMenu = e.target instanceof Element ? e.target.closest('.menu') : null;
    if (inMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      var items = $$('a, button', inMenu);
      var at = items.indexOf(document.activeElement);
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      e.preventDefault();
    }
    if (e.key === 'Enter' && e.target instanceof Element && e.target.matches('#command input')) {
      var firstHit = $('[data-command-list] li:not([hidden]) a');
      if (firstHit) { e.preventDefault(); location.href = firstHit.href; }
    }
  });
  addEventListener('resize', closeMenus);
  addEventListener('scroll', closeMenus, true);

  /* ---------- inputs ---------- */
  document.addEventListener('input', function (e) {
    var i = e.target;
    if (i instanceof HTMLInputElement && i.closest('#command')) { filterCommand(i.value); return; }
    var otp = i instanceof Element ? i.closest('[data-otp]') : null;
    if (!otp || !(i instanceof HTMLInputElement) || i.type === 'hidden') return;
    i.value = i.value.replace(/\D/g, '').slice(-1);
    var boxes = $$('input:not([type=hidden])', otp);
    if (i.value && boxes[boxes.indexOf(i) + 1]) boxes[boxes.indexOf(i) + 1].focus();
    syncOtp(otp);
  });
  document.addEventListener('keydown', function (e) {
    var i = e.target;
    var otp = i instanceof Element ? i.closest('[data-otp]') : null;
    if (!otp || e.key !== 'Backspace' || i.value) return;
    var boxes = $$('input:not([type=hidden])', otp);
    var prev = boxes[boxes.indexOf(i) - 1];
    if (prev) prev.focus();
  });
  document.addEventListener('paste', function (e) {
    var i = e.target;
    var otp = i instanceof Element ? i.closest('[data-otp]') : null;
    if (!otp) return;
    var digits = ((e.clipboardData && e.clipboardData.getData('text')) || '').replace(/\D/g, '');
    if (!digits) return;
    e.preventDefault();
    var boxes = $$('input:not([type=hidden])', otp);
    boxes.forEach(function (box, k) { box.value = digits[k] || ''; });
    boxes[Math.min(digits.length, boxes.length) - 1].focus();
    syncOtp(otp);
  });
  function syncOtp(otp) {
    var code = $$('input:not([type=hidden])', otp).map(function (b) { return b.value; }).join('');
    $('[data-otp-value]', otp).value = code;
    var form = otp.closest('form');
    if (form && code.length === $$('input:not([type=hidden])', otp).length && form.hasAttribute('data-otp-submit') && form.requestSubmit) form.requestSubmit();
  }
  $$('[data-otp]').forEach(function (otp) {
    var plain = otp.parentElement.querySelector('.otp-plain');
    if (plain) plain.disabled = true;
    $('[data-otp-value]', otp).disabled = false;
  });

  /* ---------- forms: busy state, so a double click cannot send twice ---------- */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || form.method === 'get' || form.hasAttribute('data-no-busy')) return;
    var btn = e.submitter || $('button[type=submit]', form);
    if (!(btn instanceof HTMLButtonElement)) return;
    setTimeout(function () {
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
    }, 0);
  });
  addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    $$('button[aria-busy="true"]').forEach(function (b) { b.removeAttribute('aria-busy'); b.disabled = false; });
  });

  /* ---------- boot ---------- */
  $$('[role="tablist"]').forEach(function (list) {
    var sel = $('[role="tab"][aria-selected="true"]', list) || $('[role="tab"]', list);
    if (sel) selectTab(sel);
  });
  var q = new URLSearchParams(location.search);
  if (q.get('tab')) { var wanted = document.getElementById('tab-' + q.get('tab')); if (wanted) selectTab(wanted); }

  window.Toolshed = { toast: toast, openInspector: openInspector, closeInspector: closeInspector, selectTab: selectTab };
})();
