/* AFWC draft upload.
 *
 * Two jobs:
 *  1. toggle the form between "a document" and "a page sequence" so only the
 *     relevant file input is submitted;
 *  2. send the form as an XHR carrying X-CSRF-Token, with a progress bar.
 *
 * (2) is not decoration: src/auth/middleware.js checkCsrf runs before any body
 * parser sees a multipart request, so it can only read the token from that
 * header. A plain multipart form post would be rejected as a stale token.
 *
 * TWO FORMS, ONE SCRIPT. #upload-form (views/drafts/new.ejs) creates a draft;
 * #swap-form (views/drafts/edit.ejs) replaces the file under one that already
 * exists. They are the same form — same field names, same mode switch, same
 * multipart-plus-CSRF-header arrangement, same JSON reply carrying a redirect —
 * so this drives whichever one is on the page and takes the endpoint off the
 * form's own action rather than knowing either URL. A page never has both.
 */
(function () {
  'use strict';

  var form = document.getElementById('upload-form') || document.getElementById('swap-form');
  if (!form) return;

  var modeInputs = Array.prototype.slice.call(form.querySelectorAll('input[name="mode"]'));
  var panels = Array.prototype.slice.call(form.querySelectorAll('[data-mode-panel]'));
  var fileList = form.querySelector('[data-file-list]');
  var imagesInput = form.querySelector('#images');
  var docInput = form.querySelector('#document');
  var submit = form.querySelector('[data-submit]');
  var progress = form.querySelector('[data-progress]');
  var progressBar = form.querySelector('[data-progress-bar]');
  var progressLabel = form.querySelector('[data-progress-label]');

  function currentMode() {
    var checked = modeInputs.filter(function (i) {
      return i.checked;
    })[0];
    return checked ? checked.value : 'document';
  }

  function syncMode() {
    var mode = currentMode();
    panels.forEach(function (panel) {
      var on = panel.getAttribute('data-mode-panel') === mode;
      panel.hidden = !on;
      // A disabled input is not submitted, which keeps the server's file map clean.
      Array.prototype.forEach.call(panel.querySelectorAll('input[type="file"]'), function (input) {
        input.disabled = !on;
      });
    });
  }

  modeInputs.forEach(function (input) {
    input.addEventListener('change', syncMode);
  });
  syncMode();

  function human(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  if (imagesInput && fileList) {
    imagesInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(imagesInput.files || []);
      if (!files.length) {
        fileList.hidden = true;
        fileList.innerHTML = '';
        return;
      }
      files.sort(function (a, b) {
        return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
      });
      var total = files.reduce(function (sum, f) {
        return sum + f.size;
      }, 0);
      fileList.innerHTML =
        files
          .map(function (f, i) {
            return (
              '<li><span class="fl-n mono">' +
              (i + 1) +
              '</span><span class="fl-name">' +
              f.name.replace(/[&<>"]/g, '') +
              '</span><span class="fl-size mono small">' +
              human(f.size) +
              '</span></li>'
            );
          })
          .join('') +
        '<li class="fl-total"><span class="fl-name">' +
        files.length +
        ' pages, in this order</span><span class="fl-size mono small">' +
        human(total) +
        '</span></li>';
      fileList.hidden = false;
    });
  }

  function showErrors(messages) {
    var existing = document.querySelector('.form-errors[data-upload-errors]');
    if (existing) existing.remove();
    var box = document.createElement('div');
    box.className = 'form-errors';
    box.setAttribute('data-upload-errors', '');
    box.setAttribute('role', 'alert');
    box.innerHTML =
      '<p class="form-errors-head">That upload did not go through</p><ul>' +
      messages
        .map(function (m) {
          return '<li>' + String(m).replace(/[&<>]/g, '') + '</li>';
        })
        .join('') +
      '</ul>';
    form.parentNode.insertBefore(box, form);
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  form.addEventListener('submit', function (e) {
    if (!window.FormData || !window.XMLHttpRequest) return; // let the browser try
    e.preventDefault();

    var mode = currentMode();
    if (mode === 'document' && docInput && !docInput.files.length) {
      showErrors(['Choose a document file first.']);
      return;
    }
    if (mode === 'images' && imagesInput && !imagesInput.files.length) {
      showErrors(['Choose the page images first.']);
      return;
    }

    var payload = new FormData(form);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.getAttribute('action') || '/drafts', true);
    xhr.setRequestHeader('X-CSRF-Token', form.getAttribute('data-csrf') || '');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.setRequestHeader('Accept', 'application/json');

    if (submit) submit.disabled = true;
    if (progress) progress.hidden = false;

    xhr.upload.addEventListener('progress', function (evt) {
      if (!evt.lengthComputable || !progressBar) return;
      var pct = Math.round((evt.loaded / evt.total) * 100);
      progressBar.style.width = pct + '%';
      if (progressLabel) {
        progressLabel.textContent = pct < 100 ? 'Uploading… ' + pct + '%' : 'Converting…';
      }
    });

    xhr.addEventListener('load', function () {
      var json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch (err) {
        /* fall through to the generic message */
      }
      if (xhr.status >= 200 && xhr.status < 300 && json && json.ok) {
        window.location.href = json.redirect || '/drafts';
        return;
      }
      if (submit) submit.disabled = false;
      if (progress) progress.hidden = true;
      if (progressBar) progressBar.style.width = '0%';
      showErrors((json && json.errors) || ['The server refused that upload. Please try again.']);
    });

    xhr.addEventListener('error', function () {
      if (submit) submit.disabled = false;
      if (progress) progress.hidden = true;
      showErrors(['The connection dropped during the upload. Please try again.']);
    });

    xhr.send(payload);
  });
})();
