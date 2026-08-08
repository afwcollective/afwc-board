/**
 * `npm run worker:verify` — the one-command pre-deploy check for this phase
 * and every one after it: build, parity, then (if a dev server happens to be
 * up) a handful of unauthenticated smoke requests against it.
 *
 * USAGE
 *   npm run worker:verify
 *     Always builds (worker/build/build.mjs) and checks view parity
 *     (worker/build/view-parity.mjs). If something is already answering at
 *     http://localhost:8787 — e.g. `npm run worker:dev` running in another
 *     terminal — it also fires a few plain GETs at it and checks status codes
 *     and the security headers every response is supposed to carry. If
 *     nothing is listening there, that part is SKIPPED, not failed: this
 *     script is meant to run in CI (a future P6 GitHub Actions workflow) with
 *     no server available, as well as on a laptop with `wrangler dev` open in
 *     a second tab.
 *
 * WHAT THIS DOES NOT DO — deliberately out of scope for a "quick" script:
 *   * exercise the Cron Trigger handlers. `wrangler dev --local
 *     --test-scheduled` (a flag on top of the same `npm run worker:dev`
 *     command) exposes GET /__scheduled?cron=<expression> for that — take the
 *     three cron strings from wrangler.toml's [triggers], URL-encode their
 *     spaces as `+`, and curl each one, e.g. the 15-minute sweep is
 *     `curl "http://localhost:8787/__scheduled?cron=" + <that expression with
 *     spaces turned into +>`. Fire one, then `wrangler tail` or the dev
 *     server's own console shows the job's console.log line — see
 *     worker/src/scheduled.js for what each one prints.
 *   * log in or exercise anything behind requireMember/requireLeader — that
 *     needs real session cookies, which is a job for a fuller E2E pass (P6),
 *     not a 30-second smoke check.
 *   * touch D1 or R2 directly; every check here is an HTTP request the same
 *     as a browser would make.
 *
 * Exit code is non-zero if the build fails, if view parity finds a mismatch,
 * or if the dev server IS up but fails a smoke check — never for the server
 * simply not being there.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, '..');
const DEV_URL = 'http://localhost:8787';
const FETCH_TIMEOUT_MS = 2000;

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function runNode(scriptRelToWorker, args = []) {
  const script = path.join(WORKER_DIR, scriptRelToWorker);
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  return result.status === 0;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

async function devServerUp() {
  try {
    await fetchWithTimeout(DEV_URL + '/');
    return true;
  } catch {
    return false;
  }
}

const SECURITY_HEADERS = ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'content-security-policy'];

/**
 * Path, expected status (or an array of acceptable ones), and a short label.
 * Every one of these is reachable with no session cookie at all, which is
 * exactly the point — this script proves the app is UP and answering with the
 * right shape, not that any particular feature works end to end.
 */
const SMOKE_CHECKS = [
  ['/', 200, 'landing page'],
  ['/login', 200, 'login form'],
  ['/healthz', 200, 'health check'],
  ['/admin', [302, 303], 'admin dashboard, logged out → redirect to /login'],
  // requireLeader guards the whole admin router (worker/src/routes/admin.js),
  // so a logged-out request never reaches backup.zip's own 301 — it is caught
  // here first, same as any other /admin/* path.
  ['/admin/backup.zip', [302, 303], 'legacy backup.zip URL, logged out → redirect to /login'],
  ['/nonexistent-page-xyz', 404, '404 page'],
];

async function smokeCheck() {
  let bad = 0;
  for (const [urlPath, expected, label] of SMOKE_CHECKS) {
    const wantStatuses = Array.isArray(expected) ? expected : [expected];
    try {
      const res = await fetchWithTimeout(DEV_URL + urlPath);
      const ok = wantStatuses.includes(res.status);
      const missingHeaders = SECURITY_HEADERS.filter((h) => !res.headers.get(h));
      if (ok && !missingHeaders.length) {
        console.log(`OK    ${label}  (${urlPath} → ${res.status})`);
      } else {
        bad += 1;
        if (!ok) console.log(`FAIL  ${label}  (${urlPath} → ${res.status}, wanted ${wantStatuses.join('/')})`);
        if (missingHeaders.length) {
          console.log(`FAIL  ${label}  (${urlPath} missing security header(s): ${missingHeaders.join(', ')})`);
        }
      }
    } catch (err) {
      bad += 1;
      console.log(`FAIL  ${label}  (${urlPath} → request error: ${err.message})`);
    }
  }
  return bad;
}

async function main() {
  step('build (worker/build/build.mjs)');
  const buildOk = runNode('build/build.mjs', ['--quiet']);
  if (!buildOk) {
    console.error('\nBuild failed — stopping here.');
    process.exit(1);
  }

  step('view parity (worker/build/view-parity.mjs)');
  const parityOk = runNode('build/view-parity.mjs');

  step(`smoke checks against ${DEV_URL}`);
  let smokeBad = 0;
  if (await devServerUp()) {
    smokeBad = await smokeCheck();
  } else {
    console.log(`Nothing answering at ${DEV_URL} — skipping. Run \`npm run worker:dev\` in another`);
    console.log('terminal first to include this step (this is expected, not a failure, in CI).');
  }

  step('summary');
  console.log(`build:   ${buildOk ? 'OK' : 'FAILED'}`);
  console.log(`parity:  ${parityOk ? 'OK' : 'FAILED'}`);
  console.log(`smoke:   ${smokeBad === 0 ? 'OK (or skipped)' : `${smokeBad} FAILED`}`);

  process.exit(buildOk && parityOk && smokeBad === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
