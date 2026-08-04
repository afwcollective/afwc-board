/* AFWC Board — the one-off meeting form.
 *
 * Two jobs, the same two the draft upload form has:
 *
 *  1. Swap the form between "R. House" and "Off-site event" so only the
 *     relevant half is filled in and submitted — the floor-map picker for one,
 *     the address / details / attachments for the other.
 *
 *  2. Submit as an XHR carrying X-CSRF-Token. This is not decoration:
 *     src/auth/middleware.js checkCsrf runs before any body parser sees a
 *     multipart request, so it can only read the token from that header. A
 *     plain multipart form post would be rejected as a stale token. The server
 *     answers JSON for this path and a redirect for the ordinary one.
 *
 * No dependencies, no build step. Loaded via pageJs from admin/meeting-form.ejs
 * alongside map-picker.js, which owns the map itself.
 */
(function () {
  'use strict';

  var form = document.getElementById('meeting-form');
  if (!form) return;

  var kindInputs = Array.prototype.slice.call(form.querySelectorAll('input[name="kind"]'));
  var panels = Array.prototype.slice.call(form.querySelectorAll('[data-kind-panel]'));
  var titleOptional = form.querySelector('[data-title-optional]');
  var titleInput = form.querySelector('#title');
  var addressInput = form.querySelector('#address');
  var submit = form.querySelector('[data-submit]');
  var progress = form.querySelector('[data-progress]');
  var progressBar = form.querySelector('[data-progress-bar]');
  var progressLabel = form.querySelector('[data-progress-label]');

  function currentKind() {
    var checked = kindInputs.filter(function (i) {
      return i.checked;
    })[0];
    return checked ? checked.value : 'rhouse';
  }

  function syncKind() {
    var kind = currentKind();
    var offsite = kind === 'offsite';

    panels.forEach(function (panel) {
      var on = panel.getAttribute('data-kind-panel') === kind;
      panel.hidden = !on;
      // A disabled input is not submitted, which keeps the server's file map
      // clean and stops a hidden half of the form from arriving by accident.
      Array.prototype.forEach.call(panel.querySelectorAll('input[type="file"]'), function (input) {
        input.disabled = !on;
      });
    });

    // An off-site event is nothing but its title on the public page, so the
    // title stops being optional the moment the kind flips.
    if (titleOptional) titleOptional.hidden = offsite;
    if (titleInput) titleInput.required = offsite;
    if (addressInput) addressInput.required = offsite;
  }

  kindInputs.forEach(function (input) {
    input.addEventListener('change', syncKind);
  });
  syncKind();

  function showErrors(messages) {
    var existing = document.querySelector('.form-errors[data-form-errors]');
    if (existing) existing.remove();
    var box = document.createElement('div');
    box.className = 'form-errors';
    box.setAttribute('data-form-errors', '');
    box.setAttribute('role', 'alert');
    var head = document.createElement('p');
    head.className = 'form-errors-head';
    head.textContent = 'That did not save';
    var list = document.createElement('ul');
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = String(m);
      list.appendChild(li);
    });
    box.appendChild(head);
    box.appendChild(list);
    form.parentNode.insertBefore(box, form);
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  form.addEventListener('submit', function (e) {
    if (!window.FormData || !window.XMLHttpRequest) return; // let the browser try
    e.preventDefault();

    var payload = new FormData(form);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.getAttribute('action') || '/admin/meetings', true);
    xhr.setRequestHeader('X-CSRF-Token', form.getAttribute('data-csrf') || '');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.setRequestHeader('Accept', 'application/json');

    if (submit) submit.disabled = true;
    if (progress) progress.hidden = false;

    xhr.upload.addEventListener('progress', function (evt) {
      if (!evt.lengthComputable || !progressBar) return;
      var pct = Math.round((evt.loaded / evt.total) * 100);
      progressBar.style.width = pct + '%';
      if (progressLabel) progressLabel.textContent = pct < 100 ? 'Uploading… ' + pct + '%' : 'Saving…';
    });

    xhr.addEventListener('load', function () {
      var json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch (err) {
        /* fall through to the generic message */
      }
      if (xhr.status >= 200 && xhr.status < 300 && json && json.ok) {
        window.location.href = json.redirect || '/admin/meetings';
        return;
      }
      if (submit) submit.disabled = false;
      if (progress) progress.hidden = true;
      if (progressBar) progressBar.style.width = '0%';
      showErrors((json && json.errors) || ['The server refused that. Please reload and try again.']);
    });

    xhr.addEventListener('error', function () {
      if (submit) submit.disabled = false;
      if (progress) progress.hidden = true;
      showErrors(['The connection dropped. Please try again.']);
    });

    xhr.send(payload);
  });
})();
