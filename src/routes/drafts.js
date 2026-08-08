'use strict';

/**
 * Draft library — listing, upload, retry, delete (Phases 4–5).
 * Mounted at /drafts by src/app.js — add routes here, not there.
 *
 * The reader shell and every byte-serving route live in src/routes/reader.js.
 *
 * NOTE ON CSRF + MULTIPART: src/auth/middleware.js checkCsrf runs before any
 * router and reads req.body._csrf (parsed by express.urlencoded) or the
 * X-CSRF-Token header. A multipart body is not parsed at that point, so a plain
 * <form enctype="multipart/form-data"> can never satisfy it. The upload form is
 * therefore submitted by public/js/upload.js as an XHR carrying X-CSRF-Token,
 * and POST /drafts answers JSON. If the CSRF middleware later learns to read
 * multipart bodies, this route still works for a plain form post — it falls back
 * to a redirect when the client did not ask for JSON.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { db } = require('../db');
const { requireMember } = require('../auth/middleware');
const { isLeaderUser, isArchitectUser } = require('../auth/roles');
const { flash } = require('../util/flash');
const { toPlainText } = require('../util/sanitize');
const { ingestDraft, swapDraftFile } = require('../services/ingest');
const { draftDir, swapDir, TMP_DIR } = require('../services/ingest/paths');

const router = express.Router();

/* ---------------- limits & formats ---------------- */

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_IMAGES = 60;
/** The pen-name / author-credit field on the upload form and its edit route. */
const MAX_AUTHOR_CHARS = 80;

/**
 * The upload form's own two limits, lifted out of POST / so the edit route
 * clamps title and description to exactly the same lengths the upload did —
 * "existing validation rules from upload" has to mean one set of numbers, not
 * two that happen to agree today.
 */
const MAX_TITLE_CHARS = 160;
const MAX_DESC_CHARS = 2000;

/**
 * The discussion topic. threads.title is what /board lists and what
 * /board/:id headlines, and a thread title has never had a length of its own —
 * it was always the draft's title, so the draft's limit is the honest one.
 */
const MAX_TOPIC_CHARS = 160;

/**
 * Strip tags, trim, clamp to MAX_AUTHOR_CHARS, and fold an empty result to
 * `null` — NULL is what COALESCE-in-the-template (`author_name ||
 * uploader_name`) treats as "nothing was set, use the display name". Runs
 * through the same house allowlist as everything else user-typed, so a
 * hand-crafted `<script>` in this field is inert before it ever reaches the
 * database, not merely escaped on the way back out.
 */
function sanitizeAuthorName(raw) {
  const clean = toPlainText(String(raw == null ? '' : raw)).trim().slice(0, MAX_AUTHOR_CHARS);
  return clean || null;
}

/**
 * Same treatment for the discussion topic, and for the same reason — this one
 * ends up as a heading on /board and in the reader, so it is stripped to plain
 * text on the way IN rather than trusted and escaped on the way out. Empty
 * means "no topic of its own"; the caller falls back to the draft's title.
 */
function sanitizeTopic(raw) {
  const clean = toPlainText(String(raw == null ? '' : raw)).trim().slice(0, MAX_TOPIC_CHARS);
  return clean || null;
}

const DOC_KINDS = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
};
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const KIND_LABEL = {
  docx: 'Word',
  pdf: 'PDF',
  text: 'Text',
  images: 'Graphic novel',
};

/* ---------------- magic-byte sniffing ---------------- */

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * The extension is a hint; these bytes are the check. Returns null when the
 * file really is what it claims, otherwise a member-readable complaint.
 */
function sniff(ext, head, fullPath) {
  if (ext === '.docx') {
    // Every OOXML file is a zip.
    return startsWith(head, [0x50, 0x4b])
      ? null
      : 'is not a real Word file (its contents are not a .docx).';
  }
  if (ext === '.pdf') {
    return startsWith(head, [0x25, 0x50, 0x44, 0x46])
      ? null
      : 'is not a real PDF (its contents do not start with %PDF).';
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    try {
      UTF8_DECODER.decode(fs.readFileSync(fullPath));
      return null;
    } catch {
      return 'is not plain UTF-8 text. Re-save it as UTF-8 and try again.';
    }
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return startsWith(head, [0xff, 0xd8, 0xff]) ? null : 'is not a real JPEG.';
  }
  if (ext === '.png') {
    return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? null
      : 'is not a real PNG.';
  }
  if (ext === '.webp') {
    const ok =
      startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      head.length >= 12 &&
      head.subarray(8, 12).toString('latin1') === 'WEBP';
    return ok ? null : 'is not a real WebP image.';
  }
  return 'is not a file type we can read.';
}

function readHead(fullPath, n = 16) {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------- multer ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(String(file.originalname || '')).toLowerCase().slice(0, 12);
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: {
    fileSize: MAX_DOC_BYTES,
    files: MAX_IMAGES + 1,
    fields: 12,
    parts: MAX_IMAGES + 16,
  },
});

const acceptUpload = upload.fields([
  { name: 'document', maxCount: 1 },
  { name: 'images', maxCount: MAX_IMAGES },
]);

function handleUpload(req, res, next) {
  acceptUpload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = `That file is too large. Documents max out at ${MAX_DOC_BYTES / 1024 / 1024} MB and page images at ${MAX_IMAGE_BYTES / 1024 / 1024} MB each.`;
      } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT') {
        req.uploadError = `That is more than ${MAX_IMAGES} page images.`;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        req.uploadError = 'That upload had a file field we do not recognise.';
      } else {
        req.uploadError = 'The upload did not arrive intact. Please try again.';
      }
    }
    next();
  });
}

function cleanupTmp(req) {
  const all = [].concat(
    ...Object.values((req && req.files) || {}).map((list) => (Array.isArray(list) ? list : []))
  );
  for (const file of all) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* already gone */
    }
  }
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/* ---------------- what makes a submit acceptable ---------------- */

/**
 * Extension → size → magic bytes, for every file in the submit, before anything
 * is written — the third of the four rules the attachments modules are built
 * on. Shared verbatim by POST / (a new draft) and POST /:id/file (replacing the
 * file under an existing one), because "same kind constraints as upload" has to
 * be one function or it is only a promise.
 *
 * Returns `{ errors, kind, ordered, mode }`. `ordered` is the multer file list
 * in the order it will be written and is EMPTY unless every file passed —
 * nothing is ever stored from a partly-good submit.
 */
function validateSubmit(req) {
  const body = req.body || {};
  const mode = body.mode === 'images' ? 'images' : 'document';
  const docFiles = (req.files && req.files.document) || [];
  const imageFiles = (req.files && req.files.images) || [];

  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);

  let kind = null;
  let ordered = [];

  if (!errors.length && mode === 'document') {
    if (docFiles.length !== 1) {
      errors.push('Choose one document file (.docx, .pdf, .txt or .md).');
    } else {
      const file = docFiles[0];
      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      kind = DOC_KINDS[ext] || null;
      if (!kind) {
        errors.push('That file type is not supported. Upload a .docx, .pdf, .txt or .md file.');
      } else if (file.size > MAX_DOC_BYTES) {
        errors.push(`Documents are limited to ${MAX_DOC_BYTES / 1024 / 1024} MB.`);
      } else {
        const complaint = sniff(ext, readHead(file.path), file.path);
        if (complaint) errors.push(`“${toPlainText(file.originalname, 80)}” ${complaint}`);
        else ordered = [file];
      }
    }
  } else if (!errors.length) {
    kind = 'images';
    if (!imageFiles.length) {
      errors.push('Choose the page images for the sequence (JPG, PNG or WebP).');
    } else if (imageFiles.length > MAX_IMAGES) {
      errors.push(`Up to ${MAX_IMAGES} page images per draft.`);
    } else {
      const total = imageFiles.reduce((sum, f) => sum + f.size, 0);
      if (total > MAX_IMAGES_TOTAL_BYTES) {
        errors.push(`Those pages add up to more than ${MAX_IMAGES_TOTAL_BYTES / 1024 / 1024} MB.`);
      }
      for (const file of imageFiles) {
        const ext = path.extname(String(file.originalname || '')).toLowerCase();
        const name = toPlainText(file.originalname, 80);
        if (!IMAGE_EXTS.has(ext)) {
          errors.push(`“${name}” is not a JPG, PNG or WebP.`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          errors.push(`“${name}” is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
          continue;
        }
        const complaint = sniff(ext, readHead(file.path), file.path);
        if (complaint) errors.push(`“${name}” ${complaint}`);
      }
      if (!errors.length) {
        ordered = imageFiles
          .slice()
          .sort((a, b) =>
            String(a.originalname).localeCompare(String(b.originalname), 'en', {
              numeric: true,
              sensitivity: 'base',
            })
          );
      }
    }
  }

  return { errors, kind, ordered, mode };
}

/** What drafts.original_filename records, for either kind of submit. */
const originalNameFor = (kind, ordered) =>
  kind === 'images'
    ? `${ordered.length} page image${ordered.length === 1 ? '' : 's'}`
    : String(ordered[0].originalname || '').slice(0, 200);

/** `original.docx`, or null for a page sequence (which has no single original). */
const originalRelFor = (kind, ordered) =>
  kind === 'images'
    ? null
    : `original${path.extname(String(ordered[0].originalname || '')).toLowerCase()}`;

/** Does this request want JSON back? (the uploader's XHR always does) */
const wantsJsonReply = (req) =>
  req.xhr ||
  String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
  String(req.get('accept') || '').includes('application/json');

/* ---------------- queries (route-local by convention) ---------------- */

const q = {
  library: () =>
    db.prepare(
      `SELECT d.id, d.title, d.description, d.kind, d.status, d.error_msg, d.page_count,
              d.original_filename, d.created_at, d.user_id, d.author_name,
              u.display_name AS uploader_name,
              (SELECT COUNT(*) FROM comments c
                WHERE c.draft_id = d.id AND c.deleted_at IS NULL) AS comment_count,
              (SELECT t.id FROM threads t
                WHERE t.draft_id = d.id AND t.deleted_at IS NULL
                ORDER BY t.id LIMIT 1) AS thread_id
         FROM drafts d JOIN users u ON u.id = d.user_id
        WHERE d.deleted_at IS NULL
          AND (d.status IN ('ready','processing') OR d.user_id = ? OR ? = 1)
        ORDER BY d.created_at DESC`
    ),
  byId: () => db.prepare('SELECT * FROM drafts WHERE id = ? AND deleted_at IS NULL'),
  insert: () =>
    db.prepare(
      `INSERT INTO drafts (user_id, title, description, kind, status, original_filename, original_path, author_name)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`
    ),
  updateMeta: () =>
    db.prepare(
      `UPDATE drafts SET title = ?, description = ?, author_name = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
  /* -- the draft's discussion thread: read for the topic field, renamed by it -- */
  threadForDraft: () =>
    db.prepare(
      `SELECT id, title FROM threads
        WHERE draft_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`
    ),
  renameThread: () => db.prepare('UPDATE threads SET title = ? WHERE id = ?'),
  /* -- the file swap: the draft goes converting, its rows and bytes stay put -- */
  beginSwap: () =>
    db.prepare(
      `UPDATE drafts SET status = 'processing', error_msg = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
  insertThread: () =>
    db.prepare(
      `INSERT INTO threads (title, user_id, draft_id, last_post_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ),
  softDelete: () =>
    db.prepare(
      `UPDATE drafts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE id = ? AND deleted_at IS NULL`
    ),
  softDeleteThreads: () =>
    db.prepare(
      `UPDATE threads SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE draft_id = ? AND deleted_at IS NULL`
    ),
  reprocess: () =>
    db.prepare(
      `UPDATE drafts SET status = 'processing', error_msg = NULL, page_count = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
};

const canManage = (user, draft) => !!user && (user.id === draft.user_id || isLeaderUser(user));

/**
 * EDITING A DRAFT IS THE UPLOADER'S OWN CALL, not a leader override. A leader
 * can still remove a whole draft (moderation) and retry its conversion, but
 * cannot rewrite the title, the byline, the discussion topic, or — least of all
 * — the file itself on someone else's work. The one exception is the architect,
 * the board's single god-mode account (src/auth/roles.js): every other
 * permission check in this file gives leader and architect the same power via
 * canManage() (isLeaderUser is true for both), and this one deliberately does
 * not. A plain leader gets 403 on every route below that uses it, same as any
 * other member.
 *
 * This started life as canEditAuthor() guarding one field. It guards the whole
 * edit surface now and the rule has not moved an inch — which is the reason it
 * was worth writing down in the first place.
 */
const canEditDraft = (user, draft) => !!user && (user.id === draft.user_id || isArchitectUser(user));

/* ---------------- library ---------------- */

router.get('/', requireMember, (req, res) => {
  const isLeader = isLeaderUser(req.user) ? 1 : 0;
  const drafts = q.library().all(req.user.id, isLeader);
  res.render('drafts/index', {
    title: 'Draft library',
    pageCss: ['/css/drafts.css'],
    drafts,
    kindLabel: KIND_LABEL,
    canManage: (d) => canManage(req.user, d),
  });
});

/* ---------------- upload form ---------------- */

function renderNew(req, res, { errors = [], values = {} } = {}) {
  res.render('drafts/new', {
    title: 'Share a draft',
    pageCss: ['/css/drafts.css'],
    pageJs: ['/js/upload.js'],
    errors,
    values: {
      title: values.title || '',
      description: values.description || '',
      mode: values.mode || 'document',
      authorName: values.authorName || '',
    },
    limits: {
      maxDocMb: MAX_DOC_BYTES / 1024 / 1024,
      maxImageMb: MAX_IMAGE_BYTES / 1024 / 1024,
      maxImagesTotalMb: MAX_IMAGES_TOTAL_BYTES / 1024 / 1024,
      maxImages: MAX_IMAGES,
      maxAuthorChars: MAX_AUTHOR_CHARS,
    },
  });
}

router.get('/new', requireMember, (req, res) => renderNew(req, res));

/* ---------------- create ---------------- */

router.post('/', requireMember, handleUpload, (req, res) => {
  const wantsJson = wantsJsonReply(req);

  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, MAX_TITLE_CHARS);
  const description = String(body.description || '').trim().slice(0, MAX_DESC_CHARS);
  const authorName = sanitizeAuthorName(body.author_name);

  const submit = validateSubmit(req);
  const { kind, ordered, mode } = submit;
  const errors = submit.errors;
  if (!title) errors.unshift('Give the draft a title so people know what they are opening.');

  if (errors.length) {
    cleanupTmp(req);
    if (wantsJson) return res.status(400).json({ ok: false, errors });
    return renderNew(req, res, { errors, values: { title, description, mode, authorName } });
  }

  /* ---- insert the row, then move the bytes into place ---- */

  let draftId = null;
  try {
    const originalName = originalNameFor(kind, ordered);
    const originalPath = originalRelFor(kind, ordered);

    draftId = Number(
      q
        .insert()
        .run(req.user.id, title, description || null, kind, originalName, originalPath, authorName)
        .lastInsertRowid
    );

    const dir = draftDir(draftId);
    fs.mkdirSync(dir, { recursive: true });

    if (kind === 'images') {
      const pagesDir = path.join(dir, 'pages');
      fs.mkdirSync(pagesDir, { recursive: true });
      ordered.forEach((file, i) => {
        const ext = path.extname(String(file.originalname || '')).toLowerCase();
        moveFile(file.path, path.join(pagesDir, `${String(i + 1).padStart(4, '0')}${ext}`));
      });
    } else {
      moveFile(ordered[0].path, path.join(dir, originalPath));
    }

    // The draft's discussion thread. The board router renders it at
    // /board/<id>; the reader only links to it.
    q.insertThread().run(title, req.user.id, draftId);
  } catch (err) {
    console.error('[afwc] draft upload failed:', err);
    cleanupTmp(req);
    if (draftId) {
      try {
        db.prepare(
          `UPDATE drafts SET status = 'failed',
                  error_msg = 'The upload could not be stored. Please try again.'
            WHERE id = ?`
        ).run(draftId);
      } catch {
        /* nothing more to do */
      }
    }
    const message = 'We could not store that upload. Please try again.';
    if (wantsJson) return res.status(500).json({ ok: false, errors: [message] });
    return renderNew(req, res, { errors: [message], values: { title, description, mode, authorName } });
  }

  setImmediate(() => {
    ingestDraft(draftId).catch((err) => console.error('[afwc] ingest crashed:', err));
  });

  flash(res, 'ok', 'Uploaded. Converting it for the reader now — this page updates itself.');
  const location = `/drafts/${draftId}`;
  if (wantsJson) return res.status(201).json({ ok: true, id: draftId, redirect: location });
  return res.redirect(location);
});

/* ---------------- edit ----------------
 *
 * UPLOADER (OR THE ARCHITECT) ONLY — deliberately narrower than retry/delete
 * below, which any leader can also do. A leader moderates (removes a draft that
 * should not be here); they do not get to retitle, re-credit, re-topic or
 * REPLACE THE FILE UNDER someone else's work. canEditDraft(), not canManage(),
 * guards all three routes here — a plain leader gets 403 exactly like any other
 * member, on the GET as well as the POSTs.
 *
 * Four things live on this page and two of them are ordinary form fields:
 *
 *   title, description   the upload form's own fields, its own limits.
 *   author name          the byline (drafts.author_name; NULL = display name).
 *   discussion topic     threads.title for the thread this draft owns. Blank
 *                        resets it to the draft's title, which is what upload
 *                        set it to in the first place.
 *   the file             POST /:id/file, below — a whole re-ingest.
 */

/** The one shape both GET /:id/edit and a re-rendered POST hand the template. */
function renderEdit(req, res, draft, { errors = [], values = null, status = 200 } = {}) {
  const thread = q.threadForDraft().get(draft.id) || null;
  res.status(status).render('drafts/edit', {
    title: `Edit — ${draft.title}`,
    pageCss: ['/css/drafts.css'],
    /*
     * The upload page's own script, unchanged: views/drafts/edit.ejs's
     * #swap-form is the same shape as #upload-form and posts multipart with
     * X-CSRF-Token to the action on the form. See the header of that file.
     */
    pageJs: ['/js/upload.js'],
    draft,
    kindLabel: KIND_LABEL[draft.kind] || draft.kind,
    hasThread: !!thread,
    topicPlaceholder: thread ? thread.title : '',
    errors,
    values: values || {
      title: draft.title,
      description: draft.description || '',
      authorName: draft.author_name || '',
      topic: thread ? thread.title : '',
      // The swap form opens on the kind the draft already is — the likeliest
      // replacement for a graphic novel is another page sequence. Changing kind
      // is one click away either way.
      mode: draft.kind === 'images' ? 'images' : 'document',
    },
    limits: {
      maxTitleChars: MAX_TITLE_CHARS,
      maxDescChars: MAX_DESC_CHARS,
      maxAuthorChars: MAX_AUTHOR_CHARS,
      maxTopicChars: MAX_TOPIC_CHARS,
      maxDocMb: MAX_DOC_BYTES / 1024 / 1024,
      maxImageMb: MAX_IMAGE_BYTES / 1024 / 1024,
      maxImagesTotalMb: MAX_IMAGES_TOTAL_BYTES / 1024 / 1024,
      maxImages: MAX_IMAGES,
    },
  });
}

/** The draft this request may edit, or a 403/404 handed to next(). */
function editable(req, next) {
  const draft = q.byId().get(Number(req.params.id));
  if (!draft) {
    next();
    return null;
  }
  if (!canEditDraft(req.user, draft)) {
    const err = new Error('Only the person who uploaded this draft (or the architect) can edit it.');
    err.status = 403;
    next(err);
    return null;
  }
  return draft;
}

router.get('/:id/edit', requireMember, (req, res, next) => {
  const draft = editable(req, next);
  if (draft) renderEdit(req, res, draft);
});

router.post('/:id/edit', requireMember, (req, res, next) => {
  const draft = editable(req, next);
  if (!draft) return undefined;

  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, MAX_TITLE_CHARS);
  const description = String(body.description || '').trim().slice(0, MAX_DESC_CHARS);
  const authorName = sanitizeAuthorName(body.author_name);
  const topic = sanitizeTopic(body.topic);

  const errors = [];
  if (!title) errors.push('Give the draft a title so people know what they are opening.');
  if (errors.length) {
    return renderEdit(req, res, draft, {
      errors,
      status: 400,
      values: { title: String(body.title || ''), description, authorName: authorName || '', topic: topic || '', mode: 'document' },
    });
  }

  const thread = q.threadForDraft().get(draft.id) || null;
  /*
   * BLANK MEANS "the draft's title" — and it means the title being saved by
   * THIS submit, not the one the draft had a moment ago, so retitling a draft
   * and clearing its topic in one go leaves the two in step rather than a
   * revision apart.
   */
  const save = db.transaction(() => {
    q.updateMeta().run(title, description || null, authorName, draft.id);
    if (thread) q.renameThread().run(topic || title, thread.id);
  });
  save();

  flash(res, 'ok', 'Draft updated.');
  return res.redirect(`/drafts/${draft.id}`);
});

/* ---------------- replace the file ----------------
 *
 * SWAPPING THE FILE IS A FULL RE-INGEST, and it deliberately keeps nothing of
 * the old conversion: new original, new draft_pages, new kind, new page_count,
 * back through the ordinary processing → ready/failed lifecycle. A .docx draft
 * may become a PDF; the reader picks its pane off drafts.kind and never knew
 * what the draft used to be.
 *
 * WHAT SURVIVES, AND WHY IT IS NOT A BUG: the draft id, its URL, its discussion
 * thread, and ITS PAGE COMMENTS. comments.page_number is not rewritten, because
 * there is no honest mapping from a page of one file to a page of another — a
 * comment stays on the page NUMBER it was left on, and may now sit against
 * different words. views/drafts/edit.ejs says that in those words, right next
 * to this control, because it is the one consequence a member has to decide
 * about before they click.
 *
 * The multipart/CSRF arrangement is the upload form's, for the reason at the
 * top of this file: views/drafts/edit.ejs's #swap-form is driven by
 * public/js/upload.js, which sends the XHR with X-CSRF-Token, and this route
 * answers JSON.
 *
 * THE PERMISSION CHECK IS ITS OWN MIDDLEWARE, ahead of multer. handleUpload
 * streams up to 25 MB (or sixty images) to disk before a handler sees anything,
 * and there is no reason to spend that on a request that is about to be
 * refused — the Worker refuses the same request before it parses its body, and
 * the two stacks should cost an intruder the same nothing.
 */
const requireEditable = (req, res, next) => {
  if (editable(req, next)) next();
};

router.post('/:id/file', requireMember, requireEditable, handleUpload, (req, res, next) => {
  const wantsJson = wantsJsonReply(req);
  const draft = editable(req, next);
  if (!draft) {
    cleanupTmp(req);
    return undefined;
  }

  const { errors, kind, ordered } = validateSubmit(req);
  if (errors.length) {
    cleanupTmp(req);
    if (wantsJson) return res.status(400).json({ ok: false, errors });
    return renderEdit(req, res, draft, { errors, status: 400 });
  }

  /* ---- stage the replacement; the live bytes are not touched ---- */

  const staging = swapDir(draft.id);
  let originalPath = null;
  try {
    fs.rmSync(staging, { recursive: true, force: true }); // any abandoned attempt
    fs.mkdirSync(staging, { recursive: true });
    if (kind === 'images') {
      const pagesDir = path.join(staging, 'pages');
      fs.mkdirSync(pagesDir, { recursive: true });
      ordered.forEach((file, i) => {
        const ext = path.extname(String(file.originalname || '')).toLowerCase();
        moveFile(file.path, path.join(pagesDir, `${String(i + 1).padStart(4, '0')}${ext}`));
      });
    } else {
      originalPath = `swap/${originalRelFor(kind, ordered)}`;
      moveFile(ordered[0].path, path.join(staging, originalRelFor(kind, ordered)));
    }
  } catch (err) {
    console.error('[afwc] draft file swap could not be staged:', err);
    cleanupTmp(req);
    fs.rmSync(staging, { recursive: true, force: true });
    const message = 'We could not store that replacement file. Please try again.';
    if (wantsJson) return res.status(500).json({ ok: false, errors: [message] });
    return renderEdit(req, res, draft, { errors: [message], status: 500 });
  }

  q.beginSwap().run(draft.id);
  const staged = { kind, originalFilename: originalNameFor(kind, ordered), originalPath };
  setImmediate(() => {
    swapDraftFile(draft.id, staged).catch((err) => console.error('[afwc] swap crashed:', err));
  });

  flash(res, 'ok', 'Replacing the file — converting it for the reader now.');
  const location = `/drafts/${draft.id}`;
  if (wantsJson) return res.status(202).json({ ok: true, id: draft.id, redirect: location });
  return res.redirect(location);
});

/* ---------------- retry & delete ---------------- */

router.post('/:id/retry', requireMember, (req, res, next) => {
  const draft = q.byId().get(Number(req.params.id));
  if (!draft) return next();
  if (!canManage(req.user, draft)) {
    const err = new Error('Only the person who uploaded this (or a leader) can retry it.');
    err.status = 403;
    return next(err);
  }
  q.reprocess().run(draft.id);
  setImmediate(() => {
    ingestDraft(draft.id).catch((err) => console.error('[afwc] ingest crashed:', err));
  });
  flash(res, 'info', 'Trying that conversion again.');
  return res.redirect(`/drafts/${draft.id}`);
});

router.post('/:id/delete', requireMember, (req, res, next) => {
  const draft = q.byId().get(Number(req.params.id));
  if (!draft) return next();
  if (!canManage(req.user, draft)) {
    const err = new Error('Only the person who uploaded this (or a leader) can remove it.');
    err.status = 403;
    return next(err);
  }
  const remove = db.transaction(() => {
    q.softDelete().run(req.user.id, draft.id);
    q.softDeleteThreads().run(req.user.id, draft.id);
  });
  remove();
  flash(res, 'ok', `“${draft.title}” has been removed from the library.`);
  return res.redirect('/drafts');
});

module.exports = router;
