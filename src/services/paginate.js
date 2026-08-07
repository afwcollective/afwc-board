'use strict';

/**
 * Pagination for converted documents (Phase 4) — now a re-export.
 *
 * THE LOGIC MOVED, IT DID NOT CHANGE. It lives in
 * public/vendor/afwc/paginate.js, which is a dual-export module: Node
 * `require`s it from here, and the browser loads the very same file as a static
 * asset (public/js/upload-cf.js) on the Cloudflare stack, where
 * PORT-CLOUDFLARE.md §6 runs document conversion client-side because a Worker
 * has ~10ms of CPU per request.
 *
 * One file, two runtimes, so a tweak to the chunk target or the heading rule
 * can never land on one deployment and not the other. See the header of that
 * file for the contract and for why it no longer borrows toPlainText() from
 * src/util/sanitize.js — the swap was verified byte-identical against every
 * converted page in the dev database before it was made.
 */

const shared = require('../../public/vendor/afwc/paginate');

module.exports = {
  paginateHtml: shared.paginateHtml,
  splitTopLevelBlocks: shared.splitTopLevelBlocks,
};
