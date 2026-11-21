/*
 * Passkeys, the one part of sign-in that needs a script. Everything else on these pages is a
 * plain form. No library: browsers that have passkeys can turn the server's JSON into the
 * options WebAuthn wants and turn the result back into JSON by themselves.
 *
 *   <button data-passkey-signin data-next="/app" hidden>      sign in with a passkey
 *   <button data-passkey-add data-name="#passkey-name" hidden> add a passkey to the signed-in account
 *   <p data-passkey-error role="alert" hidden>                 where a problem is written
 *   <div data-passkey-only hidden>                             shown only when passkeys can be used
 */
(function () {
  'use strict';

  var PKC = window.PublicKeyCredential;
  var ready = !!(PKC && navigator.credentials && PKC.parseRequestOptionsFromJSON && PKC.parseCreationOptionsFromJSON);
  if (!ready) return;

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  each('[data-passkey-signin], [data-passkey-add], [data-passkey-only]', function (el) {
    el.hidden = false;
  });

  function errorBox(button) {
    var scope = button.closest('form, section, article') || document;
    return scope.querySelector('[data-passkey-error]') || document.querySelector('[data-passkey-error]');
  }

  function show(button, message) {
    var box = errorBox(button);
    if (!box) return;
    box.textContent = message;
    box.hidden = !message;
  }

  function busy(button, on) {
    button.disabled = on;
    if (on) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  function json(url, body) {
    var init = { credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body) {
      init.method = 'POST';
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.json().then(
        function (data) {
          if (!res.ok) throw new Error((data && data.message) || 'Something went wrong. Try again.');
          return data;
        },
        function () {
          throw new Error('Something went wrong. Try again.');
        }
      );
    });
  }

  function explain(err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return 'That was cancelled or timed out. Try again.';
    if (err && err.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
    if (err && err.name === 'SecurityError') return 'Passkeys do not work on this address.';
    return (err && err.message) || 'That passkey did not work. Try another way.';
  }

  function run(button, work) {
    show(button, '');
    busy(button, true);
    work().catch(function (err) {
      busy(button, false);
      show(button, explain(err));
    });
  }

  each('[data-passkey-signin]', function (button) {
    button.addEventListener('click', function () {
      run(button, function () {
        return json('/api/auth/passkey/sign-in-options')
          .then(function (options) {
            return navigator.credentials.get({ publicKey: PKC.parseRequestOptionsFromJSON(options) });
          })
          .then(function (credential) {
            if (!credential) throw new Error('No passkey was chosen.');
            return json('/api/auth/passkey/sign-in', { response: credential.toJSON(), next: button.getAttribute('data-next') || '' });
          })
          .then(function (done) {
            location.assign(done.redirect || '/app');
          });
      });
    });
  });

  each('[data-passkey-add]', function (button) {
    button.addEventListener('click', function () {
      var field = button.getAttribute('data-name') ? document.querySelector(button.getAttribute('data-name')) : null;
      var name = field && field.value ? String(field.value).trim() : '';
      run(button, function () {
        return json('/api/auth/passkey/register-options' + (name ? '?name=' + encodeURIComponent(name) : ''))
          .then(function (options) {
            return navigator.credentials.create({ publicKey: PKC.parseCreationOptionsFromJSON(options) });
          })
          .then(function (credential) {
            if (!credential) throw new Error('No passkey was made.');
            return json('/api/auth/passkey/register', { response: credential.toJSON(), name: name });
          })
          .then(function () {
            var done = button.getAttribute('data-done');
            if (done) location.assign(done);
            else location.reload();
          });
      });
    });
  });
})();
