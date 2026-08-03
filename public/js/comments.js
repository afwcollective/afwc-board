/* AFWC reader — per-page comments panel.
 *
 * Talks to three JSON endpoints in src/routes/reader.js:
 *   GET  /drafts/:id/comments?page=N   comments anchored to one page
 *   GET  /drafts/:id/comments?all=1    every page's comments, page-ordered
 *   POST /drafts/:id/comments          {page_number, body}
 *   POST /comments/:id/delete          author-or-leader
 *
 * The CSRF token rides in the X-CSRF-Token header, which is what
 * src/auth/middleware.js checkCsrf accepts for requests it cannot body-parse.
 */
(function () {
  'use strict';

  var api = window.AFWCReader;
  if (!api) return;

  var panel = api.root.querySelector('[data-comments]');
  if (!panel) return;

  var list = panel.querySelector('[data-comment-list]');
  var form = panel.querySelector('[data-comment-form]');
  var textarea = form ? form.querySelector('textarea') : null;
  var errorBox = panel.querySelector('[data-rc-error]');
  var contextLabel = panel.querySelector('[data-rc-context]');
  var targetLabel = panel.querySelector('[data-rc-target]');
  var countBadge = api.root.querySelector('[data-comment-count]');
  var scopeButtons = Array.prototype.slice.call(panel.querySelectorAll('[data-scope]'));

  var scope = 'page';
  var counts = api.data.commentCounts || {};
  var token = 0;

  /* ---------------- rendering ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function totalCount() {
    return Object.keys(counts).reduce(function (sum, key) {
      return sum + Number(counts[key] || 0);
    }, 0);
  }

  function syncBadge() {
    if (countBadge) countBadge.textContent = String(totalCount());
  }

  function render(comments) {
    if (!comments.length) {
      list.innerHTML =
        '<p class="rc-empty">' +
        (scope === 'all' ? 'No comments on this draft yet.' : 'No comments on this page yet.') +
        '</p>';
      return;
    }

    list.innerHTML = comments
      .map(function (c) {
        return (
          '<article class="rc-item' +
          (c.mine ? ' rc-item--mine' : '') +
          '" data-comment-id="' +
          c.id +
          '">' +
          '<p class="rc-item-meta mono small">' +
          '<button type="button" class="rc-anchor" data-jump="' +
          c.page_number +
          '" title="Go to page ' +
          c.page_number +
          '">p.' +
          c.page_number +
          '</button>' +
          '<span class="rc-author">' +
          esc(c.author) +
          '</span>' +
          '<span class="rc-when">' +
          esc(c.created) +
          '</span>' +
          (c.canDelete
            ? '<button type="button" class="rc-del" data-delete="' + c.id + '" title="Remove this comment">Remove</button>'
            : '') +
          '</p>' +
          '<div class="rc-body prose">' +
          c.body_html +
          '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  /* ---------------- loading ---------------- */

  function load() {
    var mine = ++token;
    var url =
      '/drafts/' +
      api.draftId +
      '/comments' +
      (scope === 'all' ? '?all=1' : '?page=' + api.current);

    if (contextLabel) {
      contextLabel.textContent = scope === 'all' ? 'Every page' : 'Page ' + api.current;
    }
    if (targetLabel) targetLabel.textContent = 'on page ' + api.current;

    list.setAttribute('aria-busy', 'true');
    api
      .fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('comments → ' + r.status);
        return r.json();
      })
      .then(function (json) {
        if (mine !== token) return;
        counts = json.counts || {};
        syncBadge();
        render(json.comments || []);
        list.removeAttribute('aria-busy');
      })
      .catch(function () {
        if (mine !== token) return;
        list.innerHTML = '<p class="rc-empty">Comments could not be loaded.</p>';
        list.removeAttribute('aria-busy');
      });
  }

  /* ---------------- interactions ---------------- */

  list.addEventListener('click', function (e) {
    var jump = e.target.closest('[data-jump]');
    if (jump) {
      api.goTo(jump.getAttribute('data-jump'), { source: 'comment' });
      if (scope === 'all') setScope('page');
      return;
    }

    var del = e.target.closest('[data-delete]');
    if (del) {
      if (!window.confirm('Remove this comment?')) return;
      var id = del.getAttribute('data-delete');
      del.disabled = true;
      api
        .fetch('/comments/' + id + '/delete', {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        })
        .then(function (r) {
          if (!r.ok) throw new Error('delete → ' + r.status);
          return r.json();
        })
        .then(function () {
          load();
        })
        .catch(function () {
          del.disabled = false;
          showError('That comment could not be removed.');
        });
    }
  });

  function setScope(next) {
    scope = next;
    scopeButtons.forEach(function (btn) {
      btn.classList.toggle('is-on', btn.getAttribute('data-scope') === scope);
    });
    load();
  }

  scopeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setScope(btn.getAttribute('data-scope'));
    });
  });

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
    window.setTimeout(function () {
      errorBox.hidden = true;
    }, 6000);
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = (textarea.value || '').trim();
      if (!body) {
        showError('Write something first.');
        return;
      }
      var button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;

      api
        .fetch('/drafts/' + api.draftId + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ page_number: api.current, body: body }),
        })
        .then(function (r) {
          return r.json().then(function (json) {
            if (!r.ok || !json.ok) throw new Error(json.error || 'That comment did not post.');
            return json;
          });
        })
        .then(function () {
          textarea.value = '';
          if (scope !== 'page') setScope('page');
          else load();
        })
        .catch(function (err) {
          showError(err.message || 'That comment did not post.');
        })
        .then(function () {
          if (button) button.disabled = false;
        });
    });

    // Cmd/Ctrl+Enter posts without reaching for the mouse.
    textarea.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }

  api.on('page', function () {
    if (scope === 'page') load();
    else if (targetLabel) targetLabel.textContent = 'on page ' + api.current;
  });

  syncBadge();
})();
