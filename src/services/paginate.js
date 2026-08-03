'use strict';

/**
 * Pagination for converted documents (Phase 4).
 *
 * Contract the ingest pipeline calls:
 *   paginateHtml(html, { wordsPerPage = 1000 })
 *     -> [{ page_number, kind: 'html', content_html, heading }]
 *
 * Rule from the plan: split at h1/h2 when the document actually has headings
 * (>= 2 of them), otherwise chunk to ~1,000 words on paragraph boundaries.
 * A section longer than 2x the chunk target is subdivided so no single page is
 * a wall of text; only the first page of a section carries the heading, so the
 * section-nav dropdown lists each section exactly once.
 *
 * Input MUST already be sanitized (src/util/sanitize.js cleanHtml) — this file
 * only ever slices between top-level element boundaries, so well-formed input
 * stays well-formed on the way out.
 */

const { toPlainText } = require('../util/sanitize');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Splits sanitized HTML into its top-level blocks (each <p>…</p>, <h2>…</h2>,
 * <ul>…</ul>, stray text node, …) without a DOM parser. Depth is tracked so
 * nested tags never produce a cut point.
 */
function splitTopLevelBlocks(html) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  let match;

  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(html)) !== null) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const selfClosing = match[3] === '/' || VOID_TAGS.has(name);
    const end = match.index + match[0].length;

    if (selfClosing) {
      if (depth === 0) {
        blocks.push(html.slice(start, end));
        start = end;
      }
      continue;
    }

    if (!closing) {
      if (depth === 0) {
        const between = html.slice(start, match.index);
        if (between.trim()) blocks.push(between);
        start = match.index;
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth <= 0) {
        blocks.push(html.slice(start, end));
        start = end;
        depth = 0;
      }
    }
  }

  const tail = html.slice(start);
  if (tail.trim()) blocks.push(tail);

  return blocks.map((b) => b.trim()).filter(Boolean);
}

const isHeading = (block) => /^<h[12][\s>]/i.test(block);

function wordsIn(block) {
  const text = toPlainText(block);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/** Greedy accumulation of blocks into ~maxWords chunks, never splitting a block. */
function chunkBlocks(blocks, maxWords) {
  const chunks = [];
  let current = [];
  let count = 0;

  for (const block of blocks) {
    const words = wordsIn(block);
    if (current.length && count + words > maxWords) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(block);
    count += words;
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [blocks];
}

function paginateHtml(html, opts = {}) {
  const wordsPerPage = Math.max(200, Number(opts.wordsPerPage) || 1000);
  const blocks = splitTopLevelBlocks(String(html == null ? '' : html));

  if (!blocks.length || !toPlainText(blocks.join(' ')).trim()) {
    const err = new Error('We could not find any readable text in that file.');
    err.friendly = true;
    throw err;
  }

  const pages = [];
  const headingCount = blocks.filter(isHeading).length;

  if (headingCount >= 2) {
    const sections = [];
    let current = null;
    for (const block of blocks) {
      if (isHeading(block) || !current) {
        current = { heading: isHeading(block) ? toPlainText(block, 120) || null : null, blocks: [] };
        sections.push(current);
      }
      current.blocks.push(block);
    }
    for (const section of sections) {
      // A section with a heading but no body still becomes a page; one with
      // neither (an empty preamble) is dropped.
      if (!toPlainText(section.blocks.join(' ')).trim()) continue;
      const chunks = chunkBlocks(section.blocks, wordsPerPage * 2);
      chunks.forEach((chunk, i) => {
        pages.push({
          kind: 'html',
          content_html: chunk.join('\n'),
          heading: i === 0 ? section.heading : null,
        });
      });
    }
  } else {
    for (const chunk of chunkBlocks(blocks, wordsPerPage)) {
      const firstHeading = chunk.find(isHeading);
      pages.push({
        kind: 'html',
        content_html: chunk.join('\n'),
        heading: firstHeading ? toPlainText(firstHeading, 120) || null : null,
      });
    }
  }

  if (!pages.length) {
    const err = new Error('We could not find any readable text in that file.');
    err.friendly = true;
    throw err;
  }

  return pages.map((page, i) => ({ ...page, page_number: i + 1 }));
}

module.exports = { paginateHtml, splitTopLevelBlocks };
