/* AFWC pagination — THE ONE COPY, loaded by both stacks.
 *
 * Contract (unchanged from src/services/paginate.js, which is now a two-line
 * re-export of this file):
 *
 *   paginateHtml(html, { wordsPerPage = 1000 })
 *     -> [{ page_number, kind: 'html', content_html, heading }]
 *
 * Rule from the plan: split at h1/h2 when the document actually has headings
 * (>= 2 of them), otherwise chunk to ~1,000 words on paragraph boundaries.
 * A section longer than 2x the chunk target is subdivided so no single page is
 * a wall of text; only the first page of a section carries the heading, so the
 * section-nav dropdown lists each section exactly once.
 *
 * WHY IT LIVES UNDER public/vendor/afwc/ ------------------------------------
 *
 * PORT-CLOUDFLARE.md §6 moves document conversion to the uploader's BROWSER,
 * because a Worker on the free plan has ~10ms of CPU per request and mammoth +
 * marked + pagination is nowhere near that. So the same pagination now runs in
 * two places: Node (the Express app's ingest) and the browser
 * (public/js/upload-cf.js). Two copies would fork the moment somebody tuned a
 * threshold, and the symptom — page boundaries that differ between the two
 * deployments of the same app — is exactly the kind of bug nobody would think
 * to look for. So there is one file, served to the browser as a static asset
 * and `require`d by Node from the same path on disk.
 *
 * That is also why it is dependency-free. The Node version used to borrow
 * toPlainText() from src/util/sanitize.js (sanitize-html); a browser cannot,
 * and shipping sanitize-html to the client to count words would be absurd. The
 * `plainText()` below is the same function for the inputs this file sees:
 * paginateHtml is only ever handed ALREADY-SANITIZED html (the house allowlist
 * has no script/style/textarea/option, which are the only tags sanitize-html
 * treats specially), so "strip the tags, decode the five entities the sanitizer
 * emits, collapse whitespace" produces the identical string. Verified against
 * the old implementation over the ingest fixtures before the swap.
 *
 * Input MUST already be sanitized — this file only ever slices between
 * top-level element boundaries, so well-formed input stays well-formed on the
 * way out. On the Worker side that sanitize happens SERVER-SIDE, per page, on
 * the way in (worker/src/routes/drafts.js). The client-side clean in
 * upload-cf.js is a convenience so pagination sees what will be stored; it is
 * not a trust boundary and is not treated as one.
 */
(function (root, factory) {
  'use strict';
  /* eslint-disable no-undef */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(); // Node: src/services/paginate.js
  } else {
    root.AFWCPaginate = factory(); // browser: public/js/upload-cf.js
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1,
  };

  var TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

  /**
   * The stand-in for src/util/sanitize.js toPlainText() — see the file header
   * for why it is allowed to be this small. Same output for sanitized input:
   * strip tags, decode the five entities sanitize-html escapes, collapse
   * whitespace, optionally ellipsize.
   */
  function plainText(html, max) {
    var text = String(html == null ? '' : html)
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (max && text.length > max) text = text.slice(0, max - 1).replace(/\s+$/, '') + '…';
    return text;
  }

  /**
   * Splits sanitized HTML into its top-level blocks (each <p>…</p>, <h2>…</h2>,
   * <ul>…</ul>, stray text node, …) without a DOM parser. Depth is tracked so
   * nested tags never produce a cut point.
   */
  function splitTopLevelBlocks(html) {
    var blocks = [];
    var depth = 0;
    var start = 0;
    var match;

    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(html)) !== null) {
      var closing = match[1] === '/';
      var name = match[2].toLowerCase();
      var selfClosing = match[3] === '/' || VOID_TAGS[name] === 1;
      var end = match.index + match[0].length;

      if (selfClosing) {
        if (depth === 0) {
          blocks.push(html.slice(start, end));
          start = end;
        }
        continue;
      }

      if (!closing) {
        if (depth === 0) {
          var between = html.slice(start, match.index);
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

    var tail = html.slice(start);
    if (tail.trim()) blocks.push(tail);

    return blocks
      .map(function (b) {
        return b.trim();
      })
      .filter(Boolean);
  }

  function isHeading(block) {
    return /^<h[12][\s>]/i.test(block);
  }

  function wordsIn(block) {
    var text = plainText(block);
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }

  /** Greedy accumulation of blocks into ~maxWords chunks, never splitting a block. */
  function chunkBlocks(blocks, maxWords) {
    var chunks = [];
    var current = [];
    var count = 0;

    for (var i = 0; i < blocks.length; i += 1) {
      var words = wordsIn(blocks[i]);
      if (current.length && count + words > maxWords) {
        chunks.push(current);
        current = [];
        count = 0;
      }
      current.push(blocks[i]);
      count += words;
    }
    if (current.length) chunks.push(current);
    return chunks.length ? chunks : [blocks];
  }

  /** The "we can show this to a member" error the ingest dispatcher looks for. */
  function friendly(message) {
    var err = new Error(message);
    err.friendly = true;
    return err;
  }

  function paginateHtml(html, opts) {
    var options = opts || {};
    var wordsPerPage = Math.max(200, Number(options.wordsPerPage) || 1000);
    var blocks = splitTopLevelBlocks(String(html == null ? '' : html));

    if (!blocks.length || !plainText(blocks.join(' ')).trim()) {
      throw friendly('We could not find any readable text in that file.');
    }

    var pages = [];
    var headingCount = blocks.filter(isHeading).length;

    if (headingCount >= 2) {
      var sections = [];
      var current = null;
      blocks.forEach(function (block) {
        if (isHeading(block) || !current) {
          current = { heading: isHeading(block) ? plainText(block, 120) || null : null, blocks: [] };
          sections.push(current);
        }
        current.blocks.push(block);
      });
      sections.forEach(function (section) {
        // A section with a heading but no body still becomes a page; one with
        // neither (an empty preamble) is dropped.
        if (!plainText(section.blocks.join(' ')).trim()) return;
        chunkBlocks(section.blocks, wordsPerPage * 2).forEach(function (chunk, i) {
          pages.push({
            kind: 'html',
            content_html: chunk.join('\n'),
            heading: i === 0 ? section.heading : null,
          });
        });
      });
    } else {
      chunkBlocks(blocks, wordsPerPage).forEach(function (chunk) {
        var firstHeading = chunk.filter(isHeading)[0];
        pages.push({
          kind: 'html',
          content_html: chunk.join('\n'),
          heading: firstHeading ? plainText(firstHeading, 120) || null : null,
        });
      });
    }

    if (!pages.length) {
      throw friendly('We could not find any readable text in that file.');
    }

    return pages.map(function (page, i) {
      return {
        kind: page.kind,
        content_html: page.content_html,
        heading: page.heading,
        page_number: i + 1,
      };
    });
  }

  return { paginateHtml: paginateHtml, splitTopLevelBlocks: splitTopLevelBlocks, plainText: plainText };
});
