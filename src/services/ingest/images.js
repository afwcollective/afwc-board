'use strict';

/**
 * Image-sequence ingest (graphic novels). The upload route has already moved
 * the files into <draft>/pages/0001.ext … in filename sort order; this module
 * only measures them and writes one draft_pages row each.
 *
 * `draft.pages_rel` names the directory to read, relative to the draft's own
 * folder, and defaults to the live `pages`. A FILE SWAP passes `swap/pages`
 * instead so the replacement is measured where it was staged, without the live
 * pages being touched — see src/services/ingest/index.js swapDraftFile(). The
 * file_path this module returns is relative to the draft folder either way; the
 * swap strips the staging prefix before anything is stored.
 */

const fs = require('node:fs');
const path = require('node:path');
const { imageSize } = require('image-size');

const { resolveInDraft } = require('./paths');

async function build(draft) {
  const pagesRel = String(draft.pages_rel || 'pages');
  const dir = resolveInDraft(draft.id, pagesRel);
  if (!dir) throw new Error('draft pages path is unusable');

  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    const e = new Error('The uploaded pages could not be read back from disk.');
    e.friendly = true;
    e.cause = err;
    throw e;
  }

  names = names.filter((n) => !n.startsWith('.')).sort();
  if (!names.length) {
    const e = new Error('No page images survived the upload. Please try again.');
    e.friendly = true;
    throw e;
  }

  const pages = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let width = null;
    let height = null;
    try {
      const dims = imageSize(await fs.promises.readFile(full));
      width = dims.width || null;
      height = dims.height || null;
    } catch {
      /* unreadable dimensions are survivable — the <img> still renders */
    }
    pages.push({
      kind: 'image',
      content_html: null,
      file_path: `${pagesRel}/${name}`,
      width,
      height,
      heading: null,
    });
  }

  return pages;
}

module.exports = { build };
