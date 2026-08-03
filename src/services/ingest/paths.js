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
 */

const path = require('node:path');
const config = require('../../config');

const DRAFTS_ROOT = path.join(config.uploadsDir, 'drafts');
const TMP_DIR = path.join(config.uploadsDir, 'tmp');

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

module.exports = { DRAFTS_ROOT, TMP_DIR, draftDir, resolveInDraft };
