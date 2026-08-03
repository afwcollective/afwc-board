/* AFWC reader — PDF mode.
 *
 * A deliberately minimal canvas viewer built on the vendored pdf.js in
 * /vendor/pdfjs (see VERSION there). No text layer, no toolbar, no download or
 * print buttons, no annotation layer — pages are rasterised into <canvas> and
 * that is the whole surface. Only the pages within ±2 of the current one are
 * rendered; anything further than 6 away is released so a 300-page PDF does not
 * pin hundreds of megabytes of bitmaps.
 *
 * The bytes come from GET /drafts/:id/file.pdf, which is session-gated,
 * no-store and inline-only.
 */
(function () {
  'use strict';

  var api = window.AFWCReader;
  if (!api || api.mode !== 'pdf') return;

  var scroller = api.root.querySelector('[data-scroller]');
  var pane = api.root.querySelector('[data-pane]');
  if (!scroller) return;

  var RENDER_AHEAD = 2;
  var KEEP_WITHIN = 6;

  var doc = null;
  var tasks = Object.create(null); // page -> RenderTask
  var painted = Object.create(null); // page -> true
  var lastWidth = 0;

  api.bindScroller(scroller);

  function slotFor(n) {
    return scroller.querySelector('[data-page-slot="' + n + '"]');
  }

  function showError(err) {
    if (window.console) console.error('[reader-pdf]', err);
    pane.classList.add('is-failed');
    var note = document.createElement('p');
    note.className = 'reader-fetch-error';
    note.textContent = 'This PDF could not be displayed in the reader. Try reloading the page.';
    pane.insertBefore(note, pane.firstChild);
  }

  function release(n) {
    var slot = slotFor(n);
    if (!slot) return;
    if (tasks[n]) {
      try {
        tasks[n].cancel();
      } catch (err) {
        /* already finished */
      }
      delete tasks[n];
    }
    var canvas = slot.querySelector('canvas');
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    slot.classList.remove('is-painted');
    delete painted[n];
  }

  function renderPage(n) {
    if (!doc || n < 1 || n > doc.numPages || painted[n] || tasks[n]) return;
    var slot = slotFor(n);
    if (!slot) return;

    var cssWidth = Math.max(120, Math.floor(slot.clientWidth));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    doc
      .getPage(n)
      .then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var viewport = page.getViewport({ scale: cssWidth / base.width });

        var canvas = document.createElement('canvas');
        canvas.className = 'page-canvas';
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.setAttribute('draggable', 'false');
        canvas.setAttribute('aria-label', 'Page ' + n);

        var ctx = canvas.getContext('2d', { alpha: false });
        var task = page.render({
          canvasContext: ctx,
          viewport: viewport,
          transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
        });
        tasks[n] = task;

        return task.promise.then(function () {
          delete tasks[n];
          painted[n] = true;
          slot.classList.add('is-painted');
          slot.style.aspectRatio = viewport.width + ' / ' + viewport.height;
          slot.insertBefore(canvas, slot.firstChild);
          page.cleanup();
        });
      })
      .catch(function (err) {
        delete tasks[n];
        if (err && err.name === 'RenderingCancelledException') return;
        if (window.console) console.warn('[reader-pdf] page ' + n, err);
      });
  }

  function renderAround(n) {
    if (!doc) return;
    for (var p = n - RENDER_AHEAD; p <= n + RENDER_AHEAD; p += 1) renderPage(p);
    Object.keys(painted).forEach(function (key) {
      if (Math.abs(Number(key) - n) > KEEP_WITHIN) release(Number(key));
    });
  }

  api.on('page', function (n) {
    renderAround(n);
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      var width = scroller.clientWidth;
      if (Math.abs(width - lastWidth) < 24) return;
      lastWidth = width;
      Object.keys(painted).forEach(function (key) {
        release(Number(key));
      });
      renderAround(api.current);
    }, 250);
  });

  import('/vendor/pdfjs/pdf.min.mjs')
    .then(function (pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return pdfjsLib.getDocument({
        url: '/drafts/' + api.draftId + '/file.pdf',
        withCredentials: true,
        isEvalSupported: false,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      }).promise;
    })
    .then(function (pdf) {
      doc = pdf;
      lastWidth = scroller.clientWidth;
      pane.classList.add('is-ready');
      renderAround(api.current);
    })
    .catch(showError);
})();
