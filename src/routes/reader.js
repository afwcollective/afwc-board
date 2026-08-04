'use strict';

/**
 * The locked in-browser reader and its auth-gated content streams (Phases 4–5):
 *   GET  /drafts/:id            reader shell (mode chosen by draft kind)
 *   GET  /drafts/:id/status     JSON status for the processing poll
 *   GET  /drafts/:id/page/:n    sanitized HTML fragment, no-store
 *   GET  /drafts/:id/file.pdf   inline PDF stream with Range support
 *   GET  /drafts/:id/img/:n     page image streamed through the session check
 *   GET  /drafts/:id/comments   JSON threads, ?page=N or ?all=1
 *   POST /drafts/:id/comments   JSON or form; starts a thread, or replies to one
 *   POST /comments/:id/resolve  uploader / leader / thread author toggle
 *   POST /comments/:id/delete   author-or-leader soft delete
 *   POST /drafts/:id/conversation             a post in the draft's board thread
 *   POST /drafts/:id/conversation/:pid/delete author-or-leader soft delete
 *
 * Mounted at / by src/app.js (after the /drafts router) so these paths sit
 * alongside the draft library without either file importing the other.
 *
 * Every byte of draft content leaves through this file, and every route here is
 * requireMember + not-deleted + `Cache-Control: private, no-store`. uploads/ is
 * never a static directory (src/app.js statics public/ only), so a shared URL is
 * dead the moment it leaves a session.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { db, getSetting } = require('../db');
const { requireMember } = require('../auth/middleware');
const { isLeaderUser } = require('../auth/roles');
const { flash } = require('../util/flash');
const { mdToHtml, toPlainText } = require('../util/sanitize');
const dates = require('../util/dates');
const { resolveInDraft } = require('../services/ingest/paths');
const { buildWatermarkDataUri } = require('../util/watermark');

const router = express.Router();

const KIND_LABEL = { docx: 'Word', pdf: 'PDF', text: 'Text', images: 'Graphic novel' };

/** The reader mode each draft kind is rendered with. */
const READER_MODE = { docx: 'html', text: 'html', pdf: 'pdf', images: 'images' };

const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const MAX_COMMENT_CHARS = 4000;
const MAX_POST_CHARS = 20000;

/* ---------------- shared helpers ---------------- */

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

const q = {
  draft: () =>
    db.prepare(
      `SELECT d.*, u.display_name AS uploader_name, u.username AS uploader_username
         FROM drafts d JOIN users u ON u.id = d.user_id
        WHERE d.id = ? AND d.deleted_at IS NULL`
    ),
  status: () => db.prepare('SELECT status, page_count, error_msg FROM drafts WHERE id = ? AND deleted_at IS NULL'),
  page: () => db.prepare('SELECT * FROM draft_pages WHERE draft_id = ? AND page_number = ?'),
  sections: () =>
    db.prepare(
      `SELECT page_number, heading FROM draft_pages
        WHERE draft_id = ? AND heading IS NOT NULL AND heading <> ''
        ORDER BY page_number`
    ),
  pageSizes: () =>
    db.prepare('SELECT page_number, width, height FROM draft_pages WHERE draft_id = ? ORDER BY page_number'),
  /* -- the draft's general discussion thread, embedded in the reader -- */
  thread: () =>
    db.prepare(
      `SELECT t.id, t.title, t.is_locked, t.user_id, u.display_name AS author_name
         FROM threads t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.draft_id = ? AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1`
    ),
  threadPosts: () =>
    db.prepare(
      `SELECT p.id, p.user_id, p.body_html, p.created_at,
              u.display_name AS author_name
         FROM posts p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.thread_id = ? AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC, p.id ASC`
    ),
  insertPost: () =>
    db.prepare(
      `INSERT INTO posts (thread_id, user_id, body_html, body_md) VALUES (?, ?, ?, ?)`
    ),
  touchThread: () =>
    db.prepare(`UPDATE threads SET last_post_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`),
  postById: () =>
    db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL'),
  deletePost: () =>
    db.prepare(
      `UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE id = ? AND deleted_at IS NULL`
    ),

  /* -- threaded page comments --
   * The TOP-LEVEL queries deliberately include soft-deleted rows: a removed
   * comment whose replies survived still has to render as "Comment removed"
   * so the thread underneath it stays readable. buildThreads() drops the ones
   * with nothing left under them. The REPLY query never returns deleted rows —
   * removing a reply removes just that line.
   */
  topLevelForPage: () =>
    db.prepare(
      `SELECT c.id, c.page_number, c.body_html, c.created_at, c.user_id, c.deleted_at,
              c.resolved_at, c.resolved_by,
              u.display_name AS author_name, r.display_name AS resolver_name
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users r ON r.id = c.resolved_by
        WHERE c.draft_id = ? AND c.page_number = ? AND c.parent_id IS NULL
        ORDER BY c.created_at ASC, c.id ASC`
    ),
  topLevelAll: () =>
    db.prepare(
      `SELECT c.id, c.page_number, c.body_html, c.created_at, c.user_id, c.deleted_at,
              c.resolved_at, c.resolved_by,
              u.display_name AS author_name, r.display_name AS resolver_name
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users r ON r.id = c.resolved_by
        WHERE c.draft_id = ? AND c.parent_id IS NULL
        ORDER BY c.page_number ASC, c.created_at ASC, c.id ASC`
    ),
  repliesForDraft: () =>
    db.prepare(
      `SELECT c.id, c.parent_id, c.page_number, c.body_html, c.created_at, c.user_id,
              u.display_name AS author_name
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.draft_id = ? AND c.parent_id IS NOT NULL AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC, c.id ASC`
    ),
  /**
   * Per page: `total` = every visible comment (thread starters + replies);
   * `open` = unresolved, undeleted threads — what the pager badge counts.
   * A removed-but-still-rendered thread starter is in neither number: there is
   * nothing left on it to act on, and its surviving replies are counted.
   */
  commentCounts: () =>
    db.prepare(
      `SELECT page_number,
              COUNT(*) AS total,
              SUM(CASE WHEN parent_id IS NULL AND resolved_at IS NULL THEN 1 ELSE 0 END) AS open
         FROM comments
        WHERE draft_id = ? AND deleted_at IS NULL
        GROUP BY page_number`
    ),
  insertComment: () =>
    db.prepare(
      `INSERT INTO comments (draft_id, page_number, parent_id, user_id, body_html, body_md)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
  commentById: () =>
    db.prepare('SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL'),
  /** Includes soft-deleted rows — parent validation has to see them to refuse them. */
  commentByIdAny: () => db.prepare('SELECT * FROM comments WHERE id = ?'),
  resolvedRow: () =>
    db.prepare(
      `SELECT c.resolved_at, r.display_name AS resolver_name
         FROM comments c LEFT JOIN users r ON r.id = c.resolved_by WHERE c.id = ?`
    ),
  setResolved: () =>
    db.prepare(
      `UPDATE comments SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ?
        WHERE id = ?`
    ),
  clearResolved: () =>
    db.prepare('UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?'),
  deleteComment: () =>
    db.prepare(
      `UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE id = ? AND deleted_at IS NULL`
    ),
};

/**
 * Loads the draft named by :id or ends the request. `mode` picks the failure
 * shape: 'html' renders the error page, 'json' answers JSON, 'bytes' sends a
 * bare status so a stream never leaks a rendered page.
 */
function loadDraft(req, res, next, mode = 'html') {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    fail(res, next, mode, 404, 'That draft is not here.');
    return null;
  }
  const draft = q.draft().get(id);
  if (!draft) {
    fail(res, next, mode, 404, 'That draft is not here — it may have been removed.');
    return null;
  }
  return draft;
}

function fail(res, next, mode, status, message) {
  if (mode === 'json') {
    noStore(res);
    res.status(status).json({ ok: false, error: message });
    return;
  }
  if (mode === 'bytes') {
    noStore(res);
    res.status(status).type('text/plain').send(message);
    return;
  }
  const err = new Error(message);
  err.status = status;
  next(err);
}

const isLeader = (user) => isLeaderUser(user);
const canManageDraft = (user, draft) => !!user && (user.id === draft.user_id || isLeader(user));

/**
 * Who may settle a thread: the person whose draft it is, any leader, and the
 * member who started the thread. Deliberately NOT "anyone who replied" — the
 * point of resolving is that the note has been dealt with, and only those
 * three are in a position to say so.
 */
const canResolveThread = (user, draft, row) =>
  !!user && (user.id === draft.user_id || isLeader(user) || row.user_id === user.id);

function replyJson(row, user) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    page_number: row.page_number,
    author: row.author_name || 'Former member',
    body_html: row.body_html,
    created: dates.relative(row.created_at),
    created_at: row.created_at,
    created_label: dates.formatDateTime(row.created_at),
    mine: !!user && row.user_id === user.id,
    canDelete: !!user && (row.user_id === user.id || isLeader(user)),
  };
}

function threadJson(row, replies, user, draft) {
  const removed = !!row.deleted_at;
  return {
    id: row.id,
    page_number: row.page_number,
    // A removed thread starter keeps its slot (so the replies still hang off
    // something) but gives up its author, body and every affordance.
    removed,
    author: removed ? null : row.author_name || 'Former member',
    body_html: removed ? '' : row.body_html,
    created: dates.relative(row.created_at),
    created_at: row.created_at,
    created_label: dates.formatDateTime(row.created_at),
    mine: !removed && !!user && row.user_id === user.id,
    canDelete: !removed && !!user && (row.user_id === user.id || isLeader(user)),
    canResolve: !removed && canResolveThread(user, draft, row),
    resolved: !!row.resolved_at,
    resolved_by: row.resolved_at ? row.resolver_name || 'a member' : null,
    resolved_when: row.resolved_at ? dates.relative(row.resolved_at) : null,
    replies: replies.map((r) => replyJson(r, user)),
  };
}

/**
 * Stitches thread starters to their replies and puts them in review-pane order:
 * open threads first, resolved ones sunk to the bottom, oldest first inside
 * each group (Array#sort is stable, and both queries already come back in
 * created order). `all` also groups by page, ascending.
 */
function buildThreads(rows, replyRows, user, draft, all) {
  const byParent = new Map();
  for (const r of replyRows) {
    if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
    byParent.get(r.parent_id).push(r);
  }

  const threads = [];
  for (const row of rows) {
    const replies = byParent.get(row.id) || [];
    // Removed starter with nothing left underneath it: drop the whole card.
    if (row.deleted_at && !replies.length) continue;
    threads.push(threadJson(row, replies, user, draft));
  }

  threads.sort((a, b) =>
    all
      ? a.page_number - b.page_number || Number(a.resolved) - Number(b.resolved)
      : Number(a.resolved) - Number(b.resolved)
  );
  return threads;
}

/** { "2": { total, open } } for the tab badge and the per-page pager dot. */
function countsFor(draftId) {
  const counts = {};
  for (const row of q.commentCounts().all(draftId)) {
    counts[row.page_number] = { total: row.total, open: row.open || 0 };
  }
  return counts;
}

/* ---------------- reader shell ---------------- */

// The Phase-3 placeholder lived at /reader; keep the URL alive as a signpost.
router.get('/reader', requireMember, (req, res) => res.redirect('/drafts'));

router.get('/drafts/:id', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'html');
  if (!draft) return undefined;

  // A failed draft is only visible to the person who uploaded it and to leaders.
  if (draft.status === 'failed' && !canManageDraft(req.user, draft)) {
    return fail(res, next, 'html', 404, 'That draft is not here — it may have been removed.');
  }

  const mode = READER_MODE[draft.kind] || 'html';
  const sections = draft.status === 'ready' && mode === 'html' ? q.sections().all(draft.id) : [];
  const pageSizes = draft.status === 'ready' && mode !== 'html' ? q.pageSizes().all(draft.id) : [];
  const counts = countsFor(draft.id);

  /*
   * The draft's general discussion — "THE CONVERSATION" — rendered right here
   * rather than linked out to /board/:id. It is a perfectly ordinary board
   * thread (created at upload by src/routes/drafts.js, kept out of the board
   * index because it carries a draft_id), so /board/:id still renders the same
   * posts; the reader is simply a second, better-placed door onto it.
   *
   * If a leader has removed the thread there is nothing to embed and the whole
   * section disappears — a removed thread stays removed rather than springing
   * back to life the first time somebody types into the reader.
   */
  const thread = q.thread().get(draft.id);
  const posts = thread ? q.threadPosts().all(thread.id) : [];

  let firstPageHtml = '';
  if (draft.status === 'ready' && mode === 'html') {
    const first = q.page().get(draft.id, 1);
    if (first) firstPageHtml = first.content_html || '';
  }

  const pageJs = ['/js/reader-core.js', '/js/comments.js'];
  if (draft.status === 'ready') pageJs.push(`/js/reader-${mode}.js`);

  // Faint, tiled tag of the CURRENT VIEWER's name — see src/util/watermark.js.
  // Built per-request (never cached) so it always reflects whoever is looking.
  const watermarkOn = getSetting('watermark_on', '1') === '1';
  const watermarkDataUri = watermarkOn
    ? buildWatermarkDataUri(`${req.user.display_name}  ·  @${req.user.username}`)
    : null;

  noStore(res);
  return res.render('drafts/show', {
    title: draft.title,
    bodyClass: 'page-reader',
    pageCss: ['/css/drafts.css', '/css/reader.css'],
    pageJs,
    draft,
    mode,
    kindLabel: KIND_LABEL[draft.kind] || draft.kind,
    sections,
    pageSizes,
    commentCounts: counts,
    threadId: thread ? thread.id : null,
    thread: thread || null,
    posts,
    canPost: !!thread && (!thread.is_locked || isLeader(req.user)),
    firstPageHtml,
    canManage: canManageDraft(req.user, draft),
    watermarkOn,
    watermarkDataUri,
  });
});

/* ---------------- status poll ---------------- */

router.get('/drafts/:id/status', requireMember, (req, res, next) => {
  const row = q.status().get(Number(req.params.id));
  noStore(res);
  if (!row) return fail(res, next, 'json', 404, 'That draft is not here.');
  return res.json({
    ok: true,
    status: row.status,
    page_count: row.page_count,
    error_msg: row.error_msg || null,
  });
});

/* ---------------- html page fragment ---------------- */

router.get('/drafts/:id/page/:n', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'bytes');
  if (!draft) return undefined;
  noStore(res);

  if (draft.status !== 'ready') return fail(res, next, 'bytes', 409, 'That draft is still being converted.');

  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) return fail(res, next, 'bytes', 404, 'No such page.');

  const page = q.page().get(draft.id, n);
  if (!page || page.kind !== 'html') return fail(res, next, 'bytes', 404, 'No such page.');

  res.type('text/html; charset=utf-8');
  return res.send(page.content_html || '');
});

/* ---------------- pdf stream (the only route that touches an original) ------ */

router.get('/drafts/:id/file.pdf', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'bytes');
  if (!draft) return undefined;
  noStore(res);

  if (draft.kind !== 'pdf') return fail(res, next, 'bytes', 404, 'That draft is not a PDF.');
  if (draft.status !== 'ready') return fail(res, next, 'bytes', 409, 'That draft is still being converted.');

  const file = resolveInDraft(draft.id, draft.original_path || 'original.pdf');
  if (!file) return fail(res, next, 'bytes', 404, 'That file is missing.');

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return fail(res, next, 'bytes', 404, 'That file is missing.');
  }

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="draft.pdf"');
  res.set('Accept-Ranges', 'bytes');

  const range = req.get('range');
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match) {
    const size = stat.size;
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);

    if (start === null && end === null) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    if (start === null) {
      // suffix range: last N bytes
      start = Math.max(0, size - end);
      end = size - 1;
    } else if (end === null || end >= size) {
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    res.set('Content-Length', String(end - start + 1));
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.set('Content-Length', String(stat.size));
  return fs.createReadStream(file).pipe(res);
});

/* ---------------- page image stream ---------------- */

router.get('/drafts/:id/img/:n', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'bytes');
  if (!draft) return undefined;
  noStore(res);

  if (draft.kind !== 'images') return fail(res, next, 'bytes', 404, 'That draft has no page images.');

  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) return fail(res, next, 'bytes', 404, 'No such page.');

  const page = q.page().get(draft.id, n);
  if (!page || page.kind !== 'image' || !page.file_path) {
    return fail(res, next, 'bytes', 404, 'No such page.');
  }

  const file = resolveInDraft(draft.id, page.file_path);
  if (!file || !fs.existsSync(file)) return fail(res, next, 'bytes', 404, 'That page image is missing.');

  res.set('Content-Type', IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.set('Content-Disposition', 'inline');
  return fs.createReadStream(file).pipe(res);
});

/* ---------------- comments ---------------- */

router.get('/drafts/:id/comments', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'json');
  if (!draft) return undefined;
  noStore(res);

  const all = req.query.all === '1' || req.query.all === 'true';
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = all ? q.topLevelAll().all(draft.id) : q.topLevelForPage().all(draft.id, page);
  // One statement for every reply on the draft; buildThreads keeps only the
  // ones whose parent is in `rows`.
  const replies = q.repliesForDraft().all(draft.id);
  const counts = countsFor(draft.id);

  return res.json({
    ok: true,
    all,
    page: all ? null : page,
    counts,
    total: Object.values(counts).reduce((sum, c) => sum + c.total, 0),
    open: Object.values(counts).reduce((sum, c) => sum + c.open, 0),
    threads: buildThreads(rows, replies, req.user, draft, all),
  });
});

router.post(
  '/drafts/:id/comments',
  requireMember,
  express.json({ limit: '64kb' }),
  (req, res, next) => {
    const wantsJson =
      req.is('application/json') || String(req.get('accept') || '').includes('application/json');
    const draft = loadDraft(req, res, next, wantsJson ? 'json' : 'html');
    if (!draft) return undefined;
    noStore(res);

    if (draft.status !== 'ready') {
      return fail(res, next, wantsJson ? 'json' : 'html', 409, 'That draft is still being converted.');
    }

    const mode = wantsJson ? 'json' : 'html';
    const body = req.body || {};

    /*
     * parent_id turns this from "start a thread" into "reply to one". Four
     * things have to hold, and all four are checked here rather than trusted
     * from the panel:
     *   · the parent exists and belongs to THIS draft (no cross-draft replies)
     *   · the parent has not been removed
     *   · the parent is itself top-level — replying to a reply is answered by
     *     attaching to the same thread, which the panel does by sending the
     *     thread's id; a parent_id that names a reply is a bug and is refused
     *   · the parent is not resolved. Replying to a settled thread BLOCKS with
     *     a "reopen it first" hint rather than silently reopening: reopening
     *     is a deliberate act by someone entitled to make it, and a reply
     *     should never quietly undo somebody else's sign-off.
     */
    let parent = null;
    const rawParent = body.parent_id;
    if (rawParent !== undefined && rawParent !== null && String(rawParent).trim() !== '') {
      const parentId = Number(rawParent);
      if (!Number.isInteger(parentId) || parentId <= 0) {
        return fail(res, next, mode, 400, 'That reply has no comment to attach to.');
      }
      parent = q.commentByIdAny().get(parentId);
      if (!parent || parent.draft_id !== draft.id) {
        return fail(res, next, mode, 404, 'That comment is not on this draft.');
      }
      if (parent.deleted_at) {
        return fail(res, next, mode, 400, 'That comment was removed — there is nothing to reply to.');
      }
      if (parent.parent_id !== null) {
        return fail(res, next, mode, 400, 'Replies attach to the comment that started the thread.');
      }
      if (parent.resolved_at) {
        return fail(res, next, mode, 409, 'That thread is resolved. Reopen it to reply.');
      }
    }

    // A reply inherits its parent's page so it can never drift off the note it
    // answers; a new thread anchors to whatever page the reader is showing.
    const pageNumber = parent
      ? parent.page_number
      : Math.max(1, Math.min(Number(body.page_number) || 1, draft.page_count || 1));
    const source = String(body.body || '').trim().slice(0, MAX_COMMENT_CHARS);

    if (!source) {
      return fail(res, next, mode, 400, 'Write something first.');
    }

    const html = mdToHtml(source);
    if (!toPlainText(html).trim()) {
      return fail(res, next, mode, 400, 'That comment came out empty.');
    }

    const id = Number(
      q
        .insertComment()
        .run(draft.id, pageNumber, parent ? parent.id : null, req.user.id, html, source)
        .lastInsertRowid
    );
    const row = q.commentById().get(id);
    row.author_name = req.user.display_name;

    if (wantsJson) {
      return res.status(201).json({
        ok: true,
        thread_id: parent ? parent.id : id,
        comment: parent ? replyJson(row, req.user) : threadJson(row, [], req.user, draft),
      });
    }
    flash(res, 'ok', parent ? 'Reply posted.' : 'Comment posted.');
    return res.redirect(`/drafts/${draft.id}#p=${pageNumber}`);
  }
);

/*
 * Resolve / reopen — a toggle, because "settled" is not a one-way door and the
 * same three people (uploader, leader, thread author) own both directions.
 */
router.post('/comments/:id/resolve', requireMember, (req, res, next) => {
  const wantsJson =
    req.is('application/json') ||
    String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(req.get('accept') || '').includes('application/json');
  const mode = wantsJson ? 'json' : 'html';

  const comment = q.commentById().get(Number(req.params.id));
  if (!comment) return fail(res, next, mode, 404, 'That comment is already gone.');
  if (comment.parent_id !== null) {
    return fail(res, next, mode, 400, 'Only the comment that starts a thread can be resolved.');
  }

  const draft = q.draft().get(comment.draft_id);
  if (!draft) return fail(res, next, mode, 404, 'That draft is not here.');

  if (!canResolveThread(req.user, draft, comment)) {
    return fail(
      res,
      next,
      mode,
      403,
      'Only the person who uploaded this draft, a leader, or whoever started the thread can resolve it.'
    );
  }

  if (comment.resolved_at) q.clearResolved().run(comment.id);
  else q.setResolved().run(req.user.id, comment.id);

  const now = q.resolvedRow().get(comment.id);
  noStore(res);

  if (wantsJson) {
    return res.json({
      ok: true,
      id: comment.id,
      resolved: !!now.resolved_at,
      resolved_by: now.resolved_at ? now.resolver_name || 'a member' : null,
    });
  }
  flash(res, 'ok', now.resolved_at ? 'Thread resolved.' : 'Thread reopened.');
  return res.redirect(`/drafts/${comment.draft_id}#p=${comment.page_number}`);
});

router.post('/comments/:id/delete', requireMember, (req, res, next) => {
  const wantsJson =
    req.is('application/json') ||
    String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(req.get('accept') || '').includes('application/json');

  const comment = q.commentById().get(Number(req.params.id));
  if (!comment) return fail(res, next, wantsJson ? 'json' : 'html', 404, 'That comment is already gone.');

  if (!(comment.user_id === req.user.id || isLeader(req.user))) {
    return fail(
      res,
      next,
      wantsJson ? 'json' : 'html',
      403,
      'Only the person who wrote a comment (or a leader) can remove it.'
    );
  }

  q.deleteComment().run(req.user.id, comment.id);
  noStore(res);

  if (wantsJson) return res.json({ ok: true, id: comment.id });
  flash(res, 'ok', 'Comment removed.');
  return res.redirect(`/drafts/${comment.draft_id}#p=${comment.page_number}`);
});

/* ---------------- the embedded conversation ----------------
 * Plain form posts, no fetch: the section is server-rendered by drafts/show.ejs
 * and every action lands back on /drafts/:id#conversation. The rows written
 * here are ordinary threads/posts rows, so /board/:threadId shows exactly the
 * same conversation and the board's own moderation still applies to it.
 */

const conversationTrim = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : '';
};

router.post('/drafts/:id/conversation', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'html');
  if (!draft) return undefined;

  const back = `/drafts/${draft.id}#conversation`;
  const thread = q.thread().get(draft.id);
  if (!thread) {
    flash(res, 'error', 'This draft has no conversation any more.');
    return res.redirect(back);
  }
  if (thread.is_locked && !isLeader(req.user)) {
    flash(res, 'error', 'This conversation is locked.');
    return res.redirect(back);
  }

  const bodyMd = conversationTrim(req.body.body_md, MAX_POST_CHARS);
  if (!bodyMd) {
    flash(res, 'error', 'Write something before you post.');
    return res.redirect(back);
  }
  const bodyHtml = mdToHtml(bodyMd);
  if (!toPlainText(bodyHtml).trim()) {
    flash(res, 'error', 'Nothing survived the formatting filter — try plain text or simple markdown.');
    return res.redirect(back);
  }

  const postId = Number(
    q.insertPost().run(thread.id, req.user.id, bodyHtml, bodyMd).lastInsertRowid
  );
  q.touchThread().run(thread.id);
  return res.redirect(`/drafts/${draft.id}#conv-${postId}`);
});

router.post('/drafts/:id/conversation/:postId/delete', requireMember, (req, res, next) => {
  const draft = loadDraft(req, res, next, 'html');
  if (!draft) return undefined;

  const post = q.postById().get(Number(req.params.postId));
  const thread = q.thread().get(draft.id);
  if (!post || !thread || post.thread_id !== thread.id) {
    return fail(res, next, 'html', 404, 'That post is already gone.');
  }
  if (!(post.user_id === req.user.id || isLeader(req.user))) {
    return fail(res, next, 'html', 403, 'Only the person who wrote a post (or a leader) can remove it.');
  }

  q.deletePost().run(req.user.id, post.id);
  flash(res, 'info', 'Post removed.');
  return res.redirect(`/drafts/${draft.id}#conversation`);
});

module.exports = router;
