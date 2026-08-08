'use strict';

/**
 * Where a draft's bytes live on disk. Kept dependency-free so both the ingest
 * modules and the reader's streaming routes can require it cheaply.
 *
 *   DATA_DIR/uploads/drafts/<id>/original.<ext>
 *   DATA_DIR/uploads/drafts/<id>/pages/0001.jpg …
 *
 * Every path stored in the database (drafts.original_path, draft_pages.file_path)
 * is RELATIVE to the draft directory, so the whole uploads tree can be moved or
 * restored from a backup without rewriting rows.
 *
 * ONE MORE NAME LIVES UNDER A DRAFT, AND ONLY EVER TEMPORARILY:
 *
 *   DATA_DIR/uploads/drafts/<id>/swap/original.<ext>
 *   DATA_DIR/uploads/drafts/<id>/swap/pages/0001.jpg …
 *
 * A FILE SWAP (POST /drafts/:id/file) writes the replacement there and leaves
 * the draft's live bytes exactly where they are, so a conversion that fails
 * costs the uploader nothing. src/services/ingest/index.js swapDraftFile()
 * promotes swap/ over the live names in one move once the new pages are built,
 * and deletes it outright when they are not. NOTHING IS EVER STORED IN THE
 * DATABASE UNDER A swap/ PATH: the promotion strips the prefix first, so a row
 * only ever names a canonical `original.<ext>` or `pages/0001.<ext>`.
 */

const path = require('node:path');
const config = require('../../config');

const DRAFTS_ROOT = path.join(config.uploadsDir, 'drafts');
const TMP_DIR = path.join(config.uploadsDir, 'tmp');

/**
 * The one directory name a swap stages under, and the one prefix that is
 * stripped on the way into the database. Written down once so the route that
 * writes it and the service that promotes it cannot drift.
 */
const SWAP_DIR = 'swap';

function draftDir(draftId) {
  const id = Number(draftId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad draft id');
  return path.join(DRAFTS_ROOT, String(id));
}

/**
 * Resolves a stored relative path inside a draft directory, refusing anything
 * that escapes it (`..`, absolute paths, symlink-ish trickery in the string).
 * Returns null when the path is not safe.
 */
function resolveInDraft(draftId, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  const base = draftDir(draftId);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** `DATA_DIR/uploads/drafts/<id>/swap` — where a replacement file is staged. */
function swapDir(draftId) {
  return path.join(draftDir(draftId), SWAP_DIR);
}

/**
 * `swap/pages/0001.png` -> `pages/0001.png`. The promotion step calls this on
 * every path a builder produced, because what a builder saw was the staging
 * tree and what the database must record is the live one.
 */
function unstage(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  return rel.startsWith(`${SWAP_DIR}/`) ? rel.slice(SWAP_DIR.length + 1) : rel;
}

module.exports = { DRAFTS_ROOT, TMP_DIR, SWAP_DIR, draftDir, resolveInDraft, swapDir, unstage };
