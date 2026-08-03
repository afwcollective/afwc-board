/* AFWC reader — image-sequence mode (graphic novels).
 *
 * The pages are plain <img> elements rendered by the shell with loading="lazy",
 * each streamed from the session-gated /drafts/:id/img/:n. All this script does
 * is keep the pager and the scroll position in step, and refuse to hand a page
 * over to a drag or a right-click.
 */
(function () {
  'use strict';

  var api = window.AFWCReader;
  if (!api || api.mode !== 'images') return;

  var scroller = api.root.querySelector('[data-scroller]');
  if (!scroller) return;

  api.bindScroller(scroller);

  Array.prototype.forEach.call(scroller.querySelectorAll('img'), function (img) {
    img.setAttribute('draggable', 'false');
    img.addEventListener('dragstart', function (e) {
      e.preventDefault();
    });
    img.addEventListener('error', function () {
      img.closest('[data-page-slot]').classList.add('is-broken');
    });
  });
})();
