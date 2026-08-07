'use strict';
/*
 * AFWC chat — the smallest amount of JavaScript that makes a message list feel
 * live. Four jobs, in order of how much they matter:
 *
 *   1. reveal the attachment field. Attachments ride on a multipart request,
 *      and src/auth/middleware.js checkCsrf can only read a token out of a
 *      urlencoded body or the X-CSRF-Token header — so a multipart form post
 *      is only possible from here. Without JS the compose form stays an
 *      ordinary urlencoded form that posts text and redirects. That is why the
 *      field starts hidden in the markup rather than being disabled here.
 *   2. send with fetch + X-CSRF-Token, then redraw the list in place.
 *   3. Enter sends, Shift+Enter starts a new line.
 *   4. a 20-second poll: ask for two integers, and only redraw when they moved.
 *      No websockets, no server state, nothing that needs a second process.
 *
 * Everything is same-origin fetch of same-origin URLs, so it is clean under
 * script-src 'self' with no inline script anywhere.
 */
(function () {
  var stream = document.querySelector('[data-chat-stream]');
  if (!stream) return;

  var form = document.querySelector('[data-chat-form]');
  var errorBox = document.querySelector('[data-chat-errors]');
  var attach = document.querySelector('[data-chat-attach]');
  var textarea = form ? form.querySelector('textarea[name="body"]') : null;
  var fileInput = form ? form.querySelector('input[type="file"]') : null;
  var sendBtn = form ? form.querySelector('[data-chat-send]') : null;

  var canFetch = !!(window.fetch && window.FormData);
  var POLL_MS = 20000;
  var STICK_PX = 80;
  var sending = false;
  var lastSignature = null;

  if (attach && canFetch) attach.hidden = false;

  /* ---------------------------------------------------------- scrolling */

  function nearBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < STICK_PX;
  }
  function toBottom() {
    stream.scrollTop = stream.scrollHeight;
  }
  toBottom();

  /* ------------------------------------------------------------- errors */

  function clearErrors() {
    if (!errorBox) return;
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
  function showErrors(messages) {
    if (!errorBox) return;
    errorBox.textContent = '';
    var list = document.createElement('ul');
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = String(m);
      list.appendChild(li);
    });
    errorBox.appendChild(list);
    errorBox.hidden = false;
  }

  /* ------------------------------------------------- redraw the transcript */

  function currentShow() {
    return Number(stream.getAttribute('data-show')) || 50;
  }

  function refresh(show, stick) {
    if (!canFetch) return;
    var want = show || currentShow();
    var wasNearBottom = stick || nearBottom();
    var keep = stream.scrollTop;
    fetch(stream.getAttribute('data-fragment-url') + '?show=' + want, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('fragment ' + r.status);
        return r.text();
      })
      .then(function (html) {
        stream.innerHTML = html;
        stream.setAttribute('data-show', String(want));
        if (wasNearBottom) toBottom();
        else stream.scrollTop = keep;
      })
      .catch(function () {
        /* a dropped poll is not worth telling anyone about; the next one tries again */
      });
  }

  /* --------------------------------------------------------------- send */

  function send() {
    if (!form || sending) return;
    var text = textarea ? textarea.value.trim() : '';
    var hasFiles = !!(fileInput && fileInput.files && fileInput.files.length);
    if (!text && !hasFiles) return;

    sending = true;
    if (sendBtn) sendBtn.disabled = true;

    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      body: new FormData(form),
      headers: {
        'X-CSRF-Token': form.getAttribute('data-csrf') || '',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (json) {
            return { ok: r.ok, json: json };
          });
      })
      .then(function (res) {
        sending = false;
        if (sendBtn) sendBtn.disabled = false;
        if (res.ok && res.json && res.json.ok) {
          if (textarea) textarea.value = '';
          if (fileInput) fileInput.value = '';
          clearErrors();
          refresh(null, true);
          if (textarea) textarea.focus();
          return;
        }
        showErrors((res.json && res.json.errors) || ['That message did not go through.']);
      })
      .catch(function () {
        sending = false;
        if (sendBtn) sendBtn.disabled = false;
        showErrors(['The connection dropped. Try that again.']);
      });
  }

  if (form && canFetch) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      send();
    });
  }

  if (textarea) {
    textarea.addEventListener('keydown', function (e) {
      var key = e.key || e.keyCode;
      var isEnter = key === 'Enter' || key === 13;
      if (!isEnter || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      e.preventDefault();
      if (canFetch) send();
      else if (form && form.requestSubmit) form.requestSubmit();
      else if (form) form.submit();
    });
  }

  /* ------------------------------------------------------ "show earlier" */

  stream.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('[data-chat-earlier]') : null;
    if (!link || !canFetch) return;
    e.preventDefault();
    var match = /[?&]show=(\d+)/.exec(link.getAttribute('href') || '');
    refresh(match ? Number(match[1]) : currentShow() + 50, false);
  });

  /* --------------------------------------------------------------- poll */

  function poll() {
    if (!canFetch) return;
    fetch(stream.getAttribute('data-head-url'), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('head ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) return;
        var signature = data.latest_id + ':' + data.count + ':' + (data.last_delete || '');
        if (lastSignature === null) {
          lastSignature = signature; // first look: this is what is already drawn
          return;
        }
        if (signature === lastSignature) return;
        lastSignature = signature;
        refresh(null, false);
      })
      .catch(function () {
        /* offline, asleep, whatever — try again next tick */
      });
  }

  poll();
  window.setInterval(poll, POLL_MS);
})();
