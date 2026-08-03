'use strict';

/**
 * Draft ingest dispatcher (Phases 4–5).
 *
 * Contract:
 *   ingestDraft(draftId) -> Promise<void>
 * Runs in-process via setImmediate after POST /drafts inserts the row with
 * status 'processing'. It writes draft_pages, then flips drafts.status to
 * 'ready' (with page_count) or 'failed' (with a friendly error_msg).
 *
 * Per-kind modules land beside this file: docx.js, pdf.js, images.js, text.js.
 */
async function ingestDraft(/* draftId */) {
  throw new Error('TODO(phase 4): ingestDraft is not implemented yet');
}

/** Boot-time sweep: any draft left 'processing' by a crash becomes 'failed'. */
function sweepStaleProcessing() {
  return 0; // TODO(phase 4)
}

module.exports = { ingestDraft, sweepStaleProcessing };
