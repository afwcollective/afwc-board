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
const { flash } = require('../util/flash');
const { toPlainText } = require('../util/sanitize');
const { ingestDraft } = require('../services/ingest');
const { draftDir, TMP_DIR } = require('../services/ingest/paths');

const router = express.Router();

/* ---------------- limits & formats ---------------- */

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_IMAGES = 60;

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

/* ---------------- queries (route-local by convention) ---------------- */

const q = {
  library: () =>
    db.prepare(
      `SELECT d.id, d.title, d.description, d.kind, d.status, d.error_msg, d.page_count,
              d.original_filename, d.created_at, d.user_id,
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
      `INSERT INTO drafts (user_id, title, description, kind, status, original_filename, original_path)
       VALUES (?, ?, ?, ?, 'processing', ?, ?)`
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

const canManage = (user, draft) => !!user && (user.id === draft.user_id || user.role === 'leader');

/* ---------------- library ---------------- */

router.get('/', requireMember, (req, res) => {
  const isLeader = req.user.role === 'leader' ? 1 : 0;
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
    },
    limits: {
      maxDocMb: MAX_DOC_BYTES / 1024 / 1024,
      maxImageMb: MAX_IMAGE_BYTES / 1024 / 1024,
      maxImagesTotalMb: MAX_IMAGES_TOTAL_BYTES / 1024 / 1024,
      maxImages: MAX_IMAGES,
    },
  });
}

router.get('/new', requireMember, (req, res) => renderNew(req, res));

/* ---------------- create ---------------- */

router.post('/', requireMember, handleUpload, (req, res) => {
  const wantsJson =
    req.xhr ||
    String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(req.get('accept') || '').includes('application/json');

  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, 160);
  const description = String(body.description || '').trim().slice(0, 2000);
  const mode = body.mode === 'images' ? 'images' : 'document';
  const docFiles = (req.files && req.files.document) || [];
  const imageFiles = (req.files && req.files.images) || [];

  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  if (!title) errors.push('Give the draft a title so people know what they are opening.');

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

  if (errors.length) {
    cleanupTmp(req);
    if (wantsJson) return res.status(400).json({ ok: false, errors });
    return renderNew(req, res, { errors, values: { title, description, mode } });
  }

  /* ---- insert the row, then move the bytes into place ---- */

  let draftId = null;
  try {
    const originalName =
      kind === 'images'
        ? `${ordered.length} page image${ordered.length === 1 ? '' : 's'}`
        : String(ordered[0].originalname || '').slice(0, 200);
    const originalPath =
      kind === 'images'
        ? null
        : `original${path.extname(String(ordered[0].originalname || '')).toLowerCase()}`;

    draftId = Number(
      q
        .insert()
        .run(req.user.id, title, description || null, kind, originalName, originalPath).lastInsertRowid
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
    return renderNew(req, res, { errors: [message], values: { title, description, mode } });
  }

  setImmediate(() => {
    ingestDraft(draftId).catch((err) => console.error('[afwc] ingest crashed:', err));
  });

  flash(res, 'ok', 'Uploaded. Converting it for the reader now — this page updates itself.');
  const location = `/drafts/${draftId}`;
  if (wantsJson) return res.status(201).json({ ok: true, id: draftId, redirect: location });
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
