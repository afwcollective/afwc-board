/**
 * `npm run worker:build` — compile the views, then bundle the Worker.
 *
 * Two steps, in this order, because the bundle imports the generated view
 * registry:
 *   1. worker/build/compile-views.mjs  views/*.ejs → worker/.generated/views.js
 *   2. esbuild                         worker/src/index.js + deps → worker/dist/index.js
 *
 * The bundle is a single ESM file so wrangler has nothing left to resolve —
 * `wrangler dev` and `wrangler deploy` both just take dist/index.js as-is. That
 * also means the build is reproducible offline: everything it needs is in
 * node_modules, and nothing is fetched.
 *
 * Bundling notes:
 *   * `node:*` imports stay external and are provided at runtime by the
 *     nodejs_compat flag in wrangler.toml. sanitize-html's dependency graph
 *     (htmlparser2 → postcss) is the only thing that reaches for them.
 *   * conditions list workerd first so any package shipping a Workers build gets
 *     picked over its Node one.
 *   * the bundle is NOT minified: this is a volunteer-run community app and a
 *     readable stack trace in `wrangler tail` is worth more than the kilobytes.
 *     Flip MINIFY=1 in the environment if a future bundle ever gets close to the
 *     free plan's 3 MB (gzipped) script limit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { compileViews } from './compile-views.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, '..');
const ENTRY = path.join(WORKER_DIR, 'src', 'index.js');
const OUTFILE = path.join(WORKER_DIR, 'dist', 'index.js');

async function main() {
  const quiet = process.argv.includes('--quiet');

  fs.rmSync(path.join(WORKER_DIR, 'dist'), { recursive: true, force: true });
  compileViews({ quiet });

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*'],
    minify: process.env.MINIFY === '1',
    sourcemap: false,
    legalComments: 'none',
    logLevel: quiet ? 'warning' : 'info',
    metafile: true,
  });

  const bytes = fs.statSync(OUTFILE).size;
  if (!quiet) {
    console.log(`[worker] bundled → worker/dist/index.js (${(bytes / 1024).toFixed(0)} KB)`);
  }
  if (result.warnings.length) {
    for (const w of result.warnings) console.warn('[worker] warning:', w.text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
