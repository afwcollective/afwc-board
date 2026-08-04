/* AFWC reader — threaded page comments, review-pane style.
 *
 * A comment anchored to a page starts a THREAD. Anyone can reply underneath it;
 * replies always attach to the comment that started the thread, so there is
 * exactly one level of nesting no matter what you click Reply on — the same
 * shape a Word review pane has. Whoever owns the draft (plus leaders and the
 * person who started the thread) can mark a thread resolved: it collapses to
 * one muted line, sinks below the open threads, and refuses replies until it is
 * reopened.
 *
 * Talks to src/routes/reader.js:
 *   GET  /drafts/:id/comments?page=N   threads anchored to one page
 *   GET  /drafts/:id/comments?all=1    every page's threads, page-grouped
 *   POST /drafts/:id/comments          {page_number, body} | {parent_id, body}
 *   POST /comments/:id/resolve         toggle
 *   POST /comments/:id/delete          author-or-leader
 *
 * The CSRF token rides in the X-CSRF-Token header, which is what
 * src/auth/middleware.js checkCsrf accepts for requests it cannot body-parse.
 * Every handler here is delegated — script-src 'self' means no inline onclick.
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
  var openBadge = api.root.querySelector('[data-page-open]');
  var scopeButtons = Array.prototype.slice.call(panel.querySelectorAll('[data-scope]'));

  var scope = 'page';
  var counts = normalizeCounts(api.data.commentCounts);
  var token = 0;

  /* View state that has to survive a re-render:
   *   expanded    — resolved threads the reader has clicked "show" on
   *   openReply   — the one thread whose reply box is open
   *   replyDrafts — half-typed replies, keyed by thread id
   */
  var expanded = Object.create(null);
  var openReply = null;
  var replyDrafts = Object.create(null);

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Counts arrive as { page: { total, open } } from both the JSON API and the
   * server-rendered blob in drafts/show.ejs. The scalar branch only guards
   * against a stale cached page handing over the flat numbers the pre-threads
   * version emitted.
   */
  function normalizeCounts(raw) {
    var out = Object.create(null);
    Object.keys(raw || {}).forEach(function (page) {
      var v = raw[page];
      out[page] =
        v && typeof v === 'object'
          ? { total: Number(v.total || 0), open: Number(v.open || 0) }
          : { total: Number(v || 0), open: Number(v || 0) };
    });
    return out;
  }

  function totalCount() {
    return Object.keys(counts).reduce(function (sum, key) {
      return sum + counts[key].total;
    }, 0);
  }

  function syncBadges() {
    if (countBadge) countBadge.textContent = String(totalCount());
    if (openBadge) {
      var open = (counts[api.current] || {}).open || 0;
      openBadge.textContent = open ? String(open) : '';
      openBadge.hidden = !open;
      openBadge.setAttribute(
        'title',
        open === 1 ? '1 open comment thread on this page' : open + ' open comment threads on this page'
      );
    }
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /* ---------------- rendering ---------------- */

  function metaBits(c) {
    return (
      '<span class="rc-author">' +
      esc(c.author || 'a member') +
      '</span>' +
      '<span class="rc-when" title="' +
      esc(c.created_label || '') +
      '">' +
      esc(c.created) +
      '</span>'
    );
  }

  function pageAnchor(n) {
    return (
      '<button type="button" class="rc-anchor" data-jump="' +
      n +
      '" title="Go to page ' +
      n +
      '">p.' +
      n +
      '</button>'
    );
  }

  function replyHtml(r) {
    return (
      '<li class="rc-reply' +
      (r.mine ? ' rc-reply--mine' : '') +
      '" data-comment-id="' +
      r.id +
      '">' +
      '<p class="rc-item-meta mono small">' +
      metaBits(r) +
      (r.canDelete
        ? '<button type="button" class="rc-del" data-delete="' + r.id + '" title="Remove this reply">Remove</button>'
        : '') +
      '</p>' +
      '<div class="rc-body prose">' +
      r.body_html +
      '</div>' +
      '</li>'
    );
  }

  /** The single muted line a resolved, un-expanded thread collapses to. */
  function collapsedHtml(t) {
    return (
      '<p class="rc-resolved-line mono small">' +
      pageAnchor(t.page_number) +
      '<span class="rc-resolved-tag">Resolved — ' +
      esc(t.resolved_by || 'a member') +
      '</span>' +
      (t.replies.length
        ? '<span class="rc-dot">·</span><span>' + plural(t.replies.length, 'reply', 'replies') + '</span>'
        : '') +
      '<span class="rc-line-actions">' +
      (t.canResolve ? '<button type="button" class="rc-link" data-resolve="' + t.id + '">reopen</button>' : '') +
      '<button type="button" class="rc-link" data-expand="' + t.id + '">show</button>' +
      '</span>' +
      '</p>'
    );
  }

  function replyZoneHtml(t) {
    // Both of these match a server-side refusal in POST /drafts/:id/comments —
    // the panel simply does not offer what the API would turn down.
    if (t.removed) return '';
    if (t.resolved) {
      return '<p class="rc-reply-hint small">Resolved. Reopen this thread to reply to it.</p>';
    }
    if (openReply === t.id) {
      return (
        '<form class="rc-reply-form" data-reply-form="' +
        t.id +
        '">' +
        '<label class="visually-hidden" for="rc-reply-' +
        t.id +
        '">Reply to this thread</label>' +
        '<textarea id="rc-reply-' +
        t.id +
        '" rows="2" maxlength="4000" placeholder="Reply…">' +
        esc(replyDrafts[t.id] || '') +
        '</textarea>' +
        '<div class="rc-reply-actions">' +
        '<button type="button" class="rc-link" data-reply-cancel="' +
        t.id +
        '">Cancel</button>' +
        '<button type="submit" class="btn btn--primary btn--sm">Reply</button>' +
        '</div>' +
        '</form>'
      );
    }
    return (
      '<p class="rc-reply-zone">' +
      '<button type="button" class="rc-link rc-reply-open" data-reply-open="' +
      t.id +
      '">Reply</button>' +
      '</p>'
    );
  }

  function threadHtml(t) {
    if (t.resolved && !expanded[t.id]) {
      return (
        '<article class="rc-thread rc-thread--resolved" data-thread-id="' +
        t.id +
        '">' +
        collapsedHtml(t) +
        '</article>'
      );
    }

    var head =
      '<p class="rc-item-meta mono small">' +
      pageAnchor(t.page_number) +
      (t.removed ? '<span class="rc-author rc-author--gone">Comment removed</span>' : metaBits(t)) +
      (t.canResolve
        ? '<button type="button" class="rc-resolve" data-resolve="' +
          t.id +
          '">' +
          (t.resolved ? 'Reopen' : 'Resolve') +
          '</button>'
        : '') +
      (t.canDelete
        ? '<button type="button" class="rc-del" data-delete="' + t.id + '" title="Remove this comment">Remove</button>'
        : '') +
      '</p>';

    var banner = t.resolved
      ? '<p class="rc-resolved-banner mono small">Resolved — ' +
        esc(t.resolved_by || 'a member') +
        '<button type="button" class="rc-link" data-collapse="' +
        t.id +
        '">hide</button></p>'
      : '';

    var body = t.removed
      ? '<p class="rc-removed">This comment was removed. The replies below are still here.</p>'
      : '<div class="rc-body prose">' + t.body_html + '</div>';

    var replies = t.replies.length
      ? '<ol class="rc-replies">' + t.replies.map(replyHtml).join('') + '</ol>'
      : '';

    return (
      '<article class="rc-thread' +
      (t.mine ? ' rc-thread--mine' : '') +
      (t.resolved ? ' rc-thread--resolved is-open' : '') +
      (t.removed ? ' rc-thread--removed' : '') +
      '" data-thread-id="' +
      t.id +
      '">' +
      banner +
      head +
      body +
      replies +
      replyZoneHtml(t) +
      '</article>'
    );
  }

  function render(threads) {
    if (!threads.length) {
      list.innerHTML =
        '<p class="rc-empty">' +
        (scope === 'all' ? 'No comments on this draft yet.' : 'No comments on this page yet.') +
        '</p>';
      return;
    }
    list.innerHTML = threads.map(threadHtml).join('');

    // Put the cursor back where the reader just asked for it.
    if (openReply !== null) {
      var box = list.querySelector('[data-reply-form="' + openReply + '"] textarea');
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
  }

  /* ---------------- loading ---------------- */

  /** Keeps a half-typed reply alive across a re-render. */
  function stashReplyDraft() {
    if (openReply === null) return;
    var box = list.querySelector('[data-reply-form="' + openReply + '"] textarea');
    if (box) replyDrafts[openReply] = box.value;
  }

  function load() {
    var mine = ++token;
    var url =
      '/drafts/' + api.draftId + '/comments' + (scope === 'all' ? '?all=1' : '?page=' + api.current);

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
        counts = normalizeCounts(json.counts);
        syncBadges();
        render(json.threads || []);
        list.removeAttribute('aria-busy');
      })
      .catch(function () {
        if (mine !== token) return;
        list.innerHTML = '<p class="rc-empty">Comments could not be loaded.</p>';
        list.removeAttribute('aria-busy');
      });
  }

  /* ---------------- interactions ---------------- */

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
    window.setTimeout(function () {
      errorBox.hidden = true;
    }, 6000);
  }

  /** POST that expects {ok:true,…} and surfaces the server's own message. */
  function send(url, payload) {
    var options = {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    };
    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }
    return api.fetch(url, options).then(function (r) {
      return r
        .json()
        .catch(function () {
          return {};
        })
        .then(function (json) {
          if (!r.ok || !json.ok) throw new Error(json.error || 'That did not go through.');
          return json;
        });
    });
  }

  list.addEventListener('click', function (e) {
    var el;

    el = e.target.closest('[data-jump]');
    if (el) {
      api.goTo(el.getAttribute('data-jump'), { source: 'comment' });
      if (scope === 'all') setScope('page');
      return;
    }

    el = e.target.closest('[data-expand]');
    if (el) {
      expanded[el.getAttribute('data-expand')] = true;
      stashReplyDraft();
      load();
      return;
    }

    el = e.target.closest('[data-collapse]');
    if (el) {
      delete expanded[el.getAttribute('data-collapse')];
      stashReplyDraft();
      load();
      return;
    }

    el = e.target.closest('[data-reply-open]');
    if (el) {
      stashReplyDraft();
      openReply = Number(el.getAttribute('data-reply-open'));
      load();
      return;
    }

    el = e.target.closest('[data-reply-cancel]');
    if (el) {
      delete replyDrafts[el.getAttribute('data-reply-cancel')];
      openReply = null;
      load();
      return;
    }

    el = e.target.closest('[data-resolve]');
    if (el) {
      var resolveId = el.getAttribute('data-resolve');
      el.disabled = true;
      stashReplyDraft();
      send('/comments/' + resolveId + '/resolve')
        .then(function (json) {
          // Resolving lets the thread collapse and sink; reopening should leave
          // it open on screen rather than making you hunt for it again.
          if (json.resolved) delete expanded[resolveId];
          else expanded[resolveId] = true;
          load();
        })
        .catch(function (err) {
          el.disabled = false;
          showError(err.message);
        });
      return;
    }

    el = e.target.closest('[data-delete]');
    if (el) {
      if (!window.confirm('Remove this comment?')) return;
      el.disabled = true;
      stashReplyDraft();
      send('/comments/' + el.getAttribute('data-delete') + '/delete')
        .then(load)
        .catch(function (err) {
          el.disabled = false;
          showError(err.message || 'That comment could not be removed.');
        });
    }
  });

  /* replies — one delegated submit handler covers every open reply box */
  list.addEventListener('submit', function (e) {
    var replyForm = e.target.closest('[data-reply-form]');
    if (!replyForm) return;
    e.preventDefault();

    var parentId = Number(replyForm.getAttribute('data-reply-form'));
    var box = replyForm.querySelector('textarea');
    var body = (box.value || '').trim();
    if (!body) {
      showError('Write something first.');
      return;
    }
    var button = replyForm.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    replyDrafts[parentId] = box.value;

    send('/drafts/' + api.draftId + '/comments', { parent_id: parentId, body: body })
      .then(function () {
        delete replyDrafts[parentId];
        openReply = null;
        load();
      })
      .catch(function (err) {
        if (button) button.disabled = false;
        showError(err.message || 'That reply did not post.');
      });
  });

  /* Cmd/Ctrl+Enter inside a reply box posts it. */
  list.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    var replyForm = e.target.closest('[data-reply-form]');
    if (!replyForm) return;
    e.preventDefault();
    replyForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });

  function setScope(next) {
    scope = next;
    scopeButtons.forEach(function (btn) {
      btn.classList.toggle('is-on', btn.getAttribute('data-scope') === scope);
    });
    stashReplyDraft();
    load();
  }

  scopeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setScope(btn.getAttribute('data-scope'));
    });
  });

  /* ---------------- starting a thread ---------------- */

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

      send('/drafts/' + api.draftId + '/comments', { page_number: api.current, body: body })
        .then(function () {
          textarea.value = '';
          openReply = null;
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
    syncBadges();
    if (scope === 'page') {
      stashReplyDraft();
      openReply = null;
      load();
    } else if (targetLabel) {
      targetLabel.textContent = 'on page ' + api.current;
    }
  });

  syncBadges();
})();
