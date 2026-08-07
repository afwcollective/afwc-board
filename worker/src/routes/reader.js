/**
 * Port of src/routes/reader.js — the locked in-browser reader and its
 * auth-gated content streams:
 *
 *   GET  /drafts/:id            reader shell (mode chosen by draft kind)
 *   GET  /drafts/:id/status     JSON status for the processing poll
 *   GET  /drafts/:id/page/:n    sanitized HTML fragment, no-store
 *   GET  /drafts/:id/file.pdf   inline PDF stream with Range support (R2 ranges)
 *   GET  /drafts/:id/img/:n     page image streamed through the session check
 *   GET  /drafts/:id/comments   JSON threads, ?page=N or ?all=1
 *   POST /drafts/:id/comments   JSON; starts a thread, or replies to one
 *   POST /comments/:id/resolve  uploader / leader / thread author toggle
 *   POST /comments/:id/delete   author-or-leader soft delete
 *   POST /drafts/:id/conversation             a post in the draft's board thread
 *   POST /drafts/:id/conversation/:pid/delete author-or-leader soft delete
 *
 * Mounted at / by worker/src/index.js AFTER the /drafts router, which is the
 * same order src/app.js used and the reason both files can own /drafts/* paths
 * without importing each other. Hono merges a sub-app's routes into the parent
 * router, so /drafts/:id/pages (drafts.js) and /drafts/:id/page/:n (here) simply
 * coexist; nothing shadows anything.
 *
 * Every byte of draft content leaves through this file, and every route here is
 * requireMember + not-deleted + `Cache-Control: private, no-store`. The R2
 * bucket has no public hostname (worker/src/services/drafts/attachments.js rule
 * 2), so a shared URL is dead the moment it leaves a session.
 *
 * ============================================================ WHAT CHANGED ===
 *
 * 1. RANGE REQUESTS. The Express version did fs.statSync + fs.createReadStream
 *    ({start, end}). Here it is R2: head() for the size, then get() with
 *    `{ range: { offset, length } }`, which is PORT-CLOUDFLARE.md §4's "Range
 *    requests for the PDF reader use R2 range reads". The PARSING is untouched
 *    — same regex, same suffix-range handling, same two 416 branches with
 *    `Content-Range: bytes * /size` — because pdf.js is the client and its
 *    expectations are not negotiable.
 *
 * 2. THE ERROR SHAPES ARE THE CONTRACT. fail() keeps its three modes: 'html'
 *    renders the error page, 'json' answers { ok:false, error }, 'bytes' sends
 *    a bare text status so a stream never leaks a rendered page into a <canvas>
 *    or an <img>. public/js/comments.js reads the `error` field verbatim and
 *    shows it to the member, so every message here is user-facing copy.
 *
 * 3. NOTHING ELSE. The permission rules (canResolveThread's three people), the
 *    404-vs-403 split, the four parent_id checks, the "resolved threads refuse
 *    replies rather than silently reopening" rule and the removed-starter
 *    rendering are ported line for line. This file and its Express twin answer
 *    the same JSON to the same shared public/js/comments.js.
 */

import { Hono } from 'hono';

import { one, all, run, stmt, getSetting } from '../db.js';
import { requireMember, HttpError } from '../auth/middleware.js';
import { isLeaderUser } from '../auth/roles.js';
import { flash } from '../util/flash.js';
import { mdToHtml, toPlainText } from '../util/sanitize.js';
import { getBody, field } from '../util/body.js';
import { buildWatermarkDataUri } from '../util/watermark.js';
import * as dates from '../util/dates.js';
import { render } from '../render.js';
import * as files from '../services/drafts/attachments.js';

const router = new Hono();

/*
 * SCOPED, NOT WILDCARD — and this is the one place in the port where that
 * distinction bites.
 *
 * Every other router here is mounted under its own prefix, so `use('*', …)`
 * inside it means "everything I own". This one is mounted at '/' (see the file
 * header), so `use('*', …)` would mean "every request the app ever receives" —
 * and because Hono composes middleware for any matching path, a request for a
 * path NO router handles would run requireMember and get redirected to /login
 * instead of reaching app.notFound(). A logged-out visitor mistyping a URL
 * would be asked to sign in rather than shown the 404 page, which is neither
 * what Express does nor what we want to tell them.
 *
 * So the guard is attached to exactly the three prefixes this file owns. It
 * still fronts every route below — /drafts/:id and everything under it,
 * /comments/:id/*, and the /reader signpost.
 */
router.use('/reader', requireMember);
router.use('/drafts/*', requireMember);
router.use('/comments/*', requireMember);

/** The reader mode each draft kind is rendered with. */
const READER_MODE = { docx: 'html', text: 'html', pdf: 'pdf', images: 'images' };

const MAX_COMMENT_CHARS = 4000;
const MAX_POST_CHARS = 20000;

/** express.json({ limit: '64kb' }) on POST /drafts/:id/comments. */
const MAX_JSON_BYTES = 64 * 1024;

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

/* ---------------- shared helpers ---------------- */

const q = {
  draft: (db, id) =>
    one(
      db,
      `SELECT d.*, u.display_name AS uploader_name, u.username AS uploader_username
         FROM drafts d JOIN users u ON u.id = d.user_id
        WHERE d.id = ? AND d.deleted_at IS NULL`,
      id
    ),
  status: (db, id) =>
    one(db, 'SELECT status, page_count, error_msg FROM drafts WHERE id = ? AND deleted_at IS NULL', id),
  page: (db, id, n) =>
    one(db, 'SELECT * FROM draft_pages WHERE draft_id = ? AND page_number = ?', id, n),
  sections: (db, id) =>
    all(
      db,
      `SELECT page_number, heading FROM draft_pages
        WHERE draft_id = ? AND heading IS NOT NULL AND heading <> ''
        ORDER BY page_number`,
      id
    ),
  pageSizes: (db, id) =>
    all(
      db,
      'SELECT page_number, width, height FROM draft_pages WHERE draft_id = ? ORDER BY page_number',
      id
    ),

  /* -- the draft's general discussion thread, embedded in the reader -- */
  thread: (db, draftId) =>
    one(
      db,
      `SELECT t.id, t.title, t.is_locked, t.user_id, u.display_name AS author_name
         FROM threads t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.draft_id = ? AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1`,
      draftId
    ),
  threadPosts: (db, threadId) =>
    all(
      db,
      `SELECT p.id, p.user_id, p.body_html, p.created_at,
              u.display_name AS author_name
         FROM posts p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.thread_id = ? AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC, p.id ASC`,
      threadId
    ),
  postById: (db, id) => one(db, 'SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL', id),

  /* -- threaded page comments --
   * The TOP-LEVEL queries deliberately include soft-deleted rows: a removed
   * comment whose replies survived still has to render as "Comment removed"
   * so the thread underneath it stays readable. buildThreads() drops the ones
   * with nothing left under them. The REPLY query never returns deleted rows —
   * removing a reply removes just that line.
   */
  topLevelForPage: (db, draftId, page) =>
    all(
      db,
      `SELECT c.id, c.page_number, c.body_html, c.created_at, c.user_id, c.deleted_at,
              c.resolved_at, c.resolved_by,
              u.display_name AS author_name, r.display_name AS resolver_name
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users r ON r.id = c.resolved_by
        WHERE c.draft_id = ? AND c.page_number = ? AND c.parent_id IS NULL
        ORDER BY c.created_at ASC, c.id ASC`,
      draftId,
      page
    ),
  topLevelAll: (db, draftId) =>
    all(
      db,
      `SELECT c.id, c.page_number, c.body_html, c.created_at, c.user_id, c.deleted_at,
              c.resolved_at, c.resolved_by,
              u.display_name AS author_name, r.display_name AS resolver_name
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users r ON r.id = c.resolved_by
        WHERE c.draft_id = ? AND c.parent_id IS NULL
        ORDER BY c.page_number ASC, c.created_at ASC, c.id ASC`,
      draftId
    ),
  repliesForDraft: (db, draftId) =>
    all(
      db,
      `SELECT c.id, c.parent_id, c.page_number, c.body_html, c.created_at, c.user_id,
              u.display_name AS author_name
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.draft_id = ? AND c.parent_id IS NOT NULL AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC, c.id ASC`,
      draftId
    ),
  /**
   * Per page: `total` = every visible comment (thread starters + replies);
   * `open` = unresolved, undeleted threads — what the pager badge counts.
   * A removed-but-still-rendered thread starter is in neither number: there is
   * nothing left on it to act on, and its surviving replies are counted.
   */
  commentCounts: (db, draftId) =>
    all(
      db,
      `SELECT page_number,
              COUNT(*) AS total,
              SUM(CASE WHEN parent_id IS NULL AND resolved_at IS NULL THEN 1 ELSE 0 END) AS open
         FROM comments
        WHERE draft_id = ? AND deleted_at IS NULL
        GROUP BY page_number`,
      draftId
    ),
  commentById: (db, id) => one(db, 'SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL', id),
  /** Includes soft-deleted rows — parent validation has to see them to refuse them. */
  commentByIdAny: (db, id) => one(db, 'SELECT * FROM comments WHERE id = ?', id),
  resolvedRow: (db, id) =>
    one(
      db,
      `SELECT c.resolved_at, r.display_name AS resolver_name
         FROM comments c LEFT JOIN users r ON r.id = c.resolved_by WHERE c.id = ?`,
      id
    ),
};

/**
 * The port of fail(res, next, mode, …). 'html' throws so the app-level error
 * page renders it, 'json' and 'bytes' return a Response the caller hands back.
 */
function fail(c, mode, status, message) {
  if (mode === 'json') return c.json({ ok: false, error: message }, status, NO_STORE);
  if (mode === 'bytes') return c.text(message, status, NO_STORE);
  throw new HttpError(status, message);
}

/**
 * Loads the draft named by :id, or returns the failure Response. `mode` picks
 * the failure shape exactly as it did on Express.
 */
async function loadDraft(c, mode = 'html') {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: fail(c, mode, 404, 'That draft is not here.') };
  }
  const draft = await q.draft(c.env.DB, id);
  if (!draft) {
    return { error: fail(c, mode, 404, 'That draft is not here — it may have been removed.') };
  }
  return { draft };
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
function buildThreads(rows, replyRows, user, draft, allPages) {
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
    allPages
      ? a.page_number - b.page_number || Number(a.resolved) - Number(b.resolved)
      : Number(a.resolved) - Number(b.resolved)
  );
  return threads;
}

/** { "2": { total, open } } for the tab badge and the per-page pager dot. */
async function countsFor(db, draftId) {
  const counts = {};
  for (const row of await q.commentCounts(db, draftId)) {
    counts[row.page_number] = { total: row.total, open: row.open || 0 };
  }
  return counts;
}

/* ---------------- reader shell ---------------- */

// The Phase-3 placeholder lived at /reader; keep the URL alive as a signpost.
router.get('/reader', (c) => c.redirect('/drafts', 302));

router.get('/drafts/:id', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const got = await loadDraft(c, 'html');
  if (got.error) return got.error;
  const draft = got.draft;

  // A failed draft is only visible to the person who uploaded it and to leaders.
  if (draft.status === 'failed' && !canManageDraft(user, draft)) {
    return fail(c, 'html', 404, 'That draft is not here — it may have been removed.');
  }

  const mode = READER_MODE[draft.kind] || 'html';
  const ready = draft.status === 'ready';

  /*
   * The draft's general discussion — "THE CONVERSATION" — rendered right here
   * rather than linked out to /board/:id. It is a perfectly ordinary board
   * thread (created at upload by worker/src/routes/drafts.js, kept out of the
   * board index because it carries a draft_id), so /board/:id still renders the
   * same posts; the reader is simply a second, better-placed door onto it.
   *
   * If a leader has removed the thread there is nothing to embed and the whole
   * section disappears — a removed thread stays removed rather than springing
   * back to life the first time somebody types into the reader.
   */
  const [sections, pageSizes, counts, thread, firstPage, watermarkSetting] = await Promise.all([
    ready && mode === 'html' ? q.sections(db, draft.id) : [],
    ready && mode !== 'html' ? q.pageSizes(db, draft.id) : [],
    countsFor(db, draft.id),
    q.thread(db, draft.id),
    ready && mode === 'html' ? q.page(db, draft.id, 1) : null,
    getSetting(db, 'watermark_on', '1'),
  ]);
  const posts = thread ? await q.threadPosts(db, thread.id) : [];

  const pageJs = ['/js/reader-core.js', '/js/comments.js'];
  if (ready) pageJs.push(`/js/reader-${mode}.js`);

  // Faint, tiled tag of the CURRENT VIEWER's name — see worker/src/util/watermark.js.
  // Built per-request (never cached) so it always reflects whoever is looking.
  const watermarkOn = watermarkSetting === '1';
  const watermarkDataUri = watermarkOn
    ? buildWatermarkDataUri(`${user.display_name}  ·  @${user.username}`)
    : null;

  for (const [name, value] of Object.entries(NO_STORE)) c.header(name, value);
  return render(c, 'drafts/show', {
    title: draft.title,
    bodyClass: 'page-reader',
    pageCss: ['/css/drafts.css', '/css/reader.css'],
    pageJs,
    draft,
    mode,
    kindLabel: files.KIND_LABEL[draft.kind] || draft.kind,
    sections,
    pageSizes,
    commentCounts: counts,
    threadId: thread ? thread.id : null,
    thread: thread || null,
    posts,
    canPost: !!thread && (!thread.is_locked || isLeader(user)),
    firstPageHtml: firstPage ? firstPage.content_html || '' : '',
    canManage: canManageDraft(user, draft),
    /*
     * The one local views/drafts/show.ejs takes that Express does not set. On
     * that stack "try converting again" re-runs ingest over the original still
     * on disk, and the template's own sentence is true. Here conversion happens
     * in the uploader's browser and the original is never handed back, so the
     * button means "upload it again" and the card has to say so. See the
     * template's comment for how the guard keeps Express byte-identical, and
     * worker/src/routes/drafts.js for the route the button actually reaches.
     */
    retryHint:
      'Conversion happens in your own browser on this site, so trying again means picking the file and uploading it once more. Nothing else about the draft was lost — its conversation is still here.',
    watermarkOn,
    watermarkDataUri,
  });
});

/* ---------------- status poll ---------------- */

router.get('/drafts/:id/status', async (c) => {
  const row = await q.status(c.env.DB, Number(c.req.param('id')));
  if (!row) return fail(c, 'json', 404, 'That draft is not here.');
  return c.json(
    {
      ok: true,
      status: row.status,
      page_count: row.page_count,
      error_msg: row.error_msg || null,
    },
    200,
    NO_STORE
  );
});

/* ---------------- html page fragment ---------------- */

router.get('/drafts/:id/page/:n', async (c) => {
  const got = await loadDraft(c, 'bytes');
  if (got.error) return got.error;
  const draft = got.draft;

  if (draft.status !== 'ready') return fail(c, 'bytes', 409, 'That draft is still being converted.');

  const n = Number(c.req.param('n'));
  if (!Number.isInteger(n) || n < 1) return fail(c, 'bytes', 404, 'No such page.');

  const page = await q.page(c.env.DB, draft.id, n);
  if (!page || page.kind !== 'html') return fail(c, 'bytes', 404, 'No such page.');

  return c.body(page.content_html || '', 200, {
    ...NO_STORE,
    'Content-Type': 'text/html; charset=utf-8',
  });
});

/* ---------------- pdf stream (the only route that touches an original) ------
 *
 * Range parsing is character-for-character the Express implementation; only the
 * two I/O calls changed. R2 gives the size from head() and the slice from
 * get(key, { range: { offset, length } }), so a 40 MB PDF never lands in the
 * isolate — pdf.js asks for a few tens of kilobytes at a time and each one is a
 * separate ranged read.
 */

router.get('/drafts/:id/file.pdf', async (c) => {
  const got = await loadDraft(c, 'bytes');
  if (got.error) return got.error;
  const draft = got.draft;

  if (draft.kind !== 'pdf') return fail(c, 'bytes', 404, 'That draft is not a PDF.');
  if (draft.status !== 'ready') return fail(c, 'bytes', 409, 'That draft is still being converted.');

  const rel = draft.original_path || 'original.pdf';
  const meta = await files.head(c.env, draft.id, rel);
  if (!meta) return fail(c, 'bytes', 404, 'That file is missing.');

  const size = meta.size;
  const base = {
    ...NO_STORE,
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="draft.pdf"',
    'Accept-Ranges': 'bytes',
  };

  const range = c.req.header('range');
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match) {
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);

    if (start === null && end === null) {
      return c.body(null, 416, { ...base, 'Content-Range': `bytes */${size}` });
    }
    if (start === null) {
      // suffix range: last N bytes
      start = Math.max(0, size - end);
      end = size - 1;
    } else if (end === null || end >= size) {
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return c.body(null, 416, { ...base, 'Content-Range': `bytes */${size}` });
    }

    const length = end - start + 1;
    const slice = await files.get(c.env, draft.id, rel, { range: { offset: start, length } });
    if (!slice) return fail(c, 'bytes', 404, 'That file is missing.');
    return c.body(slice.body, 206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(length),
    });
  }

  const object = await files.get(c.env, draft.id, rel);
  if (!object) return fail(c, 'bytes', 404, 'That file is missing.');
  return c.body(object.body, 200, { ...base, 'Content-Length': String(size) });
});

/* ---------------- page image stream ---------------- */

router.get('/drafts/:id/img/:n', async (c) => {
  const got = await loadDraft(c, 'bytes');
  if (got.error) return got.error;
  const draft = got.draft;

  if (draft.kind !== 'images') return fail(c, 'bytes', 404, 'That draft has no page images.');

  const n = Number(c.req.param('n'));
  if (!Number.isInteger(n) || n < 1) return fail(c, 'bytes', 404, 'No such page.');

  const page = await q.page(c.env.DB, draft.id, n);
  if (!page || page.kind !== 'image' || !page.file_path) {
    return fail(c, 'bytes', 404, 'No such page.');
  }

  const object = await files.get(c.env, draft.id, page.file_path);
  if (!object) return fail(c, 'bytes', 404, 'That page image is missing.');

  return c.body(object.body, 200, {
    ...NO_STORE,
    'Content-Type': files.IMAGE_MIME[files.extname(page.file_path)] || 'application/octet-stream',
    'Content-Disposition': 'inline',
  });
});

/* ---------------- comments ---------------- */

router.get('/drafts/:id/comments', async (c) => {
  const db = c.env.DB;
  const got = await loadDraft(c, 'json');
  if (got.error) return got.error;
  const draft = got.draft;

  const allPages = c.req.query('all') === '1' || c.req.query('all') === 'true';
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const [rows, replies, counts] = await Promise.all([
    allPages ? q.topLevelAll(db, draft.id) : q.topLevelForPage(db, draft.id, page),
    // One statement for every reply on the draft; buildThreads keeps only the
    // ones whose parent is in `rows`.
    q.repliesForDraft(db, draft.id),
    countsFor(db, draft.id),
  ]);

  return c.json(
    {
      ok: true,
      all: allPages,
      page: allPages ? null : page,
      counts,
      total: Object.values(counts).reduce((sum, x) => sum + x.total, 0),
      open: Object.values(counts).reduce((sum, x) => sum + x.open, 0),
      threads: buildThreads(rows, replies, c.get('currentUser'), draft, allPages),
    },
    200,
    NO_STORE
  );
});

router.post('/drafts/:id/comments', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const contentType = String(c.req.header('content-type') || '');
  const wantsJson =
    contentType.includes('application/json') ||
    String(c.req.header('accept') || '').includes('application/json');
  const mode = wantsJson ? 'json' : 'html';

  const got = await loadDraft(c, mode);
  if (got.error) return got.error;
  const draft = got.draft;

  if (draft.status !== 'ready') {
    return fail(c, mode, 409, 'That draft is still being converted.');
  }

  let body;
  if (contentType.includes('application/json')) {
    if (Number(c.req.header('content-length') || 0) > MAX_JSON_BYTES) {
      return fail(c, mode, 413, 'That comment was too large.');
    }
    try {
      body = await c.req.json();
    } catch {
      return fail(c, mode, 400, 'That request body was not JSON.');
    }
  } else {
    body = await getBody(c);
  }
  body = body && typeof body === 'object' ? body : {};

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
  const rawParent = Array.isArray(body.parent_id) ? body.parent_id[0] : body.parent_id;
  if (rawParent !== undefined && rawParent !== null && String(rawParent).trim() !== '') {
    const parentId = Number(rawParent);
    if (!Number.isInteger(parentId) || parentId <= 0) {
      return fail(c, mode, 400, 'That reply has no comment to attach to.');
    }
    parent = await q.commentByIdAny(db, parentId);
    if (!parent || parent.draft_id !== draft.id) {
      return fail(c, mode, 404, 'That comment is not on this draft.');
    }
    if (parent.deleted_at) {
      return fail(c, mode, 400, 'That comment was removed — there is nothing to reply to.');
    }
    if (parent.parent_id !== null) {
      return fail(c, mode, 400, 'Replies attach to the comment that started the thread.');
    }
    if (parent.resolved_at) {
      return fail(c, mode, 409, 'That thread is resolved. Reopen it to reply.');
    }
  }

  // A reply inherits its parent's page so it can never drift off the note it
  // answers; a new thread anchors to whatever page the reader is showing.
  const pageNumber = parent
    ? parent.page_number
    : Math.max(1, Math.min(Number(body.page_number) || 1, draft.page_count || 1));
  const source = String(body.body == null ? '' : body.body).trim().slice(0, MAX_COMMENT_CHARS);

  if (!source) return fail(c, mode, 400, 'Write something first.');

  const html = mdToHtml(source);
  if (!toPlainText(html).trim()) return fail(c, mode, 400, 'That comment came out empty.');

  const meta = await run(
    db,
    `INSERT INTO comments (draft_id, page_number, parent_id, user_id, body_html, body_md)
     VALUES (?, ?, ?, ?, ?, ?)`,
    draft.id,
    pageNumber,
    parent ? parent.id : null,
    user.id,
    html,
    source
  );
  const row = await q.commentById(db, Number(meta.last_row_id));
  row.author_name = user.display_name;

  if (wantsJson) {
    return c.json(
      {
        ok: true,
        thread_id: parent ? parent.id : row.id,
        comment: parent ? replyJson(row, user) : threadJson(row, [], user, draft),
      },
      201,
      NO_STORE
    );
  }
  flash(c, 'ok', parent ? 'Reply posted.' : 'Comment posted.');
  return c.redirect(`/drafts/${draft.id}#p=${pageNumber}`, 302);
});

/*
 * Resolve / reopen — a toggle, because "settled" is not a one-way door and the
 * same three people (uploader, leader, thread author) own both directions.
 */
router.post('/comments/:id/resolve', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const wantsJson =
    String(c.req.header('content-type') || '').includes('application/json') ||
    String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(c.req.header('accept') || '').includes('application/json');
  const mode = wantsJson ? 'json' : 'html';

  const comment = await q.commentById(db, Number(c.req.param('id')));
  if (!comment) return fail(c, mode, 404, 'That comment is already gone.');
  if (comment.parent_id !== null) {
    return fail(c, mode, 400, 'Only the comment that starts a thread can be resolved.');
  }

  const draft = await q.draft(db, comment.draft_id);
  if (!draft) return fail(c, mode, 404, 'That draft is not here.');

  if (!canResolveThread(user, draft, comment)) {
    return fail(
      c,
      mode,
      403,
      'Only the person who uploaded this draft, a leader, or whoever started the thread can resolve it.'
    );
  }

  if (comment.resolved_at) {
    await run(db, 'UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?', comment.id);
  } else {
    await run(
      db,
      `UPDATE comments SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ?
        WHERE id = ?`,
      user.id,
      comment.id
    );
  }

  const now = await q.resolvedRow(db, comment.id);

  if (wantsJson) {
    return c.json(
      {
        ok: true,
        id: comment.id,
        resolved: !!now.resolved_at,
        resolved_by: now.resolved_at ? now.resolver_name || 'a member' : null,
      },
      200,
      NO_STORE
    );
  }
  flash(c, 'ok', now.resolved_at ? 'Thread resolved.' : 'Thread reopened.');
  return c.redirect(`/drafts/${comment.draft_id}#p=${comment.page_number}`, 302);
});

router.post('/comments/:id/delete', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const wantsJson =
    String(c.req.header('content-type') || '').includes('application/json') ||
    String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(c.req.header('accept') || '').includes('application/json');
  const mode = wantsJson ? 'json' : 'html';

  const comment = await q.commentById(db, Number(c.req.param('id')));
  if (!comment) return fail(c, mode, 404, 'That comment is already gone.');

  if (!(comment.user_id === user.id || isLeader(user))) {
    return fail(c, mode, 403, 'Only the person who wrote a comment (or a leader) can remove it.');
  }

  await run(
    db,
    `UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    user.id,
    comment.id
  );

  if (wantsJson) return c.json({ ok: true, id: comment.id }, 200, NO_STORE);
  flash(c, 'ok', 'Comment removed.');
  return c.redirect(`/drafts/${comment.draft_id}#p=${comment.page_number}`, 302);
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

router.post('/drafts/:id/conversation', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const got = await loadDraft(c, 'html');
  if (got.error) return got.error;
  const draft = got.draft;

  const back = `/drafts/${draft.id}#conversation`;
  const thread = await q.thread(db, draft.id);
  if (!thread) {
    flash(c, 'error', 'This draft has no conversation any more.');
    return c.redirect(back, 302);
  }
  if (thread.is_locked && !isLeader(user)) {
    flash(c, 'error', 'This conversation is locked.');
    return c.redirect(back, 302);
  }

  const body = await getBody(c);
  const bodyMd = conversationTrim(field(body, 'body_md'), MAX_POST_CHARS);
  if (!bodyMd) {
    flash(c, 'error', 'Write something before you post.');
    return c.redirect(back, 302);
  }
  const bodyHtml = mdToHtml(bodyMd);
  if (!toPlainText(bodyHtml).trim()) {
    flash(c, 'error', 'Nothing survived the formatting filter — try plain text or simple markdown.');
    return c.redirect(back, 302);
  }

  const results = await db.batch([
    stmt(
      db,
      'INSERT INTO posts (thread_id, user_id, body_html, body_md) VALUES (?, ?, ?, ?)',
      thread.id,
      user.id,
      bodyHtml,
      bodyMd
    ),
    stmt(
      db,
      `UPDATE threads SET last_post_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      thread.id
    ),
  ]);
  return c.redirect(`/drafts/${draft.id}#conv-${Number(results[0].meta.last_row_id)}`, 302);
});

router.post('/drafts/:id/conversation/:postId/delete', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const got = await loadDraft(c, 'html');
  if (got.error) return got.error;
  const draft = got.draft;

  const [post, thread] = await Promise.all([
    q.postById(db, Number(c.req.param('postId'))),
    q.thread(db, draft.id),
  ]);
  if (!post || !thread || post.thread_id !== thread.id) {
    return fail(c, 'html', 404, 'That post is already gone.');
  }
  if (!(post.user_id === user.id || isLeader(user))) {
    return fail(c, 'html', 403, 'Only the person who wrote a post (or a leader) can remove it.');
  }

  await run(
    db,
    `UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    user.id,
    post.id
  );
  flash(c, 'info', 'Post removed.');
  return c.redirect(`/drafts/${draft.id}#conversation`, 302);
});

export default router;
