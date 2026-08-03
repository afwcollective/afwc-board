'use strict';

/**
 * .docx ingest — mammoth converts to semantic HTML (Heading 1/2 become h1/h2,
 * which is exactly what the paginator splits on) and inlines embedded figures
 * as data: URIs, which the house sanitizer allows for <img>. Everything else is
 * stripped by cleanHtml before it is ever stored.
 */

const mammoth = require('mammoth');

const { cleanHtml } = require('../../util/sanitize');
const { paginateHtml } = require('../paginate');
const { resolveInDraft } = require('./paths');

async function build(draft) {
  const file = resolveInDraft(draft.id, draft.original_path || 'original.docx');
  if (!file) throw new Error('draft original path is unusable');

  let result;
  try {
    result = await mammoth.convertToHtml(
      { path: file },
      // mammoth's default image handler already emits data: URIs; naming it
      // here keeps the intent obvious and pins the behaviour across versions.
      { convertImage: mammoth.images.dataUri }
    );
  } catch (err) {
    const e = new Error(
      'We could not read that .docx — it may be corrupt, password-protected, or not really a Word file.'
    );
    e.friendly = true;
    e.cause = err;
    throw e;
  }

  const html = cleanHtml(result.value || '');
  return paginateHtml(html);
}

module.exports = { build };
