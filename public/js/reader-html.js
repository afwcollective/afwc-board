/* AFWC reader — converted-document mode (.docx, .txt, .md).
 *
 * One page in view at a time. Page 1 arrives with the shell so there is
 * something to read before any JS runs; every move after that fetches the
 * sanitized fragment from GET /drafts/:id/page/:n.
 */
(function () {
  'use strict';

  var api = window.AFWCReader;
  if (!api || api.mode !== 'html') return;

  var target = api.root.querySelector('[data-page-content]');
  var pane = api.root.querySelector('[data-pane]');
  if (!target) return;

  var cache = Object.create(null);
  var token = 0;

  // Page 1 was server-rendered — seed the cache so going back to it is instant.
  cache[1] = target.innerHTML;

  function paint(n, html) {
    target.innerHTML = html;
    target.setAttribute('data-current-page', String(n));
    pane.classList.remove('is-loading');
  }

  function load(n, meta) {
    if (cache[n] !== undefined) {
      paint(n, cache[n]);
      scroll(meta);
      return;
    }
    var mine = ++token;
    pane.classList.add('is-loading');
    api
      .fetch('/drafts/' + api.draftId + '/page/' + n)
      .then(function (r) {
        if (!r.ok) throw new Error('page ' + n + ' → ' + r.status);
        return r.text();
      })
      .then(function (html) {
        if (mine !== token) return;
        cache[n] = html;
        paint(n, html);
        scroll(meta);
      })
      .catch(function () {
        if (mine !== token) return;
        paint(
          n,
          '<p class="reader-fetch-error">That page could not be loaded. Reload the page to try again.</p>'
        );
      });
  }

  function scroll(meta) {
    if (meta && meta.source === 'init') return;
    var top = pane.getBoundingClientRect().top + window.pageYOffset;
    var barVar = getComputedStyle(api.root).getPropertyValue('--reader-bar-h');
    var offset = parseInt(barVar, 10) || 0;
    window.scrollTo({ top: Math.max(0, top - offset - 12), behavior: 'smooth' });
  }

  api.on('page', function (n, meta) {
    load(n, meta);
  });
})();
