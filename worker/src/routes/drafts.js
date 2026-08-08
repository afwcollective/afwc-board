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
 *                                   D1 batch, then writes the originals to the
 *                                   file store (also D1 — see
 *                                   worker/src/services/filestore.js).
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
 * THE SAME FOUR STEPS ALSO REPLACE THE FILE UNDER AN EXISTING DRAFT. The edit
 * page's swap control (POST /:id/file) is step 1 with a different URL and a
 * draft that already exists; steps 2–4 are literally these routes, and
 * public/js/upload-cf.js drives both without knowing which it is doing. What
 * changes is WHERE the half-built replacement goes: while a swap is in flight
 * there is a draft_swaps row, and pages land in draft_page_staging and bytes
 * under a `swap/` stored-name prefix, so the draft's live pages and files are
 * untouched until finalize promotes the whole thing in ONE D1 batch. A swap
 * that fails leaves the draft exactly as it was, marked 'failed', and
 * POST /:id/retry puts the status back (see draftPagesIntact in
 * worker/src/db.js). The reasoning is written out in full in
 * worker/migrations/0005_draft_swap.sql.
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

import { one, all, run, stmt, draftPagesIntact } from '../db.js';
import { requireMember, HttpError } from '../auth/middleware.js';
import { isLeaderUser, isArchitectUser } from '../auth/roles.js';
import { flash } from '../util/flash.js';
import { cleanHtml, toPlainText } from '../util/sanitize.js';
import { getFormData, getBody, field } from '../util/body.js';
import { render } from '../render.js';
import * as files from '../services/drafts/attachments.js';
import * as retention from '../services/retention.js';
import * as ratelimit from '../util/ratelimit.js';

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

/** The pen-name / author-credit field on the upload form and its edit route. */
const MAX_AUTHOR_CHARS = 80;

/** The upload form's own two limits, so the edit route clamps identically. */
const MAX_TITLE_CHARS = 160;
const MAX_DESC_CHARS = 2000;

/** The discussion topic (threads.title). A thread title never had a limit of
 *  its own — it was always the draft's title, so the draft's limit is the
 *  honest one. */
const MAX_TOPIC_CHARS = 160;

/**
 * Strip tags, trim, clamp to MAX_AUTHOR_CHARS, and fold an empty result to
 * `null` — NULL is what COALESCE-in-the-template (`author_name ||
 * uploader_name`) treats as "nothing was set, use the display name". Runs
 * through the same house allowlist as everything else user-typed, so a
 * hand-crafted `<script>` in this field is inert before it ever reaches the
 * database, not merely escaped on the way back out. Port of
 * src/routes/drafts.js's sanitizeAuthorName, verbatim.
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
 * Port of src/routes/drafts.js's sanitizeTopic, verbatim.
 */
function sanitizeTopic(raw) {
  const clean = toPlainText(String(raw == null ? '' : raw)).trim().slice(0, MAX_TOPIC_CHARS);
  return clean || null;
}

/**
 * The upload multipart body cap, checked from Content-Length before anything is
 * parsed. Slack over the image total covers the multipart framing and the text
 * fields; a document submit is bounded by MAX_DOC_BYTES on the part itself.
 */
const MAX_UPLOAD_BYTES = files.MAX_IMAGES_TOTAL_BYTES + 2 * 1024 * 1024;

/**
 * Rate ceilings (P5) — anti-runaway, not a meter on normal use. A real upload
 * of the biggest sequence this app allows (2000 pages, MAX_PAGES) sends
 * ceil(2000 / MAX_PAGES_PER_BATCH) = 167 page batches; 120/hour undershoots
 * that on paper, which is fine — nobody uploads a 2000-page docx by hand, and
 * PORT-CLOUDFLARE.md's own worked example (a 60-page image draft) sends ONE
 * POST / and no page batches at all (image rows are written inline — see the
 * "images" branch below), while a 60-page docx sends ceil(60/12) = 5 batches,
 * nowhere near either ceiling. Both are keyed to the uploader, not the draft,
 * so ten drafts an hour or twelve batches a minute is a person, not a file.
 */
const DRAFT_CREATE_MAX = 10;
const DRAFT_CREATE_WINDOW = ratelimit.HOUR_MS;
const PAGE_BATCH_MAX = 120;
const PAGE_BATCH_WINDOW = ratelimit.HOUR_MS;

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

/**
 * Tacked onto the diagnosis above when what failed was a REPLACEMENT file
 * rather than a first upload. It is true because of the staging arrangement:
 * nothing the draft already had is touched until the new pages exist.
 */
const SWAP_RECOVERY = 'The draft’s previous pages are still on file — “Try converting again” puts them back.';

/* ---------------- queries (route-local by convention) ---------------- */

const q = {
  library: (db, userId, isLeader) =>
    all(
      db,
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
        ORDER BY d.created_at DESC`,
      userId,
      isLeader
    ),
  byId: (db, id) => one(db, 'SELECT * FROM drafts WHERE id = ? AND deleted_at IS NULL', id),
  /*
   * The gap check finalize runs, over whichever table this upload is filling.
   * `table` is one of two literals chosen a few lines from here by a boolean,
   * never anything off the wire — see pagesTable().
   */
  pageStats: (db, table, id) =>
    one(
      db,
      `SELECT COUNT(*) AS n, MIN(page_number) AS lo, MAX(page_number) AS hi
         FROM ${table} WHERE draft_id = ?`,
      id
    ),
  /* -- the draft's discussion thread: read for the topic field, renamed by it -- */
  threadForDraft: (db, id) =>
    one(
      db,
      'SELECT id, title FROM threads WHERE draft_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
      id
    ),
  /* -- a file swap in flight, or null. The discriminator for steps 2–4. -- */
  swap: (db, id) => one(db, 'SELECT * FROM draft_swaps WHERE draft_id = ?', id),
};

/**
 * WHERE THIS UPLOAD'S PAGES GO. A first upload fills draft_pages directly; a
 * file swap fills draft_page_staging and only becomes the draft's pages at
 * finalize. Both tables are column-identical (worker/migrations/0005), which is
 * why one set of statements can serve both with the name substituted — and the
 * name is one of exactly two constants picked by a boolean, so nothing user-
 * supplied is ever spliced into SQL text.
 */
const pagesTable = (swap) => (swap ? 'draft_page_staging' : 'draft_pages');

const canManage = (user, draft) => !!user && (user.id === draft.user_id || isLeaderUser(user));

/**
 * EDITING A DRAFT IS THE UPLOADER'S OWN CALL, not a leader override. A leader
 * can still remove a whole draft (moderation) and retry its conversion, but
 * cannot rewrite the title, the byline, the discussion topic, or — least of all
 * — the file itself on someone else's work. The one exception is the architect,
 * the board's single god-mode account (worker/src/auth/roles.js): every other
 * permission check in this file gives leader and architect the same power via
 * canManage() (isLeaderUser is true for both), and this one deliberately does
 * not. A plain leader gets 403 on every route below that uses it, same as any
 * other member.
 *
 * This started life as canEditAuthor() guarding one field. It guards the whole
 * edit surface now and the rule has not moved an inch. Port of
 * src/routes/drafts.js's canEditDraft, verbatim.
 */
const canEditDraft = (user, draft) => !!user && (user.id === draft.user_id || isArchitectUser(user));

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
 *
 * ALSO RETURNS THE SWAP ROW, or null. That single lookup is what tells steps
 * 2–4 apart from their first-upload selves — which table the pages go in, which
 * kind they are being converted to, and what has to be cleaned up if it all
 * goes wrong. `kind` is resolved here too so no step has to remember that a
 * draft mid-swap is not yet the kind it is becoming.
 *
 * The AUTHORITY here stays canManage(), not canEditDraft(). It is deliberately
 * the looser of the two and has to be, because these routes finish an upload
 * that POST /drafts already accepted from anyone. POST /:id/file — the only way
 * to START a swap — is the narrow gate, so a plain leader can never bring one
 * of these into existence in the first place.
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
  const swap = await q.swap(db, draft.id);
  return { draft, swap, kind: swap ? swap.kind : draft.kind };
}

/**
 * Everything a failed or abandoned swap leaves behind, removed: the staged
 * bytes, the staged pages, and the row that made the protocol treat this draft
 * as mid-swap. The draft's OWN pages and files are not in any of these three
 * statements — that is the point of the whole arrangement.
 */
async function discardSwap(c, draftId) {
  const db = c.env.DB;
  await files.discardStaged(c.env, draftId);
  await db.batch([
    stmt(db, 'DELETE FROM draft_page_staging WHERE draft_id = ?', draftId),
    stmt(db, 'DELETE FROM draft_swaps WHERE draft_id = ?', draftId),
  ]);
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
async function newLocals(c, errors = [], values = {}) {
  const days = await retention.retentionDays(c.env.DB);
  return {
    title: 'Share a draft',
    pageCss: ['/css/drafts.css'],
    pageJs: ['/vendor/afwc/paginate.js', '/js/upload-cf.js'],
    errors,
    values: {
      title: values.title || '',
      description: values.description || '',
      mode: values.mode || 'document',
      authorName: values.authorName || '',
    },
    limits: {
      maxDocMb: files.MAX_DOC_BYTES / 1024 / 1024,
      maxImageMb: files.MAX_IMAGE_BYTES / 1024 / 1024,
      maxImagesTotalMb: files.MAX_IMAGES_TOTAL_BYTES / 1024 / 1024,
      maxImages: files.MAX_IMAGES,
      maxAuthorChars: MAX_AUTHOR_CHARS,
    },
    /*
     * The one local views/drafts/new.ejs takes that Express does not set — see
     * the guard in that template. The sentence is built here so the NUMBER is
     * whatever a leader has actually set on /admin, not a hardcoded year that
     * could quietly become a lie.
     */
    retentionNote:
      days === 365
        ? 'Shared files are kept for a year, then cleaned up automatically.'
        : `Shared files are kept for ${days} days, then cleaned up automatically.`,
  };
}

router.get('/new', async (c) => render(c, 'drafts/new', await newLocals(c)));

/* ---------------- what makes a submit acceptable ---------------- */

/**
 * Extension → size → magic bytes, on the bytes in hand, for EVERY file in the
 * submit, before anything is written — rule 3, and the reason it is a function
 * is that TWO routes now need it: POST / (a new draft) and POST /:id/file
 * (replacing the file under one that exists). "Same kind constraints as upload"
 * has to be one function or it is only a promise.
 *
 * Returns `{ errors, kind, ordered }`, where `ordered` is `[{ file, ext, bytes }]`
 * in the order it will be written and is EMPTY unless every file passed.
 */
async function validateSubmit(parts, mode) {
  const docFiles = parts.document || [];
  const imageFiles = parts.images || [];
  const errors = [];
  let kind = null;
  let ordered = [];

  if (mode === 'document') {
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
    return { errors, kind, ordered };
  }

  kind = 'images';
  if (!imageFiles.length) {
    errors.push('Choose the page images for the sequence (JPG, PNG or WebP).');
    return { errors, kind, ordered };
  }
  const limit = files.limitError('images', imageFiles);
  if (limit) {
    errors.push(limit);
    return { errors, kind, ordered };
  }
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
  return { errors, kind, ordered };
}

/**
 * Writes the validated originals — and, for a page sequence, every page image —
 * into the file store, either at their live addresses or behind the swap
 * staging prefix.
 *
 * `pages` comes back as plain rows rather than statements because the caller
 * owns which TABLE they belong in, and their file_path is always the CANONICAL
 * `pages/0001.png` even when the bytes are staged at `swap/pages/0001.png`.
 * That is not sloppiness: promotion renames the file down onto the canonical
 * name, so the row is written once and is simply not true yet.
 *
 * Rule 1 is intact throughout — every address is composed by
 * services/drafts/attachments.js from a validated id and a name this app
 * generated, and the ORDER is the server's (files.byFilename), never the
 * client's.
 */
async function storeOriginals(env, draftId, kind, ordered, stage) {
  const written = [];
  const pages = [];
  const at = (rel) => (stage ? files.staged(rel) : rel);

  if (kind === 'images') {
    for (let i = 0; i < ordered.length; i += 1) {
      const rel = files.pageRel(i + 1, ordered[i].ext);
      await files.put(env, draftId, at(rel), ordered[i].bytes, files.IMAGE_MIME[ordered[i].ext]);
      written.push(at(rel));
      pages.push({ page_number: i + 1, file_path: rel });
    }
    return { written, pages, originalRel: null };
  }

  const rel = files.originalRel(ordered[0].ext);
  await files.put(env, draftId, at(rel), ordered[0].bytes, mimeForExt(ordered[0].ext));
  written.push(at(rel));
  return { written, pages, originalRel: rel };
}

/** What drafts.original_filename records, for either kind of submit. */
const originalNameFor = (kind, ordered) =>
  kind === 'images'
    ? `${ordered.length} page image${ordered.length === 1 ? '' : 's'}`
    : String(ordered[0].file.name || '').slice(0, 200);

/* ---------------- step 1: create ---------------- */

router.post('/', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const wantsJson =
    String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(c.req.header('accept') || '').includes('application/json');

  if (!(await ratelimit.checkRate(db, 'drafts_post', user.id, DRAFT_CREATE_MAX, DRAFT_CREATE_WINDOW))) {
    const message = "You've shared a lot of drafts in the last hour — take a short break and try again soon.";
    return wantsJson
      ? c.json({ ok: false, errors: [message] }, 429, NO_STORE)
      : render(c, 'drafts/new', await newLocals(c, [message]), 429);
  }

  const declared = Number(c.req.header('content-length') || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    const message = `That upload is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`;
    return wantsJson
      ? c.json({ ok: false, errors: [message] }, 413, NO_STORE)
      : render(c, 'drafts/new', await newLocals(c, [message]), 413);
  }

  const { fields, files: parts } = await getFormData(c);
  const title = String(field(fields, 'title') || '').trim().slice(0, MAX_TITLE_CHARS);
  const description = String(field(fields, 'description') || '').trim().slice(0, MAX_DESC_CHARS);
  const authorName = sanitizeAuthorName(field(fields, 'author_name'));
  const mode = field(fields, 'mode') === 'images' ? 'images' : 'document';

  const submit = await validateSubmit(parts, mode);
  const { kind, ordered } = submit;
  const errors = submit.errors;
  if (!title) errors.unshift('Give the draft a title so people know what they are opening.');

  if (errors.length) {
    return wantsJson
      ? c.json({ ok: false, errors }, 400, NO_STORE)
      : render(c, 'drafts/new', await newLocals(c, errors, { title, description, mode, authorName }), 400);
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
  const originalName = originalNameFor(kind, ordered);
  const originalRel = kind === 'images' ? null : files.originalRel(ordered[0].ext);

  const created = await db.batch([
    stmt(
      db,
      `INSERT INTO drafts (user_id, title, description, kind, status, original_filename, original_path, author_name)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
      user.id,
      title,
      description || null,
      kind,
      originalName,
      originalRel,
      authorName
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

  let written = [];
  try {
    /*
     * The image page ROWS are written here rather than at finalize, because the
     * server — not the client — owns which object is page 3. file_path comes
     * out of attachments.pageRel(), never off the wire; finalize only ever
     * fills in the width/height it could not measure.
     */
    const stored = await storeOriginals(c.env, draftId, kind, ordered, false);
    written = stored.written;
    const rows = stored.pages.map((p) =>
      stmt(
        db,
        `INSERT INTO draft_pages (draft_id, page_number, kind, file_path)
         VALUES (?, ?, 'image', ?)`,
        draftId,
        p.page_number,
        p.file_path
      )
    );
    for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
      await db.batch(rows.slice(i, i + ROWS_PER_BATCH));
    }
  } catch (err) {
    console.error('[afwc] draft upload failed:', err);
    await files.unlink(c.env, draftId, written);
    await markFailed(db, draftId, 'The upload could not be stored. Please try again.');
    const message = 'We could not store that upload. Please try again.';
    return wantsJson
      ? c.json({ ok: false, errors: [message] }, 500, NO_STORE)
      : render(c, 'drafts/new', await newLocals(c, [message], { title, description, mode, authorName }), 500);
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
  const table = pagesTable(got.swap);

  const user = c.get('currentUser');
  if (!(await ratelimit.checkRate(db, 'drafts_pages', user.id, PAGE_BATCH_MAX, PAGE_BATCH_WINDOW))) {
    return jsonFail(
      c,
      429,
      'Pages are arriving faster than we can store them right now. Pause a moment — the rest of this upload will go through once the limit resets.'
    );
  }

  // got.kind, not draft.kind: mid-swap the draft is not yet what it is becoming.
  if (got.kind !== 'docx' && got.kind !== 'text') {
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
        `INSERT INTO ${table} (draft_id, page_number, kind, content_html, heading)
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
  const { draft, swap, kind } = got;
  const table = pagesTable(swap);
  const failSwap = (message) => (swap ? `${message} ${SWAP_RECOVERY}` : message);

  const read = await readJsonBody(c);
  if (read.error) return read.error;

  const pageCount = Number(read.body.page_count);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    return jsonFail(c, 400, `A draft has between 1 and ${MAX_PAGES} pages.`);
  }

  /* -- html kinds: COUNT THE ROWS WE HOLD, and refuse a gap -- */
  if (kind === 'docx' || kind === 'text') {
    const stats = await q.pageStats(db, table, draft.id);
    const n = stats ? Number(stats.n) : 0;
    if (n !== pageCount || Number(stats.lo) !== 1 || Number(stats.hi) !== pageCount) {
      const message = `Only ${n} of ${pageCount} pages arrived. Please upload the file again.`;
      if (swap) await discardSwap(c, draft.id);
      await markFailed(db, draft.id, failSwap(message));
      return jsonFail(c, 409, message);
    }
    await db.batch(finishStmts(db, draft, swap, pageCount));
    return c.json({ ok: true, id: draft.id, page_count: pageCount, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
  }

  /* -- pdf: the rows ARE the submitted geometry (see the trust note up top) -- */
  if (kind === 'pdf') {
    const sizes = normalizeSizes(read.body.sizes, pageCount);
    if (!sizes) return jsonFail(c, 400, 'Those page dimensions did not match the page count.');

    await db.batch([stmt(db, `DELETE FROM ${table} WHERE draft_id = ?`, draft.id)]);
    const rows = sizes.map(([w, h], i) =>
      stmt(
        db,
        `INSERT INTO ${table} (draft_id, page_number, kind, width, height)
         VALUES (?, ?, 'pdf_page', ?, ?)`,
        draft.id,
        i + 1,
        w,
        h
      )
    );
    await writeThenFinish(db, rows, draft, swap, pageCount);
    return c.json({ ok: true, id: draft.id, page_count: pageCount, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
  }

  /* -- images: the rows already exist; finalize only measures them -- */
  const stats = await q.pageStats(db, table, draft.id);
  const n = stats ? Number(stats.n) : 0;
  if (n !== pageCount) {
    const message = `We stored ${n} page images, not ${pageCount}. Please upload them again.`;
    if (swap) await discardSwap(c, draft.id);
    await markFailed(db, draft.id, failSwap(message));
    return jsonFail(c, 409, message);
  }
  const sizes = normalizeSizes(read.body.sizes, pageCount);
  if (!sizes) return jsonFail(c, 400, 'Those page dimensions did not match the page count.');

  const rows = sizes.map(([w, h], i) =>
    stmt(
      db,
      `UPDATE ${table} SET width = ?, height = ? WHERE draft_id = ? AND page_number = ?`,
      w,
      h,
      draft.id,
      i + 1
    )
  );
  await writeThenFinish(db, rows, draft, swap, pageCount);
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
 * THE LAST BATCH OF EITHER JOURNEY.
 *
 * A first upload finishes in one statement: flip the draft to 'ready'.
 *
 * A SWAP FINISHES IN SEVEN, and they are in one D1 batch because a batch is
 * atomic and two awaits are not — the gap between them is exactly where a
 * reader would find a draft whose rows and bytes disagree. In order:
 *
 *   1–2. the file store: delete every unprefixed file under this draft (the
 *        OLD original, the OLD page images, chunks and all by cascade), then
 *        rename the staged ones down onto the names just vacated. NO BYTES
 *        MOVE and NO ORPHAN IS POSSIBLE — see filestore.promoteStmts().
 *   3–4. the pages: the live set goes, the staged set is copied into its place
 *        with its page numbers and canonical file_paths intact.
 *     5. the staging table is emptied.
 *     6. the draft row takes on the replacement's kind, page count, filename
 *        and original path, and goes 'ready'. THE KIND MAY HAVE CHANGED; this
 *        is where a Word draft becomes a PDF.
 *     7. the swap row goes, which is what makes the draft an ordinary draft
 *        again as far as every route in this file is concerned.
 *
 * comments is not in this list, deliberately and loudly: page comments keep
 * their draft_id and their page_number across a swap. See POST /:id/file.
 */
function finishStmts(db, draft, swap, pageCount) {
  if (!swap) return [readyStmt(db, draft.id, pageCount)];
  const [dropOldFiles, promoteStagedFiles] = files.promoteStagedStmts(db, draft.id);
  return [
    dropOldFiles,
    promoteStagedFiles,
    stmt(db, 'DELETE FROM draft_pages WHERE draft_id = ?', draft.id),
    stmt(
      db,
      `INSERT INTO draft_pages (draft_id, page_number, kind, content_html, file_path, width, height, heading)
       SELECT draft_id, page_number, kind, content_html, file_path, width, height, heading
         FROM draft_page_staging WHERE draft_id = ? ORDER BY page_number`,
      draft.id
    ),
    stmt(db, 'DELETE FROM draft_page_staging WHERE draft_id = ?', draft.id),
    stmt(
      db,
      `UPDATE drafts SET kind = ?, page_count = ?, original_filename = ?, original_path = ?,
              status = 'ready', error_msg = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      swap.kind,
      pageCount,
      swap.original_filename,
      swap.original_path,
      draft.id
    ),
    stmt(db, 'DELETE FROM draft_swaps WHERE draft_id = ?', draft.id),
  ];
}

/**
 * Page rows in ROWS_PER_BATCH batches, then the finish. The finish rides along
 * with the last batch when the rows fit in one trip (the common case, and the
 * one where atomicity is free); a 2000-page PDF gets its own final batch, which
 * is still atomic in itself — the promotion never straddles two.
 */
async function writeThenFinish(db, rows, draft, swap, pageCount) {
  const finish = finishStmts(db, draft, swap, pageCount);
  for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
    const chunk = rows.slice(i, i + ROWS_PER_BATCH);
    if (i + ROWS_PER_BATCH >= rows.length && chunk.length + finish.length <= ROWS_PER_BATCH) {
      await db.batch(chunk.concat(finish));
      return;
    }
    await db.batch(chunk);
  }
  await db.batch(finish);
}

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
  const { draft, swap, kind } = got;

  const read = await readJsonBody(c);
  if (read.error) return read.error;

  const message =
    FAIL_REASONS[String(read.body.reason || '')] ||
    FAIL_REASONS[kind] ||
    'Conversion failed.';

  /*
   * A FAILED SWAP TAKES NOTHING WITH IT. The staged bytes and staged pages go;
   * the draft's own pages, files, kind and page_count were never touched. What
   * the member sees is the ordinary failed card — with the sentence below, and
   * a "Try converting again" button that here means "put the draft back", which
   * POST /:id/retry can honour precisely because none of it was lost.
   */
  if (swap) await discardSwap(c, draft.id);
  await markFailed(c.env.DB, draft.id, swap ? `${message} ${SWAP_RECOVERY}` : message);
  return c.json({ ok: true, id: draft.id, redirect: `/drafts/${draft.id}` }, 200, NO_STORE);
});

/* ---------------- edit ----------------
 *
 * UPLOADER (OR THE ARCHITECT) ONLY — deliberately narrower than retry/delete
 * below, which any leader can also do. A leader moderates (removes a draft that
 * should not be here); they do not get to retitle, re-credit, re-topic or
 * REPLACE THE FILE UNDER someone else's work. canEditDraft(), not canManage(),
 * guards all three routes here — a plain leader gets 403 exactly like any other
 * member, on the GET as well as the POSTs. Port of src/routes/drafts.js's
 * GET/POST /:id/edit and POST /:id/file.
 *
 * Four things live on this page and three of them are ordinary form fields:
 * title and description (the upload form's own, with its own limits), the
 * byline, and the DISCUSSION TOPIC — threads.title for the thread this draft
 * owns, where blank resets it to the draft's title because that is what upload
 * set it to. The fourth is the file itself, below.
 */

/** The one shape both GET /:id/edit and a re-rendered POST hand the template. */
async function editLocals(c, draft, { errors = [], values = null } = {}) {
  const thread = await q.threadForDraft(c.env.DB, draft.id);
  return {
    title: `Edit — ${draft.title}`,
    pageCss: ['/css/drafts.css'],
    /*
     * The UPLOAD page's script list, unchanged, for the reason in the header of
     * public/js/upload-cf.js: #swap-form is #upload-form with a different
     * action, and steps 2–4 of the protocol are the same three routes. Express
     * hands this template ['/js/upload.js'] for the same reason.
     */
    pageJs: ['/vendor/afwc/paginate.js', '/js/upload-cf.js'],
    draft,
    kindLabel: files.KIND_LABEL[draft.kind] || draft.kind,
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
      maxDocMb: files.MAX_DOC_BYTES / 1024 / 1024,
      maxImageMb: files.MAX_IMAGE_BYTES / 1024 / 1024,
      maxImagesTotalMb: files.MAX_IMAGES_TOTAL_BYTES / 1024 / 1024,
      maxImages: files.MAX_IMAGES,
    },
  };
}

/** The draft this request may edit, or the 404/403 it has earned. */
async function editable(c) {
  const id = Number(c.req.param('id'));
  const draft = Number.isInteger(id) && id > 0 ? await q.byId(c.env.DB, id) : null;
  if (!draft) throw new HttpError(404, 'That draft is not here.');
  if (!canEditDraft(c.get('currentUser'), draft)) {
    throw new HttpError(403, 'Only the person who uploaded this draft (or the architect) can edit it.');
  }
  return draft;
}

router.get('/:id/edit', async (c) => {
  const draft = await editable(c);
  return render(c, 'drafts/edit', await editLocals(c, draft));
});

router.post('/:id/edit', async (c) => {
  const db = c.env.DB;
  const draft = await editable(c);

  const body = await getBody(c);
  const title = String(field(body, 'title') || '').trim().slice(0, MAX_TITLE_CHARS);
  const description = String(field(body, 'description') || '').trim().slice(0, MAX_DESC_CHARS);
  const authorName = sanitizeAuthorName(field(body, 'author_name'));
  const topic = sanitizeTopic(field(body, 'topic'));

  if (!title) {
    const errors = ['Give the draft a title so people know what they are opening.'];
    const values = {
      title: String(field(body, 'title') || ''),
      description,
      authorName: authorName || '',
      topic: topic || '',
      mode: 'document',
    };
    return render(c, 'drafts/edit', await editLocals(c, draft, { errors, values }), 400);
  }

  const thread = await q.threadForDraft(db, draft.id);
  /*
   * ONE BATCH, and blank means "the draft's title" — the title being saved by
   * THIS submit, not the one the draft had a moment ago, so retitling a draft
   * and clearing its topic together leaves the two in step rather than a
   * revision apart. (db.transaction on Express; the same two writes here.)
   */
  const writes = [
    stmt(
      db,
      `UPDATE drafts SET title = ?, description = ?, author_name = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      title,
      description || null,
      authorName,
      draft.id
    ),
  ];
  if (thread) writes.push(stmt(db, 'UPDATE threads SET title = ? WHERE id = ?', topic || title, thread.id));
  await db.batch(writes);

  flash(c, 'ok', 'Draft updated.');
  return c.redirect(`/drafts/${draft.id}`, 302);
});

/* ---------------- replace the file ----------------
 *
 * SWAPPING THE FILE IS A FULL RE-INGEST, and it deliberately keeps nothing of
 * the old conversion: new original, new pages, new kind, new page_count, back
 * through the ordinary processing → ready/failed lifecycle. A .docx draft may
 * come back as a PDF; the reader picks its pane off drafts.kind and never knew
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
 * THIS IS STEP 1 OF THE PROTOCOL AT THE TOP OF THIS FILE, with a different URL.
 * It stores the replacement STAGED (worker/migrations/0005_draft_swap.sql) and
 * flips the draft to 'processing'; public/js/upload-cf.js then converts in the
 * tab and drives /pages, /finalize and /fail exactly as it does for a new
 * upload. Until finalize, everything the draft already had is still there.
 */
router.post('/:id/file', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const draft = await editable(c);
  const wantsJson =
    String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(c.req.header('accept') || '').includes('application/json');

  const refuse = async (status, messages) =>
    wantsJson
      ? c.json({ ok: false, errors: messages }, status, NO_STORE)
      : render(c, 'drafts/edit', await editLocals(c, draft, { errors: messages }), status);

  // The same ceiling a new upload gets, on its own key: ten drafts an hour and
  // ten replacements an hour are both "a person", not a runaway script.
  if (!(await ratelimit.checkRate(db, 'drafts_swap', user.id, DRAFT_CREATE_MAX, DRAFT_CREATE_WINDOW))) {
    return refuse(429, ["You've replaced a lot of files in the last hour — take a short break and try again soon."]);
  }

  const declared = Number(c.req.header('content-length') || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    return refuse(413, [`That upload is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`]);
  }

  const { fields, files: parts } = await getFormData(c);
  const mode = field(fields, 'mode') === 'images' ? 'images' : 'document';
  const { errors, kind, ordered } = await validateSubmit(parts, mode);
  if (errors.length) return refuse(400, errors);

  /*
   * A SECOND ATTEMPT WHILE ONE IS IN FLIGHT overwrites the first rather than
   * racing it: the staged bytes and staged pages of any earlier attempt go
   * before the new ones land, so the staging namespace only ever describes one
   * replacement. (The draft's own files are, as everywhere in this route,
   * not involved.)
   */
  await discardSwap(c, draft.id);

  let stored;
  try {
    stored = await storeOriginals(c.env, draft.id, kind, ordered, true);
  } catch (err) {
    console.error('[afwc] draft file swap could not be staged:', err);
    await files.discardStaged(c.env, draft.id);
    return refuse(500, ['We could not store that replacement file. Please try again.']);
  }

  const writes = [
    stmt(
      db,
      `INSERT INTO draft_swaps (draft_id, kind, original_filename, original_path)
       VALUES (?, ?, ?, ?)`,
      draft.id,
      kind,
      originalNameFor(kind, ordered),
      stored.originalRel
    ),
    ...stored.pages.map((p) =>
      stmt(
        db,
        `INSERT INTO draft_page_staging (draft_id, page_number, kind, file_path)
         VALUES (?, ?, 'image', ?)`,
        draft.id,
        p.page_number,
        p.file_path
      )
    ),
    stmt(
      db,
      `UPDATE drafts SET status = 'processing', error_msg = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      draft.id
    ),
  ];
  for (let i = 0; i < writes.length; i += ROWS_PER_BATCH) {
    await db.batch(writes.slice(i, i + ROWS_PER_BATCH));
  }

  flash(c, 'ok', 'Replacing the file — converting it for the reader now.');
  const location = `/drafts/${draft.id}`;
  if (wantsJson) return c.json({ ok: true, id: draft.id, redirect: location }, 202, NO_STORE);
  return c.redirect(location, 302);
});

/* ---------------- retry & delete ---------------- */

/**
 * See the file header: retry is now re-upload. The button in views/drafts/*.ejs
 * is shared with Express, so it keeps working and keeps its meaning ("get this
 * draft converted") — it just cannot do it from the original any more.
 *
 * WITH ONE EXCEPTION, AND IT IS THE FILE SWAP'S. A swap that failed leaves the
 * draft marked 'failed' on top of a page set that is still whole, because the
 * replacement was staged and never got near it. For that draft — and only that
 * draft — retry can mean exactly what it means on Express: put it back. The
 * reader's failed card already says so (worker/src/routes/reader.js worded its
 * retryHint from the same question), so the button a member presses does what
 * the sentence above it promised.
 */
router.post('/:id/retry', async (c) => {
  const db = c.env.DB;
  const draft = await q.byId(db, Number(c.req.param('id')));
  if (!draft) throw new HttpError(404, 'That draft is not here.');
  if (!canManage(c.get('currentUser'), draft)) {
    throw new HttpError(403, 'Only the person who uploaded this (or a leader) can retry it.');
  }

  if (draft.status === 'failed' && (await draftPagesIntact(db, draft))) {
    await db.batch([readyStmt(db, draft.id, draft.page_count)]);
    flash(c, 'ok', 'Put back the way it was — the replacement file was the only thing that failed.');
    return c.redirect(`/drafts/${draft.id}`, 302);
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
