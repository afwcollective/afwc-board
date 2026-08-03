'use strict';

/**
 * General discussion board (Phase 3).
 * Mounted at /board by src/app.js — add routes here, not there.
 *
 * Threads with draft_id IS NULL are "general board" threads and are the only
 * ones listed at GET /board. Threads with draft_id IS NOT NULL are per-draft
 * discussion threads created by the drafts feature (Phase 4) — GET /board/:id
 * still renders them (with a link back to the draft) but they never show up
 * in the index.
 *
 * Queries here are route-local by design (see src/models.js header) since
 * nothing outside this router needs threads/posts.
 */

const express = require('express');
const { db } = require('../db');
const { requireMember } = require('../auth/middleware');
const { mdToHtml, toPlainText } = require('../util/sanitize');
const { flash } = require('../util/flash');

const router = express.Router();

router.use(requireMember);

/* ---------------------------------------------------------- query helpers */

const threadById = (id) =>
  db
    .prepare(
      `SELECT t.*, u.display_name AS author_name
         FROM threads t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.id = ? AND t.deleted_at IS NULL`
    )
    .get(id);

const draftTitleById = (id) =>
  id ? db.prepare('SELECT id, title FROM drafts WHERE id = ? AND deleted_at IS NULL').get(id) : null;

const postsForThread = (threadId) =>
  db
    .prepare(
      `SELECT p.*, u.display_name AS author_name
         FROM posts p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.thread_id = ?
        ORDER BY p.created_at ASC, p.id ASC`
    )
    .all(threadId);

const insertThread = db.prepare(
  `INSERT INTO threads (title, user_id, draft_id, last_post_at)
   VALUES (@title, @user_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
);
const insertPost = db.prepare(
  `INSERT INTO posts (thread_id, user_id, body_html, body_md)
   VALUES (@thread_id, @user_id, @body_html, @body_md)`
);
const touchThreadActivity = db.prepare(
  `UPDATE threads SET last_post_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
);

const createThreadWithPost = db.transaction((title, body_md, body_html, userId) => {
  const { lastInsertRowid: threadId } = insertThread.run({ title, user_id: userId });
  const { lastInsertRowid: postId } = insertPost.run({
    thread_id: threadId,
    user_id: userId,
    body_html,
    body_md,
  });
  return { threadId, postId };
});

const trim = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : '';
};

const canModerate = (req, authorId) =>
  req.user.role === 'leader' || req.user.id === authorId;

/* -------------------------------------------------------------------- /board */

router.get('/', (req, res) => {
  const threads = db
    .prepare(
      `SELECT t.*, u.display_name AS author_name,
              (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.deleted_at IS NULL) AS reply_count
         FROM threads t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.draft_id IS NULL AND t.deleted_at IS NULL
        ORDER BY t.last_post_at DESC`
    )
    .all();

  res.render('board/index', {
    title: 'Board',
    pageCss: ['/css/board.css'],
    threads,
  });
});

router.get('/new', (req, res) => {
  res.render('board/new', {
    title: 'New thread',
    pageCss: ['/css/board.css'],
    values: { title: '', body_md: '' },
    errors: [],
  });
});

router.post('/', (req, res) => {
  const title = trim(req.body.title, 200);
  const body_md = trim(req.body.body_md, 20000);
  const errors = [];
  if (!title) errors.push('Give the thread a title.');
  if (title.length > 200) errors.push('Titles are 200 characters or fewer.');
  if (!body_md) errors.push('Write something to start the conversation.');

  const body_html = body_md ? mdToHtml(body_md) : '';
  if (body_md && !toPlainText(body_html)) {
    errors.push('Nothing survived the formatting filter — try plain text or simple markdown.');
  }

  if (errors.length) {
    return res.status(400).render('board/new', {
      title: 'New thread',
      pageCss: ['/css/board.css'],
      values: { title, body_md },
      errors,
    });
  }

  const { threadId } = createThreadWithPost(title, body_md, body_html, req.user.id);
  flash(res, 'ok', 'Thread started.');
  return res.redirect(`/board/${threadId}`);
});

/* ------------------------------------------------------------- /board/:id */

router.get('/:id', (req, res, next) => {
  const thread = threadById(req.params.id);
  if (!thread) return next();

  const posts = postsForThread(thread.id);
  const draft = thread.draft_id ? draftTitleById(thread.draft_id) : null;

  res.render('board/thread', {
    title: thread.title,
    pageCss: ['/css/board.css'],
    thread,
    posts,
    draft,
  });
});

router.post('/:id/reply', (req, res, next) => {
  const thread = threadById(req.params.id);
  if (!thread) return next();

  const isLeader = req.user.role === 'leader';
  if (thread.is_locked && !isLeader) {
    flash(res, 'error', 'This thread is locked.');
    return res.redirect(`/board/${thread.id}`);
  }

  const body_md = trim(req.body.body_md, 20000);
  if (!body_md) {
    flash(res, 'error', 'Write something before you post.');
    return res.redirect(`/board/${thread.id}`);
  }
  const body_html = mdToHtml(body_md);
  if (!toPlainText(body_html)) {
    flash(res, 'error', 'Nothing survived the formatting filter — try plain text or simple markdown.');
    return res.redirect(`/board/${thread.id}`);
  }

  const { lastInsertRowid: postId } = insertPost.run({
    thread_id: thread.id,
    user_id: req.user.id,
    body_html,
    body_md,
  });
  touchThreadActivity.run(thread.id);

  return res.redirect(`/board/${thread.id}#post-${postId}`);
});

router.post('/:id/delete', (req, res, next) => {
  const thread = threadById(req.params.id);
  if (!thread) return next();

  if (!canModerate(req, thread.user_id)) {
    const err = new Error('Only the thread author or a leader can remove this thread.');
    err.status = 403;
    return next(err);
  }

  db.prepare(`UPDATE threads SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`).run(
    req.user.id,
    thread.id
  );
  flash(res, 'info', 'Thread removed.');
  return res.redirect(thread.draft_id ? `/drafts/${thread.draft_id}` : '/board');
});

router.post('/:id/lock', (req, res, next) => {
  const thread = threadById(req.params.id);
  if (!thread) return next();

  if (req.user.role !== 'leader') {
    const err = new Error('Leaders only.');
    err.status = 403;
    return next(err);
  }

  const nextLocked = thread.is_locked ? 0 : 1;
  db.prepare('UPDATE threads SET is_locked = ? WHERE id = ?').run(nextLocked, thread.id);
  flash(res, 'info', nextLocked ? 'Thread locked.' : 'Thread unlocked.');
  return res.redirect(`/board/${thread.id}`);
});

/* -------------------------------------------------------------- posts */

/*
 * The plan names this route `POST /posts/:id/delete`. This router is only
 * ever mounted at /board (src/app.js — off limits), so a truly top-level
 * path isn't reachable from here; it lives at /board/posts/:id/delete
 * instead. Every view links to it at that address.
 */
router.post('/posts/:id/delete', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!post) return next();

  if (!canModerate(req, post.user_id)) {
    const err = new Error('Only the post author or a leader can remove this post.');
    err.status = 403;
    return next(err);
  }

  db.prepare(`UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`).run(
    req.user.id,
    post.id
  );
  flash(res, 'info', 'Post removed.');
  return res.redirect(`/board/${post.thread_id}#post-${post.id}`);
});

module.exports = router;
