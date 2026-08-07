/**
 * Draft library and THE UPLOAD PROTOCOL — the port of src/routes/drafts.js plus
 * the whole of src/services/ingest/, which no longer exists on this stack.
 *
 * Mounted at /drafts by worker/src/index.js. The reader shell and every
 * byte-serving route live in worker/src/routes/reader.js, exactly as they do on
 * the Express side.
 *
 * ============================================================ WHAT CHANGED ===
 *
 * PORT-CLOUDFLARE.md §6 is the whole of this file's shape. The free plan gives
 * a request ~10 ms of CPU; mammoth on a chapter-length .docx is two orders of
 * magnitude past that, and pdf.js is worse. So CONVERSION MOVES TO THE
 * UPLOADER'S BROWSER (public/js/upload-cf.js) and the Worker's job becomes
 * storing, checking and counting. Express's `setImmediate(() => ingestDraft())`
 * has no counterpart here; the client drives, in four steps:
 *
 *   1. POST /drafts                 multipart: metadata + the ORIGINAL file(s).
 *                                   Magic bytes are sniffed HERE, server-side,
 *                                   as always. Writes the draft row (status
 *                                   'processing') + its discussion thread in one
 *                                   D1 batch, then streams the originals to R2.
 *                                   → 201 { ok, id, redirect }
 *
 *   2. POST /drafts/:id/pages       JSON batches of converted pages, ≤150 KB
 *                                   each. EVERY page is sanitized server-side
 *                                   with the house allowlist before it is
 *                                   stored. docx/text only.
 *
 *   3. POST /drafts/:id/finalize    { page_count, sizes? }. The server counts
 *                                   the rows it actually holds and refuses to
 *                                   flip 'ready' unless they are 1..page_count
 *                                   with no gaps. PDFs and image sequences get
 *                                   their pdf_page/image rows built here from
 *                                   the submitted geometry.
 *
 *   4. POST /drafts/:id/fail        the client's conversion blew up. Sets the
 *                                   failed state using a SERVER-side sentence
 *                                   picked by a reason code — the client never
 *                                   supplies display text.
 *
 * A draft that never reaches step 3 — JS off, tab closed, laptop shut — stays
 * 'processing' forever and is swept exactly as it was before. The Express sweep
 * (src/services/ingest/index.js sweepStaleProcessing, ten minutes since the last
 * touch) becomes the P5 Cron Trigger; the SQL is unchanged and every write in
 * this file touches drafts.updated_at so a slow legitimate upload is never swept
 * out from under itself.
 *
 * ------------------------------------------------- WHAT THE CLIENT IS TRUSTED
 * FOR, WRITTEN DOWN ON PURPOSE:
 *
 *   · PAGE HTML — NOT trusted. cleanHtml() runs on every page on the way in,
 *     with the same allowlist that has always guarded announcements and posts.
 *     A hand-rolled POST of <script>…</script> stores the same nothing a
 *     hand-rolled comment would.
 *   · FILE TYPE — NOT trusted. Extension, size and magic bytes are checked here
 *     against the bytes in hand before anything is written.
 *   · PAGE COUNT for docx/text — NOT trusted. Counted from the rows.
 *   · PAGE COUNT for a PDF — TRUSTED, within bounds (1..2000). A Worker cannot
 *     re-derive it: parsing the PDF is precisely the CPU the plan moved off the
 *     server, and there is no cheap header field that gives it honestly. The
 *     blast radius is a member lying to themselves about their own draft: the
 *     reader would render N page slots over a PDF with fewer real pages, which
 *     pdf.js then declines to paint. No other member's data is involved and
 *     nothing escapes the draft. Bounded and accepted.
 *   · PAGE GEOMETRY (width/height for pdf_page and image rows) — TRUSTED,
 *     within bounds (1..20000). It only ever becomes a CSS aspect-ratio on a
 *     placeholder. Same blast radius as above.
 *   · IMAGE ORDER AND FILENAMES — NOT trusted. The server sorts the parts and
 *     names every object itself (worker/src/services/drafts/attachments.js).
 *
 * ----------------------------------------------- TWO BEHAVIOURS THAT MOVED ---
 *
 * RETRY IS NOW RE-UPLOAD. src/routes/drafts.js POST /:id/retry re-ran ingest
 * over the original still sitting on disk. Conversion now happens in a browser
 * that no longer has the file, and handing the original back would break the
 * one promise the draft library makes ("nobody gets your original file back
 * out"), so retry cannot mean what it meant. The button in the shared views
 * still works and still lands somewhere useful: it flashes an explanation and
 * sends the uploader to /drafts/new. The failed-state card keeps Remove and
 * gains that hint. This is a REAL, DELIBERATE SIMPLIFICATION, not an oversight.
 *
 * CSRF + MULTIPART is unchanged in spirit and unchanged in mechanism: a plain
 * <form enctype="multipart/form-data"> still cannot satisfy checkCsrf, because
 * worker/src/util/body.js deliberately never parses a multipart body in the
 * middleware. The uploader sends X-CSRF-Token from fetch/XHR and this route
 * answers JSON. The JSON steps (2–4) are the same deal from the other side:
 * checkCsrf reads the header, getBody() leaves the stream alone, and the route
 * calls c.req.json() on an unconsumed body.
 */

import { Hono } from 'hono';

import { one, all, run, stmt } from '../db.js';
import { requireMember, HttpError } from '../auth/middleware.js';
import { isLeaderUser } from '../auth/roles.js';
import { flash } from '../util/flash.js';
import { cleanHtml, toPlainText } from '../util/sanitize.js';
import { getFormData, field } from '../util/body.js';
import { render } from '../render.js';
import * as files from '../services/drafts/attachments.js';

const router = new Hono();

router.use('*', requireMember);

/* ---------------- protocol limits ---------------- */

/**
 * One page batch. 150 KB is the number PORT-CLOUDFLARE.md §6 names, and it is
 * chosen for CPU rather than for bandwidth: sanitize-html on ~150 KB of
 * paragraph HTML measures around 6–8 ms in workerd, which fits the budget with
 * room for the D1 write. MAX_PAGES_PER_BATCH is the second half of the same
 * guarantee — a batch of tiny pages costs per-page overhead, not per-byte.
 */
const MAX_BATCH_BYTES = 150 * 1024;
const MAX_PAGES_PER_BATCH = 12;

/** Sanity bound on any page number, anywhere in the protocol. */
const MAX_PAGES = 2000;

/** Sanity bound on a submitted page dimension, in pixels/points. */
const MAX_DIMENSION = 20000;

/** How many rows go into one D1 batch when a 2000-page PDF is finalized. */
const ROWS_PER_BATCH = 200;

/**
 * The upload multipart body cap, checked from Content-Length before anything is
 * parsed. Slack over the image total covers the multipart framing and the text
 * fields; a document submit is bounded by MAX_DOC_BYTES on the part itself.
 */
const MAX_UPLOAD_BYTES = files.MAX_IMAGES_TOTAL_BYTES + 2 * 1024 * 1024;

/**
 * The failure sentences, copied from src/services/ingest/index.js GENERIC_ERROR
 * plus the two friendly ones the per-kind builders raised. The CLIENT PICKS A
 * KEY, THE SERVER PICKS THE WORDS — a member never sees a string an uploader's
 * browser composed.
 */
const FAIL_REASONS = {
  text: 'We could not convert that text file. Try re-saving it as UTF-8 plain text.',
  docx: 'We could not convert that .docx. Try re-saving it from Word or Google Docs and upload again.',
  pdf: 'We could not read that PDF. Try re-exporting it and upload again.',
  images: 'We could not process those page images. Try uploading them again.',
  encrypted: 'That PDF is password-protected. Save an unprotected copy and upload that.',
  empty: 'We could not find any readable text in that file.',
  interrupted: 'Upload interrupted — please re-upload.',
};

/* ---------------- queries (route-local by convention) ---------------- */

const q = {
  library: (db, userId, isLeader) =>
    all(
      db,
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
        ORDER BY d.created_at DESC`,
      userId,
      isLeader
    ),
  byId: (db, id) => one(db, 'SELECT * FROM drafts WHERE id = ? AND deleted_at IS NULL', id),
  pageStats: (db, id) =>
    one(
      db,
      `SELECT COUNT(*) AS n, MIN(page_number) AS lo, MAX(page_number) AS hi
         FROM draft_pages WHERE draft_id = ?`,
      id
    ),
};

const canManage = (user, draft) => !!user && (user.id === draft.user_id || isLeaderUser(user));

/** What R2 labels a stored original with. Never used to decide anything. */
const DOC_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
};
const mimeForExt = (ext) => DOC_MIME[ext] || 'application/octet-stream';

const touchDraft = (db, id) =>
  stmt(db, `UPDATE drafts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, id);

const markFailed = (db, id, message) =>
  run(
    db,
    `UPDATE drafts SET status = 'failed', error_msg = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    message,
    id
  );

/* ---------------- JSON helpers ---------------- */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

const jsonFail = (c, status, error) => c.json({ ok: false, error }, status, NO_STORE);

/**
 * The guard every protocol step shares: a real draft, managed by this member,
 * still in flight. Returns the draft, or a Response to hand straight back.
 */
async function protocolDraft(c) {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return { error: jsonFail(c, 404, 'That draft is not here.') };
  const draft = await q.byId(db, id);
  if (!draft) return { error: jsonFail(c, 404, 'That draft is not here.') };
  if (!canManage(c.get('currentUser'), draft)) {
    return { error: jsonFail(c, 403, 'Only the person who uploaded this (or a leader) can add to it.') };
  }
  if (draft.status !== 'processing') {
    return { error: jsonFail(c, 409, 'That draft is not being converted any more.') };
  }
  return { draft };
}

/** c.req.json() with the two failure shapes the protocol promises. */
async function readJsonBody(c) {
  const declared = Number(c.req.header('content-length') || 0);
  if (declared > MAX_BATCH_BYTES) return { error: jsonFail(c, 413, 'That batch is too large.') };
  let body;
  try {
    body = await c.req.json();
  } catch {
    return { error: jsonFail(c, 400, 'That request body was not JSON.') };
  }
  if (!body || typeof body !== 'object') {
    return { error: jsonFail(c, 400, 'That request body was not JSON.') };
  }
  return { body };
}

/* ---------------- library ---------------- */

router.get('/', async (c) => {
  const user = c.get('currentUser');
  const drafts = await q.library(c.env.DB, user.id, isLeaderUser(user) ? 1 : 0);
  return render(c, 'drafts/index', {
    title: 'Draft library',
    pageCss: ['/css/drafts.css'],
    drafts,
    kindLabel: files.KIND_LABEL,
    canManage: (d) => canManage(user, d),
  });
});

/* ---------------- upload form ---------------- */

/**
 * views/drafts/new.ejs is SHARED with the Express app and reads its scripts off
 * `pageJs` (views/layout.ejs), so the two stacks hand it different lists and the
 * template never learns which one it is running on:
 *
 *   Express : ['/js/upload.js']                      — post the file, convert server-side
 *   Worker  : [paginate, '/js/upload-cf.js']         — convert here, then post pages
 *
 * mammoth, marked and pdf.js are NOT in this list. upload-cf.js pulls whichever
 * one the chosen file actually needs at conversion time, from /vendor/ on this
 * origin (CSP script-src 'self'), so nobody uploading a .txt pays for a 700 KB
 * docx converter.
 */
function newLocals(errors = [], values = {}) {
  return {
    title: 'Share a draft',
    pageCss: ['/css/drafts.css'],
    pageJs: ['/vendor/afwc/paginate.js', '/js/upload-cf.js'],
    errors,
    values: {
      title: values.title || '',
      description: values.description || '',
      mode: values.mode || 'document',
    },
    limits: {
      maxDocMb: files.MAX_DOC_BYTES / 1024 / 1024,
      maxImageMb: files.MAX_IMAGE_BYTES / 1024 / 1024,
      maxImagesTotalMb: files.MAX_IMAGES_TOTAL_BYTES / 1024 / 1024,
      maxImages: files.MAX_IMAGES,
    },
  };
}

router.get('/new', (c) => render(c, 'drafts/new', newLocals()));

/* ---------------- step 1: create ---------------- */

router.post('/', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const wantsJson =
    String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(c.req.header('accept') || '').includes('application/json');

  const declared = Number(c.req.header('content-length') || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    const message = `That upload is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`;
    return wantsJson
      ? c.json({ ok: false, errors: [message] }, 413, NO_STORE)
      : render(c, 'drafts/new', newLocals([message]), 413);
  }

  const { fields, files: parts } = await getFormData(c);
  const title = String(field(fields, 'title') || '').trim().slice(0, 160);
  const description = String(field(fields, 'description') || '').trim().slice(0, 2000);
  const mode = field(fields, 'mode') === 'images' ? 'images' : 'document';
  const docFiles = parts.document || [];
  const imageFiles = parts.images || [];

  const errors = [];
  if (!title) errors.push('Give the draft a title so people know what they are opening.');

  let kind = null;
  /** [{ file, ext, bytes }] in the order they will be written. */
  let ordered = [];

  if (!errors.length && mode === 'document') {
    if (docFiles.length !== 1) {
      errors.push('Choose one document file (.docx, .pdf, .txt or .md).');
    } else {
      const file = docFiles[0];
      const ext = files.extname(file.name);
      kind = files.DOC_KINDS[ext] || null;
      if (!kind) {
        errors.push('That file type is not supported. Upload a .docx, .pdf, .txt or .md file.');
      } else if (file.size > files.MAX_DOC_BYTES) {
        errors.push(`Documents are limited to ${files.MAX_DOC_BYTES / 1024 / 1024} MB.`);
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const complaint = files.sniff(ext, bytes);
        if (complaint) errors.push(`“${toPlainText(file.name, 80)}” ${complaint}`);
        else ordered = [{ file, ext, bytes }];
      }
    }
  } else if (!errors.length) {
    kind = 'images';
    if (!imageFiles.length) {
      errors.push('Choose the page images for the sequence (JPG, PNG or WebP).');
    } else {
      const limit = files.limitError('images', imageFiles);
      if (limit) errors.push(limit);
      else {
        const sorted = imageFiles.slice().sort(files.byFilename);
        for (const file of sorted) {
          const ext = files.extname(file.name);
          const name = toPlainText(file.name, 80);
          if (!files.IMAGE_EXTS.has(ext)) {
            errors.push(`“${name}” is not a JPG, PNG or WebP.`);
            continue;
          }
          if (file.size > files.MAX_IMAGE_BYTES) {
            errors.push(`“${name}” is larger than ${files.MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const complaint = files.sniff(ext, bytes);
          if (complaint) errors.push(`“${name}” ${complaint}`);
          else ordered.push({ file, ext, bytes });
        }
        // Rule 3: nothing is written unless EVERY file in the submit passed.
        if (errors.length) ordered = [];
      }
    }
  }

  if (errors.length) {
    return wantsJson
      ? c.json({ ok: false, errors }, 400, NO_STORE)
      : render(c, 'drafts/new', newLocals(errors, { title, description, mode }), 400);
  }

  /* ---- the row and its thread, then the bytes ----
   * ONE BATCH, the same restructuring worker/src/routes/board.js documents:
   * D1 has no interactive transaction, so the draft and the discussion thread
   * that belongs to it go in together with the thread naming its parent through
   * last_insert_rowid(). No window exists in which a draft has no conversation.
   *
   * (The thread is created HERE and not at finalize, matching Express: a draft
   * that is still converting — or that failed — still has a conversation
   * section in the reader and a Conversation link in the library. Making it a
   * finalize-time write would have been a visible behaviour change for exactly
   * the drafts their uploader most wants to talk about.)
   */
  const originalName =
    kind === 'images'
      ? `${ordered.length} page image${ordered.length === 1 ? '' : 's'}`
      : String(ordered[0].file.name || '').slice(0, 200);
  const originalRel = kind === 'images' ? null : files.originalRel(ordered[0].ext);

  const created = await db.batch([
    stmt(
      db,
      `INSERT INTO drafts (user_id, title, description, kind, status, original_filename, original_path)
       VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
      user.id,
      title,
      description || null,
      kind,
      originalName,
      originalRel
    ),
    stmt(
      db,
      `INSERT INTO threads (title, user_id, draft_id, last_post_at)
       VALUES (?, ?, last_insert_rowid(), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      title,
      user.id
    ),
  ]);
  const draftId = Number(created[0].meta.last_row_id);

  const written = [];
  try {
    if (kind === 'images') {
      /*
       * The image page ROWS are written here rather than at finalize, because
       * the server — not the client — owns which object is page 3. file_path
       * comes out of attachments.pageRel(), never off the wire; finalize only
       * ever fills in the width/height it could not measure.
       */
      const rows = [];
      for (let i = 0; i < ordered.length; i += 1) {
        const rel = files.pageRel(i + 1, ordered[i].ext);
        await files.put(c.env, draftId, rel, ordered[i].bytes, files.IMAGE_MIME[ordered[i].ext]);
        written.push(rel);
        rows.push(
          stmt(
            db,
            `INSERT INTO draft_pages (draft_id, page_number, kind, file_path)
             VALUES (?, ?, 'image', ?)`,
            draftId,
            i + 1,
            rel
          )
        );
      }
      for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
        await db.batch(rows.slice(i, i + ROWS_PER_BATCH));
      }
    } else {
      await files.put(c.env, draftId, originalRel, ordered[0].bytes, mimeForExt(ordered[0].ext));
      written.push(originalRel);
    }
  } catch (err) {
    console.error('[afwc] draft upload failed:', err);
    await files.unlink(c.env, draftId, written);
    await markFailed(db, draftId, 'The upload could not be stored. Please try again.');
    const message = 'We could not store that upload. Please try again.';
    return wantsJson
      ? c.json({ ok: false, errors: [message] }, 500, NO_STORE)
      : render(c, 'drafts/new', newLocals([message], { title, description, mode }), 500);
  }

  flash(c, 'ok', 'Uploaded. Converting it for the reader now — this page updates itself.');
  const location = `/drafts/${draftId}`;
  if (wantsJson) return c.json({ ok: true, id: draftId, redirect: location }, 201, NO_STORE);
  return c.redirect(location, 302);
});

/* ---------------- step 2: page batches ---------------- */

router.post('/:id/pages', async (c) => {
  const db = c.env.DB;
  const got = await protocolDraft(c);
  if (got.error) return got.error;
  const draft = got.draft;

  if (draft.kind !== 'docx' && draft.kind !== 'text') {
    return jsonFail(c, 400, 'That draft does not take page content.');
  }

  const read = await readJsonBody(c);
  if (read.error) return read.error;

  const pages = Array.isArray(read.body.pages) ? read.body.pages : null;
  if (!pages || !pages.length) return jsonFail(c, 400, 'That batch had no pages in it.');
  if (pages.length > MAX_PAGES_PER_BATCH) {
    return jsonFail(c, 413, `Send at most ${MAX_PAGES_PER_BATCH} pages per batch.`);
  }

  const rows = [];
  for (const page of pages) {
    if (!page || typeof page !== 'object') return jsonFail(c, 400, 'That batch had a malformed page.');
    const n = Number(page.page_number);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES) {
      return jsonFail(c, 400, 'That batch had a page number outside the range we allow.');
    }
    if (page.kind !== 'html') return jsonFail(c, 400, 'Only converted HTML pages go through this route.');

    /*
     * THE TRUST BOUNDARY, in one line. The client converted this; the client
     * does not get to decide what it contains. Same allowlist as announcements,
     * board posts and comments — see worker/src/util/sanitize.js.
     */
    const html = cleanHtml(String(page.content_html == null ? '' : page.content_html));
    const heading = page.heading == null ? null : toPlainText(String(page.heading), 120) || null;

    rows.push(
      stmt(
        db,
        `INSERT INTO draft_pages (draft_id, page_number, kind, content_html, heading)
         VALUES (?, ?, 'html', ?, ?)
         ON CONFLICT(draft_id, page_number) DO UPDATE
            SET kind = 'html', content_html = excluded.content_html, heading = excluded.heading,
                file_path = NULL, width = NULL, height = NULL`,
        draft.id,
        n,
        html,
        heading
      )
    );
  }

  // The touch keeps a slow-but-alive upload out of the stale-processing sweep.
  rows.push(touchDraft(db, draft.id));
  await db.batch(rows);

  return c.json({ ok: true, stored: rows.length - 1 }, 200, NO_STORE);
});

/* ---------------- step 3: finalize ---------------- */

router.post('/:id/finalize', async (c) => {
  const db = c.env.DB;
  const got = await protocolDraft(c);
  if (got.error) return got.error;
  const draft = got.draft;

  const read = await readJsonBody(c);
  if (read.error) return read.error;

  const pageCount = Number(read.body.page_count);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    return jsonFail(c, 400, `A draft has between 1 and ${MAX_PAGES} pages.`);
  }

  /* -- html kinds: COUNT THE ROWS WE HOLD, and refuse a gap -- */
  if (draft.kind === 'docx' || draft.kind === 'text') {
    const stats = await q.pageStats(db, draft.id);
    const n = stats ? Number(stats.n) : 0;
    if (n !== pageCount || Number(stats.lo) !== 1 || Number(stats.hi) !== pageCount) {
      const message = `Only ${n} of ${pageCount} pages arrived. Please upload the file again.`;
      await markFailed(db, draft.id, message);
      return jsonFail(c, 409, message);
    }
    await db.batch([readyStmt(db, draft.id, pageCount)]);
    return c.json({ ok: true, id: draft.id, page_count: pageCount, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
  }

  /* -- pdf: the rows ARE the submitted geometry (see the trust note up top) -- */
  if (draft.kind === 'pdf') {
    const sizes = normalizeSizes(read.body.sizes, pageCount);
    if (!sizes) return jsonFail(c, 400, 'Those page dimensions did not match the page count.');

    await db.batch([stmt(db, 'DELETE FROM draft_pages WHERE draft_id = ?', draft.id)]);
    const rows = sizes.map(([w, h], i) =>
      stmt(
        db,
        `INSERT INTO draft_pages (draft_id, page_number, kind, width, height)
         VALUES (?, ?, 'pdf_page', ?, ?)`,
        draft.id,
        i + 1,
        w,
        h
      )
    );
    for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
      const chunk = rows.slice(i, i + ROWS_PER_BATCH);
      if (i + ROWS_PER_BATCH >= rows.length) chunk.push(readyStmt(db, draft.id, pageCount));
      await db.batch(chunk);
    }
    return c.json({ ok: true, id: draft.id, page_count: pageCount, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
  }

  /* -- images: the rows already exist; finalize only measures them -- */
  const stats = await q.pageStats(db, draft.id);
  const n = stats ? Number(stats.n) : 0;
  if (n !== pageCount) {
    const message = `We stored ${n} page images, not ${pageCount}. Please upload them again.`;
    await markFailed(db, draft.id, message);
    return jsonFail(c, 409, message);
  }
  const sizes = normalizeSizes(read.body.sizes, pageCount);
  if (!sizes) return jsonFail(c, 400, 'Those page dimensions did not match the page count.');

  const rows = sizes.map(([w, h], i) =>
    stmt(
      db,
      'UPDATE draft_pages SET width = ?, height = ? WHERE draft_id = ? AND page_number = ?',
      w,
      h,
      draft.id,
      i + 1
    )
  );
  for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
    const chunk = rows.slice(i, i + ROWS_PER_BATCH);
    if (i + ROWS_PER_BATCH >= rows.length) chunk.push(readyStmt(db, draft.id, pageCount));
    await db.batch(chunk);
  }
  return c.json({ ok: true, id: draft.id, page_count: pageCount, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
});

const readyStmt = (db, id, pageCount) =>
  stmt(
    db,
    `UPDATE drafts SET status = 'ready', page_count = ?, error_msg = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    pageCount,
    id
  );

/**
 * `[[w,h], …]` of exactly `count` entries, each bounded or null. A missing or
 * unreadable dimension is legal — src/services/ingest/images.js wrote NULLs for
 * an image it could not measure and the viewer falls back — so `null` survives,
 * but a number outside the bounds does not.
 */
function normalizeSizes(raw, count) {
  if (raw == null) return Array.from({ length: count }, () => [null, null]);
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const out = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const dims = pair.map((v) => {
      if (v == null) return null;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > MAX_DIMENSION) return null;
      return n;
    });
    out.push(dims);
  }
  return out;
}

/* ---------------- step 4: the client's conversion failed ---------------- */

router.post('/:id/fail', async (c) => {
  const got = await protocolDraft(c);
  if (got.error) return got.error;
  const draft = got.draft;

  const read = await readJsonBody(c);
  if (read.error) return read.error;

  const message =
    FAIL_REASONS[String(read.body.reason || '')] ||
    FAIL_REASONS[draft.kind] ||
    'Conversion failed.';
  await markFailed(c.env.DB, draft.id, message);
  return c.json({ ok: true, id: draft.id, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
});

/* ---------------- retry & delete ---------------- */

/**
 * See the file header: retry is now re-upload. The button in views/drafts/*.ejs
 * is shared with Express, so it keeps working and keeps its meaning ("get this
 * draft converted") — it just cannot do it from the original any more.
 */
router.post('/:id/retry', async (c) => {
  const draft = await q.byId(c.env.DB, Number(c.req.param('id')));
  if (!draft) throw new HttpError(404, 'That draft is not here.');
  if (!canManage(c.get('currentUser'), draft)) {
    throw new HttpError(403, 'Only the person who uploaded this (or a leader) can retry it.');
  }
  flash(
    c,
    'info',
    'Conversion now happens in your own browser, so a retry means uploading the file again — nothing else was lost.'
  );
  return c.redirect('/drafts/new', 302);
});

router.post('/:id/delete', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const draft = await q.byId(db, Number(c.req.param('id')));
  if (!draft) throw new HttpError(404, 'That draft is not here.');
  if (!canManage(user, draft)) {
    throw new HttpError(403, 'Only the person who uploaded this (or a leader) can remove it.');
  }

  // db.transaction(() => { softDelete; softDeleteThreads }) → one batch.
  await db.batch([
    stmt(
      db,
      `UPDATE drafts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      user.id,
      draft.id
    ),
    stmt(
      db,
      `UPDATE threads SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE draft_id = ? AND deleted_at IS NULL`,
      user.id,
      draft.id
    ),
  ]);

  flash(c, 'ok', `“${draft.title}” has been removed from the library.`);
  return c.redirect('/drafts', 302);
});

export default router;
