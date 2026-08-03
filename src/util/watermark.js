'use strict';

/**
 * Builds the tiled, low-opacity reader watermark as an inline SVG data: URI —
 * pure CSS/markup, no extra request, nothing to route through the anti-
 * download gate. The text is the CURRENT VIEWER's display name + username, so
 * a leaked screenshot is attributable to whoever took it.
 *
 * Kept deliberately faint (fill-opacity ~0.06) and tiled at an angle so it
 * reads as texture, not noise — the underlying page must stay comfortably
 * readable through it.
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

/** `text` -> `data:image/svg+xml;base64,...` tile, ready for a CSS background-image. */
function buildWatermarkDataUri(text) {
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
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

module.exports = { buildWatermarkDataUri };
