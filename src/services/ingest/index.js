'use strict';

/**
 * Draft ingest dispatcher (Phases 4–5).
 *
 * Contract:
 *   ingestDraft(draftId) -> Promise<void>   (never rejects)
 * Runs in-process via setImmediate after POST /drafts inserts the row with
 * status 'processing'. It writes draft_pages, then flips drafts.status to
 * 'ready' (with page_count) or 'failed' (with a friendly error_msg). The final
 * write is one transaction, so a reader polling /drafts/:id/status can never
 * observe "ready" with a half-written page set.
 *
 * Per-kind modules sit beside this file: docx.js, pdf.js, images.js, text.js.
 * Each exports `build(draft) -> Promise<Array<{kind, content_html, file_path,
 * width, height, heading}>>` in page order and throws with `err.friendly = true`
 * when the message is safe to show a member verbatim.
 */

const fs = require('node:fs');
const path = require('node:path');

const { db } = require('../../db');
const { draftDir, swapDir, unstage } = require('./paths');

const BUILDERS = {
  text: () => require('./text'),
  docx: () => require('./docx'),
  pdf: () => require('./pdf'),
  images: () => require('./images'),
};

const GENERIC_ERROR = {
  text: 'We could not convert that text file. Try re-saving it as UTF-8 plain text.',
  docx: 'We could not convert that .docx. Try re-saving it from Word or Google Docs and upload again.',
  pdf: 'We could not read that PDF. Try re-exporting it and upload again.',
  images: 'We could not process those page images. Try uploading them again.',
};

const stmt = {
  draft: () => db.prepare('SELECT * FROM drafts WHERE id = ?'),
  clearPages: () => db.prepare('DELETE FROM draft_pages WHERE draft_id = ?'),
  insertPage: () =>
    db.prepare(
      `INSERT INTO draft_pages (draft_id, page_number, kind, content_html, file_path, width, height, heading)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
  ready: () =>
    db.prepare(
      `UPDATE drafts SET status = 'ready', page_count = ?, error_msg = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
  failed: () =>
    db.prepare(
      `UPDATE drafts SET status = 'failed', error_msg = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
  sweep: () =>
    db.prepare(
      `UPDATE drafts
          SET status = 'failed',
              error_msg = 'Upload interrupted — please re-upload.',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE status = 'processing'
          AND COALESCE(updated_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')`
    ),
  /* -- the file swap's one write (see swapDraftFile below) -- */
  swapReady: () =>
    db.prepare(
      `UPDATE drafts
          SET kind = ?, page_count = ?, original_filename = ?, original_path = ?,
              status = 'ready', error_msg = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
};

async function ingestDraft(draftId) {
  const draft = stmt.draft().get(Number(draftId));
  if (!draft) return;

  try {
    const load = BUILDERS[draft.kind];
    if (!load) throw new Error(`unknown draft kind: ${draft.kind}`);

    const pages = await load().build(draft);
    if (!Array.isArray(pages) || !pages.length) {
      const e = new Error('That file turned out to have no pages in it.');
      e.friendly = true;
      throw e;
    }

    const commit = db.transaction(() => {
      stmt.clearPages().run(draft.id);
      const insert = stmt.insertPage();
      pages.forEach((page, i) => {
        insert.run(
          draft.id,
          i + 1,
          page.kind,
          page.content_html == null ? null : String(page.content_html),
          page.file_path == null ? null : String(page.file_path),
          page.width == null ? null : Number(page.width),
          page.height == null ? null : Number(page.height),
          page.heading == null ? null : String(page.heading)
        );
      });
      stmt.ready().run(pages.length, draft.id);
    });
    commit();

    console.log(`[afwc] draft ${draft.id} (${draft.kind}) ready — ${pages.length} pages`);
  } catch (err) {
    const message = err && err.friendly ? err.message : GENERIC_ERROR[draft.kind] || 'Conversion failed.';
    console.error(`[afwc] draft ${draft.id} (${draft.kind}) ingest failed:`, err);
    try {
      stmt.failed().run(message, draft.id);
    } catch (dbErr) {
      console.error('[afwc] could not record ingest failure:', dbErr);
    }
  }
}

/**
 * Boot-time sweep: any draft still 'processing' more than ten minutes after its
 * last touch was orphaned by a crash or a redeploy, because ingest only ever
 * runs in-process. Called from server.js before the listener opens.
 */
function sweepStaleProcessing() {
  try {
    const { changes } = stmt.sweep().run();
    if (changes) console.log(`[afwc] swept ${changes} stale processing draft(s) to failed`);
    return changes;
  } catch (err) {
    console.error('[afwc] stale-processing sweep failed:', err);
    return 0;
  }
}

/* ============================================================ FILE SWAP ==== */

/**
 * What a member reads when a REPLACEMENT file fails to convert. The per-kind
 * diagnosis is the same one an ordinary upload gets; the second sentence is the
 * part that only makes sense here, and it is true because of the ordering
 * below — nothing the draft already had is touched until the new pages exist.
 */
const SWAP_RECOVERY = 'The draft’s previous pages are still on file — “Try converting again” puts them back.';

/** Every live name a draft owns: its original, and its page-image directory. */
function liveNames(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n === 'pages' || /^original\./.test(n));
}

function moveAll(names, from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of names) fs.renameSync(path.join(from, name), path.join(to, name));
}

const rmrf = (target) => fs.rmSync(target, { recursive: true, force: true });

/**
 * SWAP THE FILE UNDER AN EXISTING DRAFT — the write half of /drafts/:id/edit's
 * "replace the file" control (src/routes/drafts.js POST /:id/file). The route
 * has already validated the submit exactly as an upload is validated and staged
 * the bytes under <draft>/swap/; this builds pages from THERE and only then
 * lets them near the draft.
 *
 * THE SEMANTICS, WRITTEN OUT BECAUSE THEY ARE THE WHOLE POINT:
 *
 *   · THE OLD PAGES SURVIVE UNTIL THE NEW ONES EXIST. The draft is flipped to
 *     'processing' by the route (so the reader shows its ordinary converting
 *     state), but draft_pages and the live files are untouched while the
 *     builder runs. A conversion that throws leaves the draft exactly as it
 *     was apart from the failed status and the message above — and because
 *     drafts.original_path still names the OLD original, the ordinary
 *     "Try converting again" button rebuilds the draft it had before.
 *   · THE SWAP MAY CHANGE THE KIND. A .docx draft can become a PDF: kind,
 *     page_count, original_filename and original_path are all rewritten from
 *     the new file, and the reader picks its pane from drafts.kind as it always
 *     has. Nothing about the draft's identity moves — same id, same URL, same
 *     discussion thread.
 *   · PAGE COMMENTS ARE NOT TOUCHED. comments.draft_id and comments.page_number
 *     are left exactly as they are, deliberately: a comment stays on the page
 *     NUMBER it was written on. If the new file paginates differently, page 4's
 *     notes are still on page 4 and may now sit against different prose. The
 *     edit page says so in those words next to the control.
 *   · NO ORPHANS. The previous original and page images are deleted from the
 *     filestore once (and only once) the new rows are committed.
 *
 * Never rejects; records 'failed' and returns, exactly like ingestDraft().
 */
async function swapDraftFile(draftId, staged) {
  const draft = stmt.draft().get(Number(draftId));
  if (!draft) return;

  const dir = draftDir(draft.id);
  const staging = swapDir(draft.id);
  const kind = staged.kind;

  try {
    const load = BUILDERS[kind];
    if (!load) throw new Error(`unknown draft kind: ${kind}`);

    /*
     * A SYNTHETIC DRAFT, pointed at the staging tree. Every builder takes the
     * same four fields off the row and nothing else, so handing it a shape that
     * describes the replacement is all it takes to convert the new file without
     * a second code path — and without the builders learning what a swap is.
     */
    const pages = await load().build({
      id: draft.id,
      kind,
      original_path: staged.originalPath,
      original_filename: staged.originalFilename,
      pages_rel: 'swap/pages',
    });
    if (!Array.isArray(pages) || !pages.length) {
      const e = new Error('That file turned out to have no pages in it.');
      e.friendly = true;
      throw e;
    }

    /*
     * PROMOTION. The live names go into an attic first, the staged ones take
     * their place, and only then does the database change. If the commit throws
     * — which on a local SQLite file essentially means the disk is gone — the
     * attic goes straight back, so the draft is never left describing bytes
     * that are not there. The attic is deleted last, which is where "no orphan
     * files" actually happens.
     */
    const attic = path.join(dir, `.replaced-${Date.now().toString(36)}`);
    const old = liveNames(dir);
    moveAll(old, dir, attic);
    try {
      moveAll(liveNames(staging), staging, dir);
      rmrf(staging);

      const canonicalOriginal = staged.originalPath ? unstage(staged.originalPath) : null;
      const commit = db.transaction(() => {
        stmt.clearPages().run(draft.id);
        const insert = stmt.insertPage();
        pages.forEach((page, i) => {
          insert.run(
            draft.id,
            i + 1,
            page.kind,
            page.content_html == null ? null : String(page.content_html),
            page.file_path == null ? null : unstage(page.file_path),
            page.width == null ? null : Number(page.width),
            page.height == null ? null : Number(page.height),
            page.heading == null ? null : String(page.heading)
          );
        });
        stmt
          .swapReady()
          .run(kind, pages.length, staged.originalFilename, canonicalOriginal, draft.id);
      });
      commit();
    } catch (err) {
      // Put the draft's own bytes back before anything else notices they left.
      for (const name of liveNames(dir)) rmrf(path.join(dir, name));
      moveAll(liveNames(attic), attic, dir);
      throw err;
    }
    rmrf(attic);

    console.log(
      `[afwc] draft ${draft.id} file swapped (${draft.kind} → ${kind}) — ${pages.length} pages`
    );
  } catch (err) {
    const diagnosis = err && err.friendly ? err.message : GENERIC_ERROR[kind] || 'Conversion failed.';
    console.error(`[afwc] draft ${draft.id} file swap failed:`, err);
    rmrf(staging);
    try {
      stmt.failed().run(`${diagnosis} ${SWAP_RECOVERY}`, draft.id);
    } catch (dbErr) {
      console.error('[afwc] could not record swap failure:', dbErr);
    }
  }
}

module.exports = { ingestDraft, sweepStaleProcessing, swapDraftFile };
