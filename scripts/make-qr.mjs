/**
 * QR + table-tent generator for the AFWC Board's live URL.
 *
 * USAGE
 *   node scripts/make-qr.mjs <url> [outDir] [siteName]
 *
 *   <url>       the live site's URL, e.g. https://afwc-board.<subdomain>.workers.dev
 *   [outDir]    where to write the two output files (default: cwd). NOT run
 *               against the real URL yet, and NOT wired into any build step —
 *               the URL doesn't exist until deploy day (README.md's
 *               DEPLOY-DAY CHECKLIST). Point outDir at a scratch directory
 *               when proving this script works; nothing it writes belongs in
 *               the repo until the real URL is known.
 *   [siteName]  shown on the table-tent (default: "AFWC Board")
 *
 * OUTPUT
 *   qr-afwc.svg       the QR code alone, as a scannable vector image.
 *   table-tent.html   one printable page: site name, "scan to find our
 *                      table", the QR (inlined, no external asset — opens
 *                      and prints correctly from a double-click), and the
 *                      URL spelled out in monospace underneath for anyone
 *                      whose phone camera won't cooperate.
 *
 * NO DEPENDENCIES. The QR matrix comes from scripts/vendor/qr-encoder.mjs, a
 * small encoder written for this repo (see that file's header for exactly
 * what it does and does not implement, and why that's enough for a URL).
 *
 * VERIFYING THIS ACTUALLY SCANS — because a QR code that LOOKS right and a
 * QR code that DECODES right are two different claims, and only the second
 * one matters for a flyer on a table:
 *   1. `node scripts/make-qr.mjs <url> <dir>` writes qr-afwc.svg.
 *   2. Rasterize it (any SVG-to-PNG tool — `rsvg-convert`, a headless
 *      browser screenshot, Chrome DevTools' "Capture node screenshot").
 *   3. Decode the PNG with an independent decoder NOT part of this repo —
 *      `zbarimg` (from the `zbar` package) is a good one:
 *        zbarimg path/to/qr.png
 *      and confirm the printed payload is character-for-character the URL
 *      that went in.
 *   This script does not do that rasterize-and-decode round trip itself —
 *   it has no image or barcode library to do it with, on purpose, per "no
 *   deps" — but it's how this script's output was proven to scan before
 *   this file was committed. Do the same after any change to
 *   scripts/vendor/qr-encoder.mjs before trusting a new printout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { encodeQr } from './vendor/qr-encoder.mjs';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders the module matrix as a crisp, scanner-friendly SVG: one <rect> per dark module, a quiet-zone border, no anti-aliasing gradients. */
function matrixToSvg(size, modules, { quietZone = 4, moduleSize = 8 } = {}) {
  const total = (size + quietZone * 2) * moduleSize;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!modules[r][c]) continue;
      const x = (c + quietZone) * moduleSize;
      const y = (r + quietZone) * moduleSize;
      rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges">`,
    `<rect x="0" y="0" width="${total}" height="${total}" fill="#fff"/>`,
    `<g fill="#000">${rects.join('')}</g>`,
    '</svg>',
  ].join('\n');
}

function tableTentHtml({ siteName, url, svgMarkup }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(siteName)} — table tent</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Georgia, 'Times New Roman', serif;
    color: #16181d;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #f4f1ea;
  }
  .card {
    width: 100%;
    max-width: 6.5in;
    text-align: center;
    padding: 0.75in 0.5in;
  }
  .eyebrow {
    font-family: 'Courier New', monospace;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-size: 13px;
    color: #3b5bdb;
    margin: 0 0 0.15in;
  }
  h1 {
    font-size: 40px;
    margin: 0 0 0.35in;
    line-height: 1.15;
  }
  .qr-wrap {
    display: inline-block;
    padding: 16px;
    background: #fff;
    border: 1px solid #16181d;
    margin: 0 0 0.3in;
  }
  .qr-wrap svg { display: block; width: 2.6in; height: 2.6in; }
  .url {
    font-family: 'Courier New', monospace;
    font-size: 15px;
    letter-spacing: 0.02em;
    word-break: break-all;
    color: #444;
  }
  @media print {
    body { background: #fff; }
    .card { padding: 0; }
  }
</style>
</head>
<body>
  <div class="card">
    <p class="eyebrow">${escapeHtml(siteName)}</p>
    <h1>Scan to find our table</h1>
    <div class="qr-wrap">${svgMarkup}</div>
    <p class="url">${escapeHtml(url)}</p>
  </div>
</body>
</html>
`;
}

function main() {
  const [, , url, outDirArg, siteNameArg] = process.argv;
  if (!url) {
    console.error('Usage: node scripts/make-qr.mjs <url> [outDir] [siteName]');
    process.exit(1);
  }
  const outDir = path.resolve(outDirArg || process.cwd());
  const siteName = siteNameArg || 'AFWC Board';

  fs.mkdirSync(outDir, { recursive: true });

  const { size, modules } = encodeQr(url);
  const svgMarkup = matrixToSvg(size, modules);

  const svgPath = path.join(outDir, 'qr-afwc.svg');
  fs.writeFileSync(svgPath, svgMarkup + '\n', 'utf8');

  const htmlPath = path.join(outDir, 'table-tent.html');
  fs.writeFileSync(htmlPath, tableTentHtml({ siteName, url, svgMarkup }), 'utf8');

  console.log(`[qr] version ${(size - 17) / 4}, ${size}x${size} modules, level M`);
  console.log(`[qr] wrote ${svgPath}`);
  console.log(`[qr] wrote ${htmlPath}`);
  console.log('[qr] verify it scans before trusting a printout — see this script\'s header.');
}

main();
