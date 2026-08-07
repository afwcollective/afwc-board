/**
 * Port of src/util/sanitize.js.
 *
 * THE ALLOWLIST IS THE SAME OBJECT, character for character. Announcements,
 * board posts, draft comments and converted .docx/.md documents all pass
 * through here, and the port's trust model (PORT-CLOUDFLARE.md §6) leans on it:
 * document conversion moves to the uploader's browser, so the server-side
 * sanitize is the only thing standing between a hand-crafted POST and the
 * reader. It must not get weaker in the move.
 *
 * DOES sanitize-html RUN ON WORKERD? Yes. Its parser is htmlparser2, which is
 * pure JavaScript with no native bindings and no filesystem access; the only
 * node-shaped dependency in the graph is postcss (used for the style-attribute
 * filter, which this allowlist never invokes since `style` is not an allowed
 * attribute on anything), and `nodejs_compat` covers what it reaches for. The
 * bundle is built with esbuild and verified end-to-end by rendering the landing
 * page, whose "The collective" section is markdown → mdToHtml → sanitize on
 * every request.
 */

import sanitizeHtml from 'sanitize-html';
import { marked } from 'marked';

/**
 * The single HTML allowlist for the whole app — announcements, board posts,
 * draft comments and converted .docx/.md documents all pass through here.
 * Anything not on this list is stripped, including every event handler,
 * <script>, <style> and inline style attribute.
 */
const OPTIONS = {
  allowedTags: [
    'p', 'em', 'strong', 'b', 'i', 'h1', 'h2', 'h3',
    'blockquote', 'ul', 'ol', 'li', 'br', 'hr', 'a', 'img',
    // useful in converted documents; harmless without attributes
    'code', 'pre', 'sup', 'sub', 'u', 's',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height'],
    // section anchors emitted by the docx/markdown paginator
    h1: ['id'], h2: ['id'], h3: ['id'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data', 'http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    // external links open away from the reader and cannot reach back into it
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }),
  },
};

/** Sanitize a fragment of HTML with the house allowlist. */
export function cleanHtml(dirty) {
  return sanitizeHtml(String(dirty == null ? '' : dirty), OPTIONS);
}

/** Markdown source -> sanitized HTML. Used for announcements, posts, comments. */
export function mdToHtml(markdown) {
  const raw = marked.parse(String(markdown == null ? '' : markdown), {
    async: false,
    gfm: true,
    breaks: true,
  });
  return cleanHtml(raw);
}

/** Strip every tag — for previews, page titles and meta descriptions. */
export function toPlainText(html, max = 0) {
  let text = sanitizeHtml(String(html == null ? '' : html), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (max && text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

export { OPTIONS };
