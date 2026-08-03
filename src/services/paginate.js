'use strict';

/**
 * Pagination for converted documents (Phase 4).
 *
 * Contract the ingest pipeline will call:
 *   paginateHtml(html, { wordsPerPage = 1000 })
 *     -> [{ page_number, kind: 'html', content_html, heading }]
 *
 * Rule from the plan: split at h1/h2 when the document has headings, otherwise
 * chunk to ~1,000 words on paragraph boundaries. Nothing else in the codebase
 * depends on this yet.
 */
function paginateHtml(/* html, opts */) {
  throw new Error('TODO(phase 4): paginateHtml is not implemented yet');
}

module.exports = { paginateHtml };
