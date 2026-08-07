/**
 * Port of src/routes/board.js — the general discussion board.
 *
 * Route for route, guard for guard, message for message. Threads with
 * draft_id IS NULL are "general board" threads and the only ones GET /board
 * lists; a thread with a draft_id is a per-draft discussion created by the
 * drafts feature (P4) and still renders here, with the notice linking back to
 * the draft. Queries stay route-local for the same reason they do in the
 * Express file — nothing outside this router touches threads/posts.
 *
 * TWO THINGS CHANGED IN THE MOVE, both forced by D1:
 *
 *  1. THREAD + POST ATOMICITY. src/routes/board.js wrapped the two inserts in
 *     db.transaction() and read lastInsertRowid between them. D1 has no
 *     interactive transaction, so the pair is restructured into ONE db.batch
 *     — which D1 runs as a single atomic unit — with the post naming its
 *     parent through SQLite's last_insert_rowid(). The batch executes its
 *     statements in order on one connection, so last_insert_rowid() inside
 *     statement 2 is the id statement 1 just wrote, and the new thread id
 *     comes back out of results[0].meta.last_row_id for the redirect. No
 *     window exists in which a titled thread has no first post; a failure
 *     rolls both back. (PORT-CLOUDFLARE.md §3 allowed "write thread first,
 *     narrow window accepted" as the fallback — it is not needed.)
 *
 *  2. `return next()` for a missing thread becomes `return notFound(c)`. The
 *     Express router leaned on the app-level 404 handler; the Hono router
 *     calls the same renderer directly, so the page is identical.
 *
 * The lock/unlock guard is isLeaderUser() from worker/src/auth/roles.js —
 * "leader OR architect", which is the fix commit ba21377 made on the Express
 * side after an earlier version compared role === 'leader' and locked the
 * architect out of the button their own view rendered. Anything here that asks
 * "is this person a leader" must go through that helper.
 */

import { Hono } from 'hono';

import { one, all, run, stmt } from '../db.js';
import { requireMember, HttpError } from '../auth/middleware.js';
import { isLeaderUser } from '../auth/roles.js';
import { mdToHtml, toPlainText } from '../util/sanitize.js';
import { flash } from '../util/flash.js';
import { getBody } from '../util/body.js';
import { render } from '../render.js';
import { notFound } from './errors.js';

const router = new Hono();

router.use('*', requireMember);

/* ---------------------------------------------------------- query helpers */

const threadById = (db, id) =>
  one(
    db,
    `SELECT t.*, u.display_name AS author_name
       FROM threads t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.id = ? AND t.deleted_at IS NULL`,
    id
  );

const draftTitleById = (db, id) =>
  id ? one(db, 'SELECT id, title FROM drafts WHERE id = ? AND deleted_at IS NULL', id) : null;

const postsForThread = (db, threadId) =>
  all(
    db,
    `SELECT p.*, u.display_name AS author_name
       FROM posts p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.thread_id = ?
      ORDER BY p.created_at ASC, p.id ASC`,
    threadId
  );

const insertPost = (db, { thread_id, user_id, body_html, body_md }) =>
  run(
    db,
    `INSERT INTO posts (thread_id, user_id, body_html, body_md)
     VALUES (?, ?, ?, ?)`,
    thread_id,
    user_id,
    body_html,
    body_md
  );

const touchThreadActivity = (db, id) =>
  run(db, `UPDATE threads SET last_post_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, id);

/**
 * The transaction, as a batch. See note 1 in the file header for why
 * last_insert_rowid() is the right tool and not a race.
 */
async function createThreadWithPost(db, title, body_md, body_html, userId) {
  const results = await db.batch([
    stmt(
      db,
      `INSERT INTO threads (title, user_id, draft_id, last_post_at)
       VALUES (?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      title,
      userId
    ),
    stmt(
      db,
      `INSERT INTO posts (thread_id, user_id, body_html, body_md)
       VALUES (last_insert_rowid(), ?, ?, ?)`,
      userId,
      body_html,
      body_md
    ),
  ]);
  return {
    threadId: Number(results[0].meta.last_row_id),
    postId: Number(results[1].meta.last_row_id),
  };
}

const trim = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : '';
};

const canModerate = (user, authorId) => isLeaderUser(user) || user.id === authorId;

/* -------------------------------------------------------------------- /board */

router.get('/', async (c) => {
  const threads = await all(
    c.env.DB,
    `SELECT t.*, u.display_name AS author_name,
            (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.deleted_at IS NULL) AS reply_count
       FROM threads t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.draft_id IS NULL AND t.deleted_at IS NULL
      ORDER BY t.last_post_at DESC`
  );

  return render(c, 'board/index', {
    title: 'Board',
    pageCss: ['/css/board.css'],
    threads,
  });
});

router.get('/new', (c) =>
  render(c, 'board/new', {
    title: 'New thread',
    pageCss: ['/css/board.css'],
    values: { title: '', body_md: '' },
    errors: [],
  })
);

router.post('/', async (c) => {
  // checkCsrf already parsed and cached this body — getBody() hands back the
  // same object rather than touching a stream that can only be read once.
  const body = await getBody(c);
  const title = trim(body.title, 200);
  const body_md = trim(body.body_md, 20000);
  const errors = [];
  if (!title) errors.push('Give the thread a title.');
  if (title.length > 200) errors.push('Titles are 200 characters or fewer.');
  if (!body_md) errors.push('Write something to start the conversation.');

  const body_html = body_md ? mdToHtml(body_md) : '';
  if (body_md && !toPlainText(body_html)) {
    errors.push('Nothing survived the formatting filter — try plain text or simple markdown.');
  }

  if (errors.length) {
    return render(
      c,
      'board/new',
      {
        title: 'New thread',
        pageCss: ['/css/board.css'],
        values: { title, body_md },
        errors,
      },
      400
    );
  }

  const { threadId } = await createThreadWithPost(
    c.env.DB,
    title,
    body_md,
    body_html,
    c.get('currentUser').id
  );
  flash(c, 'ok', 'Thread started.');
  return c.redirect(`/board/${threadId}`, 302);
});

/* ------------------------------------------------------------- /board/:id */

router.get('/:id', async (c) => {
  const db = c.env.DB;
  const thread = await threadById(db, c.req.param('id'));
  if (!thread) return notFound(c);

  const [posts, draft] = await Promise.all([
    postsForThread(db, thread.id),
    thread.draft_id ? draftTitleById(db, thread.draft_id) : null,
  ]);

  return render(c, 'board/thread', {
    title: thread.title,
    pageCss: ['/css/board.css'],
    thread,
    posts,
    draft,
  });
});

router.post('/:id/reply', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const thread = await threadById(db, c.req.param('id'));
  if (!thread) return notFound(c);

  if (thread.is_locked && !isLeaderUser(user)) {
    flash(c, 'error', 'This thread is locked.');
    return c.redirect(`/board/${thread.id}`, 302);
  }

  const body = await getBody(c);
  const body_md = trim(body.body_md, 20000);
  if (!body_md) {
    flash(c, 'error', 'Write something before you post.');
    return c.redirect(`/board/${thread.id}`, 302);
  }
  const body_html = mdToHtml(body_md);
  if (!toPlainText(body_html)) {
    flash(c, 'error', 'Nothing survived the formatting filter — try plain text or simple markdown.');
    return c.redirect(`/board/${thread.id}`, 302);
  }

  const meta = await insertPost(db, {
    thread_id: thread.id,
    user_id: user.id,
    body_html,
    body_md,
  });
  await touchThreadActivity(db, thread.id);

  return c.redirect(`/board/${thread.id}#post-${Number(meta.last_row_id)}`, 302);
});

router.post('/:id/delete', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const thread = await threadById(db, c.req.param('id'));
  if (!thread) return notFound(c);

  if (!canModerate(user, thread.user_id)) {
    throw new HttpError(403, 'Only the thread author or a leader can remove this thread.');
  }

  await run(
    db,
    `UPDATE threads SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`,
    user.id,
    thread.id
  );
  flash(c, 'info', 'Thread removed.');
  return c.redirect(thread.draft_id ? `/drafts/${thread.draft_id}` : '/board', 302);
});

router.post('/:id/lock', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const thread = await threadById(db, c.req.param('id'));
  if (!thread) return notFound(c);

  // isLeaderUser, not role === 'leader' — the architect is a leader with more.
  if (!isLeaderUser(user)) throw new HttpError(403, 'Leaders only.');

  const nextLocked = thread.is_locked ? 0 : 1;
  await run(db, 'UPDATE threads SET is_locked = ? WHERE id = ?', nextLocked, thread.id);
  flash(c, 'info', nextLocked ? 'Thread locked.' : 'Thread unlocked.');
  return c.redirect(`/board/${thread.id}`, 302);
});

/* -------------------------------------------------------------- posts */

/*
 * The plan names this route `POST /posts/:id/delete`. This router is only
 * ever mounted at /board (worker/src/index.js), so a truly top-level path
 * isn't reachable from here; it lives at /board/posts/:id/delete instead —
 * the same address views/board/thread.ejs links to on both apps.
 *
 * Three path segments against two for /:id/delete, so the two never collide
 * no matter which order Hono tries them in.
 */
router.post('/posts/:id/delete', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const post = await one(
    db,
    'SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL',
    c.req.param('id')
  );
  if (!post) return notFound(c);

  if (!canModerate(user, post.user_id)) {
    throw new HttpError(403, 'Only the post author or a leader can remove this post.');
  }

  await run(
    db,
    `UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`,
    user.id,
    post.id
  );
  flash(c, 'info', 'Post removed.');
  return c.redirect(`/board/${post.thread_id}#post-${post.id}`, 302);
});

export default router;
