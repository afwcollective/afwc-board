'use strict';

/**
 * The locked in-browser reader and its auth-gated content streams (Phases 4–5):
 *   GET  /drafts/:id            reader shell (mode chosen by draft kind)
 *   GET  /drafts/:id/status     JSON status for the processing poll
 *   GET  /drafts/:id/page/:n    sanitized HTML fragment, no-store
 *   GET  /drafts/:id/file.pdf   inline PDF stream with Range support
 *   GET  /drafts/:id/img/:n     page image streamed through the session check
 *   GET  /drafts/:id/comments   JSON, ?page=N or ?all=1
 *   POST /drafts/:id/comments   JSON or form; one comment anchored to a page
 *   POST /comments/:id/delete   author-or-leader soft delete
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
  thread: () =>
    db.prepare(
      `SELECT id FROM threads WHERE draft_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`
    ),
  commentsForPage: () =>
    db.prepare(
      `SELECT c.id, c.page_number, c.body_html, c.created_at, c.user_id,
              u.display_name AS author_name
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.draft_id = ? AND c.page_number = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC, c.id ASC`
    ),
  commentsAll: () =>
    db.prepare(
      `SELECT c.id, c.page_number, c.body_html, c.created_at, c.user_id,
              u.display_name AS author_name
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.draft_id = ? AND c.deleted_at IS NULL
        ORDER BY c.page_number ASC, c.created_at ASC, c.id ASC`
    ),
  commentCounts: () =>
    db.prepare(
      `SELECT page_number, COUNT(*) AS n FROM comments
        WHERE draft_id = ? AND deleted_at IS NULL GROUP BY page_number`
    ),
  insertComment: () =>
    db.prepare(
      `INSERT INTO comments (draft_id, page_number, user_id, body_html, body_md)
       VALUES (?, ?, ?, ?, ?)`
    ),
  commentById: () =>
    db.prepare('SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL'),
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

function commentJson(row, user) {
  return {
    id: row.id,
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
  const thread = q.thread().get(draft.id);
  const sections = draft.status === 'ready' && mode === 'html' ? q.sections().all(draft.id) : [];
  const pageSizes = draft.status === 'ready' && mode !== 'html' ? q.pageSizes().all(draft.id) : [];
  const counts = {};
  for (const row of q.commentCounts().all(draft.id)) counts[row.page_number] = row.n;

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
  const rows = all
    ? q.commentsAll().all(draft.id)
    : q.commentsForPage().all(draft.id, Math.max(1, Number(req.query.page) || 1));

  const counts = {};
  for (const row of q.commentCounts().all(draft.id)) counts[row.page_number] = row.n;

  return res.json({
    ok: true,
    all,
    page: all ? null : Math.max(1, Number(req.query.page) || 1),
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    comments: rows.map((row) => commentJson(row, req.user)),
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

    const body = req.body || {};
    const pageNumber = Math.max(1, Math.min(Number(body.page_number) || 1, draft.page_count || 1));
    const source = String(body.body || '').trim().slice(0, MAX_COMMENT_CHARS);

    if (!source) {
      return fail(res, next, wantsJson ? 'json' : 'html', 400, 'Write something first.');
    }

    const html = mdToHtml(source);
    if (!toPlainText(html).trim()) {
      return fail(res, next, wantsJson ? 'json' : 'html', 400, 'That comment came out empty.');
    }

    const id = Number(q.insertComment().run(draft.id, pageNumber, req.user.id, html, source).lastInsertRowid);
    const row = q.commentById().get(id);
    row.author_name = req.user.display_name;

    if (wantsJson) {
      return res.status(201).json({ ok: true, comment: commentJson(row, req.user) });
    }
    flash(res, 'ok', 'Comment posted.');
    return res.redirect(`/drafts/${draft.id}#p=${pageNumber}`);
  }
);

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

module.exports = router;
