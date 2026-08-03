'use strict';

/**
 * .txt / .md ingest.
 *
 * Both paths end at cleanHtml + paginateHtml. The interesting part is what a
 * newline means, because a chapter that arrives hard-wrapped at 80 columns and
 * a poem both look like "lines" on disk:
 *
 *  - Markdown is converted with marked's `breaks: false` (the CommonMark rule),
 *    so a hard-wrapped paragraph reflows to the reader's column and an author
 *    who wants a line break asks for one the Markdown way. This is deliberately
 *    NOT util/sanitize.js mdToHtml, which sets `breaks: true` — the right call
 *    for a one-paragraph comment box, the wrong one for a manuscript.
 *  - Plain text is escaped and paragraph-wrapped on blank lines. Inside a
 *    paragraph we look at the line lengths: long, even lines are hard wrapping
 *    and get joined; short ragged lines are verse or screenplay and keep their
 *    <br>.
 */

const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');

const { cleanHtml } = require('../../util/sanitize');
const { paginateHtml } = require('../paginate');
const { resolveInDraft } = require('./paths');

/** Above this average line length, a multi-line paragraph is hard wrapping. */
const WRAP_THRESHOLD = 55;

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function looksHardWrapped(lines) {
  if (lines.length < 2) return false;
  // The last line of a wrapped paragraph is short by definition; ignore it.
  const measured = lines.slice(0, -1);
  const average = measured.reduce((sum, l) => sum + l.length, 0) / measured.length;
  return average >= WRAP_THRESHOLD;
}

function plainTextToHtml(raw) {
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length)
    .map((lines) => {
      const joined = looksHardWrapped(lines)
        ? escapeHtml(lines.join(' '))
        : lines.map(escapeHtml).join('<br>');
      return `<p>${joined}</p>`;
    })
    .join('\n');
}

function markdownToHtml(raw) {
  return cleanHtml(marked.parse(raw, { async: false, gfm: true, breaks: false }));
}

async function build(draft) {
  const file = resolveInDraft(draft.id, draft.original_path || 'original.txt');
  if (!file) throw new Error('draft original path is unusable');

  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    const e = new Error('The uploaded file could not be read back from disk.');
    e.friendly = true;
    e.cause = err;
    throw e;
  }
  raw = raw.replace(/^\uFEFF/, '');

  const ext = path.extname(String(draft.original_filename || '')).toLowerCase();
  const isMarkdown = ext === '.md' || ext === '.markdown';
  const html = isMarkdown ? markdownToHtml(raw) : cleanHtml(plainTextToHtml(raw));

  return paginateHtml(html);
}

module.exports = { build, plainTextToHtml, markdownToHtml };
