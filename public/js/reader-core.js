/* AFWC reader — shared chrome.
 *
 * Owns everything the three reader modes have in common: which page you are on,
 * the pager, the keyboard, the #p=N deep link, the section menu, the
 * processing poll, the comments-panel toggle and the anti-copy handlers.
 *
 * Publishes window.AFWCReader before comments.js and the mode script run
 * (defer preserves document order), so both can just subscribe:
 *
 *   AFWCReader.on('page', function (n, meta) { ... })
 *   AFWCReader.goTo(4)
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-reader]');
  if (!root) return;

  var data = { pageSizes: [], commentCounts: {}, sections: [] };
  var dataEl = root.querySelector('[data-reader-data]');
  if (dataEl) {
    try {
      data = JSON.parse(dataEl.textContent) || data;
    } catch (err) {
      /* keep the defaults */
    }
  }

  var listeners = Object.create(null);

  var api = {
    root: root,
    draftId: Number(root.getAttribute('data-draft-id')),
    kind: root.getAttribute('data-kind'),
    mode: root.getAttribute('data-mode'),
    status: root.getAttribute('data-status'),
    pageCount: Number(root.getAttribute('data-page-count')) || 0,
    threadId: root.getAttribute('data-thread-id') || null,
    csrf: root.getAttribute('data-csrf') || '',
    current: 1,
    data: data,

    on: function (event, fn) {
      (listeners[event] || (listeners[event] = [])).push(fn);
      return api;
    },
    emit: function (event) {
      var args = Array.prototype.slice.call(arguments, 1);
      (listeners[event] || []).forEach(function (fn) {
        try {
          fn.apply(null, args);
        } catch (err) {
          if (window.console) console.error('[reader]', event, err);
        }
      });
    },
    /** Same-origin fetch that never gets cached and always carries the session. */
    fetch: function (url, options) {
      var opts = options || {};
      opts.credentials = 'same-origin';
      opts.cache = 'no-store';
      opts.headers = Object.assign({ 'X-CSRF-Token': api.csrf }, opts.headers || {});
      return fetch(url, opts);
    },
  };

  window.AFWCReader = api;

  /* ---------------- page state ---------------- */

  var readoutEl = root.querySelector('[data-page-current]');
  var prevBtn = root.querySelector('[data-page-prev]');
  var nextBtn = root.querySelector('[data-page-next]');
  var sectionNav = root.querySelector('[data-section-nav]');
  var readoutBtn = root.querySelector('[data-page-readout]');
  var jumpInput = root.querySelector('[data-page-jump]');

  function clamp(n) {
    n = Math.round(Number(n) || 1);
    if (!api.pageCount) return 1;
    return Math.min(Math.max(n, 1), api.pageCount);
  }

  var hashLock = false;

  function writeHash(n) {
    hashLock = true;
    var hash = '#p=' + n;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    } else {
      window.location.hash = hash;
    }
    window.setTimeout(function () {
      hashLock = false;
    }, 0);
  }

  function readHash() {
    var m = /(?:^|[#&])p=(\d+)/.exec(window.location.hash || '');
    return m ? clamp(m[1]) : null;
  }

  /**
   * goTo(n, meta) — meta.source is 'init' | 'pager' | 'key' | 'hash' | 'scroll'
   * | 'section' | 'comment'. Mode scripts use it to avoid fighting the user's
   * own scrolling.
   */
  api.goTo = function (n, meta) {
    var target = clamp(n);
    var info = meta || {};
    if (target === api.current && info.source !== 'init' && !info.force) return target;
    api.current = target;

    if (readoutEl) readoutEl.textContent = String(target);
    if (prevBtn) prevBtn.disabled = target <= 1;
    if (nextBtn) nextBtn.disabled = target >= api.pageCount;
    if (sectionNav) syncSectionNav(target);
    if (info.source !== 'init' || target !== 1) writeHash(target);

    api.emit('page', target, info);
    return target;
  };

  function syncSectionNav(page) {
    var best = null;
    (api.data.sections || []).forEach(function (pair) {
      if (pair[0] <= page) best = pair[0];
    });
    if (best !== null) sectionNav.value = String(best);
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      api.goTo(api.current - 1, { source: 'pager' });
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      api.goTo(api.current + 1, { source: 'pager' });
    });
  }
  if (sectionNav) {
    sectionNav.addEventListener('change', function () {
      api.goTo(sectionNav.value, { source: 'section' });
    });
  }

  /**
   * Jump-to-page: the "n / N" readout is a real <button> so it is reachable
   * and activatable from the keyboard; activating it swaps it for a number
   * input pinned to the same slot (CSS reserves the width so nothing shifts).
   * Enter or blur commits through the ONE navigation path — api.goTo, same as
   * the pager arrows and the section menu — so the hash, the lazy render and
   * the comments panel all stay in sync. Escape cancels without navigating.
   */
  var suppressJumpBlur = false;

  function openJump() {
    if (!jumpInput || !readoutBtn) return;
    jumpInput.max = String(api.pageCount || 1);
    jumpInput.value = String(api.current);
    readoutBtn.hidden = true;
    jumpInput.hidden = false;
    jumpInput.focus();
    jumpInput.select();
  }

  function closeJump() {
    if (!jumpInput || !readoutBtn) return;
    suppressJumpBlur = true;
    jumpInput.hidden = true;
    readoutBtn.hidden = false;
    window.setTimeout(function () {
      suppressJumpBlur = false;
    }, 0);
  }

  function commitJump() {
    if (!jumpInput || jumpInput.hidden) return;
    var raw = jumpInput.value;
    closeJump();
    if (raw === '' || raw == null) return; // nothing typed — treat like cancel
    api.goTo(raw, { source: 'pager' });
  }

  function cancelJump() {
    if (!jumpInput || jumpInput.hidden) return;
    closeJump();
  }

  if (readoutBtn) {
    readoutBtn.addEventListener('click', openJump);
  }
  if (jumpInput) {
    jumpInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitJump();
        if (readoutBtn) readoutBtn.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelJump();
        if (readoutBtn) readoutBtn.focus();
      }
    });
    jumpInput.addEventListener('blur', function () {
      if (suppressJumpBlur) return;
      commitJump();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) {
      return;
    }
    if (e.key === 'ArrowLeft') {
      api.goTo(api.current - 1, { source: 'key' });
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      api.goTo(api.current + 1, { source: 'key' });
      e.preventDefault();
    } else if (e.key === 'g' && jumpInput) {
      openJump();
      e.preventDefault();
    }
  });

  window.addEventListener('hashchange', function () {
    if (hashLock) return;
    var n = readHash();
    if (n) api.goTo(n, { source: 'hash' });
  });

  /* ---------------- scroller helper (pdf + images) ---------------- */

  /**
   * Wires a column of [data-page-slot] elements to the pager: the slot filling
   * most of the viewport becomes the current page, and a pager/keyboard move
   * scrolls the matching slot into view.
   */
  api.bindScroller = function (scroller) {
    if (!scroller) return;
    var slots = Array.prototype.slice.call(scroller.querySelectorAll('[data-page-slot]'));
    if (!slots.length) return;
    var programmatic = false;

    if ('IntersectionObserver' in window) {
      var visible = Object.create(null);
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            visible[entry.target.getAttribute('data-page-slot')] = entry.intersectionRatio;
          });
          if (programmatic) return;
          var bestPage = null;
          var bestRatio = 0;
          Object.keys(visible).forEach(function (page) {
            if (visible[page] > bestRatio) {
              bestRatio = visible[page];
              bestPage = Number(page);
            }
          });
          if (bestPage && bestRatio > 0.15) api.goTo(bestPage, { source: 'scroll' });
        },
        { threshold: [0, 0.15, 0.35, 0.6, 0.9] }
      );
      slots.forEach(function (slot) {
        observer.observe(slot);
      });
    }

    api.on('page', function (n, meta) {
      if (meta && meta.source === 'scroll') return;
      var slot = scroller.querySelector('[data-page-slot="' + n + '"]');
      if (!slot) return;
      programmatic = true;
      slot.scrollIntoView({ block: 'start', behavior: meta && meta.source === 'init' ? 'auto' : 'smooth' });
      window.setTimeout(function () {
        programmatic = false;
      }, 700);
    });
  };

  /* ---------------- anti-download basics ---------------- */

  var pane = root.querySelector('[data-pane]');
  if (pane) {
    ['contextmenu', 'copy', 'cut', 'dragstart'].forEach(function (type) {
      pane.addEventListener(type, function (e) {
        e.preventDefault();
      });
    });
  }

  /* ---------------- comments panel toggle (narrow screens) ---------------- */

  var toggle = root.querySelector('[data-comments-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = root.classList.toggle('is-comments-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var box = root.querySelector('[data-comments]');
        if (box) box.scrollTop = 0;
      }
    });
  }

  /* ---------------- sticky-bar offset ---------------- */

  var bar = root.querySelector('.reader-bar');
  function measureBar() {
    if (!bar) return;
    root.style.setProperty('--reader-bar-h', bar.offsetHeight + 'px');
  }
  measureBar();
  window.addEventListener('resize', measureBar);

  /* ---------------- processing poll ---------------- */

  if (api.status === 'processing') {
    var polls = 0;
    var timer = window.setInterval(function () {
      polls += 1;
      if (polls > 150) {
        window.clearInterval(timer);
        return;
      }
      api
        .fetch('/drafts/' + api.draftId + '/status', { headers: { Accept: 'application/json' } })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (json) {
          if (json && json.ok && json.status !== 'processing') {
            window.clearInterval(timer);
            window.location.reload();
          }
        })
        .catch(function () {
          /* transient — the next tick tries again */
        });
    }, 2000);
  }

  /* ---------------- go ----------------
   * Deferred scripts all run before DOMContentLoaded, so waiting for it is what
   * guarantees comments.js and the mode script have subscribed before the first
   * 'page' event goes out.
   */

  function start() {
    if (api.pageCount) api.goTo(readHash() || 1, { source: 'init', force: true });
  }

  if (document.readyState === 'loading' || document.readyState === 'interactive') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
