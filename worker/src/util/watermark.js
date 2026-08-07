/**
 * Port of src/util/watermark.js — byte-identical output, different base64.
 *
 * Builds the tiled, low-opacity reader watermark as an inline SVG data: URI:
 * pure CSS/markup, no extra request, nothing to route through the anti-download
 * gate. The text is the CURRENT VIEWER's display name + username, so a leaked
 * screenshot is attributable to whoever took it.
 *
 * The only thing that changed is the last line. Node had
 * `Buffer.from(svg, 'utf8').toString('base64')`; workerd has btoa(), which
 * throws on any code point above U+00FF. So the SVG is UTF-8 encoded first and
 * btoa() is fed the resulting bytes as latin1 — which is exactly what Buffer
 * did, and produces the same string for a display name with an é or a — in it.
 * (worker/src/util/flash.js does the same dance for the same reason.)
 */

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const TILE_W = 460;
const TILE_H = 230;

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** `text` -> `data:image/svg+xml;base64,...` tile, ready for a CSS background-image. */
export function buildWatermarkDataUri(text) {
  const label = escapeXml(String(text || '').slice(0, 120));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}" ` +
    `viewBox="0 0 ${TILE_W} ${TILE_H}">` +
    `<g transform="rotate(-28 ${TILE_W / 2} ${TILE_H / 2})" ` +
    `font-family="system-ui, sans-serif" font-size="15" fill="#0d1116" fill-opacity="0.065">` +
    `<text x="-40" y="55">${label}</text>` +
    `<text x="-40" y="150">${label}</text>` +
    `<text x="190" y="10">${label}</text>` +
    `<text x="190" y="105">${label}</text>` +
    `<text x="190" y="200">${label}</text>` +
    `</g></svg>`;
  return `data:image/svg+xml;base64,${base64Utf8(svg)}`;
}
