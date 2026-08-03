'use strict';

/**
 * PDF ingest — parse only, never render. pdf.js runs here purely to (a) prove
 * the file is a readable, unencrypted PDF and (b) learn numPages plus each
 * page's intrinsic size, so the client viewer can lay out placeholders at the
 * right aspect ratio before a page has been rasterised.
 *
 * The bytes themselves stay on disk and are only ever streamed back through
 * GET /drafts/:id/file.pdf, which is session-gated and no-store.
 */

const fs = require('node:fs');

const { resolveInDraft } = require('./paths');

/** Above this, skip the per-page viewport probe — placeholders fall back to US Letter. */
const MEASURE_PAGE_LIMIT = 800;

let pdfjsPromise = null;
function loadPdfjs() {
  // pdfjs-dist v4 ships ESM only; the legacy build is the one that runs under
  // plain Node without a DOM. Dynamic import keeps this out of the boot path.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function build(draft) {
  const file = resolveInDraft(draft.id, draft.original_path || 'original.pdf');
  if (!file) throw new Error('draft original path is unusable');

  const bytes = new Uint8Array(await fs.promises.readFile(file));
  const pdfjs = await loadPdfjs();

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
    }).promise;
  } catch (err) {
    const name = (err && err.name) || '';
    const e = new Error(
      name === 'PasswordException'
        ? 'That PDF is password-protected. Save an unprotected copy and upload that.'
        : 'We could not read that PDF — it may be corrupt or incomplete.'
    );
    e.friendly = true;
    e.cause = err;
    throw e;
  }

  const total = doc.numPages;
  if (!total) {
    await doc.destroy();
    const e = new Error('That PDF has no pages in it.');
    e.friendly = true;
    throw e;
  }

  const pages = [];
  for (let n = 1; n <= total; n += 1) {
    let width = null;
    let height = null;
    if (total <= MEASURE_PAGE_LIMIT) {
      try {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        width = Math.round(viewport.width);
        height = Math.round(viewport.height);
        page.cleanup();
      } catch {
        /* a page we cannot measure still gets a row; the viewer falls back */
      }
    }
    pages.push({ kind: 'pdf_page', content_html: null, file_path: null, width, height, heading: null });
  }

  await doc.destroy();
  return pages;
}

module.exports = { build };
