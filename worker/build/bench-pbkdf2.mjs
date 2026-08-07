/**
 * `npm run worker:bench:pbkdf2` — measure what one PBKDF2 derive actually costs
 * inside workerd, so the iteration count in worker/src/auth/passwords.js is a
 * measurement rather than a guess.
 *
 * WHY THIS IS MEASURED FROM OUTSIDE THE WORKER: Date.now() and performance.now()
 * inside workerd do not advance during pure computation — the clock only moves
 * on I/O, as a Spectre mitigation. An in-Worker stopwatch around the derive
 * therefore reports 0 ms no matter how many iterations you ask for. The only
 * honest reading is wall-clock from the client.
 *
 * METHOD: a throwaway Worker (written to worker/.generated/, never committed)
 * exposes GET /?iters=N&n=K, which performs K PBKDF2-SHA256 derives with the
 * same WebCrypto call worker/src/auth/passwords.js makes. Timing a request with
 * K derives against an otherwise identical request with K = 0 cancels out
 * everything that is not the hash: HTTP, the dev proxy, the isolate. The
 * difference divided by K is the cost of one derive.
 *
 * The bench boots its own `wrangler dev` on port 8788 so it never disturbs the
 * app's 8787.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GEN = path.join(ROOT, 'worker', '.generated');
const PORT = 8788;

/** The sweep brackets the chosen ITERATIONS so a re-run re-derives the choice. */
const SETTINGS = [25000, 50000, 60000, 75000, 100000, 150000, 210000];
const DERIVES_PER_REQUEST = 20;
const SAMPLES = 15;

const WORKER_SRC = `
const enc = new TextEncoder();
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const iters = Number(url.searchParams.get('iters') || 100000);
    const n = Number(url.searchParams.get('n') || 0);
    const salt = new Uint8Array(16);
    const key = await crypto.subtle.importKey('raw', enc.encode('a-test-password'), 'PBKDF2', false, ['deriveBits']);
    let sink = 0;
    for (let i = 0; i < n; i += 1) {
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256);
      sink += new Uint8Array(bits)[0];
    }
    return new Response('ok ' + sink);
  },
};
`;

const CONFIG_SRC = `
name = "afwc-pbkdf2-bench"
main = "bench-worker.js"
compatibility_date = "2026-08-01"
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timeRequest(url) {
  const started = performance.now();
  const res = await fetch(url);
  await res.text();
  return performance.now() - started;
}

async function median(url, samples) {
  const times = [];
  for (let i = 0; i < samples; i += 1) times.push(await timeRequest(url));
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

async function main() {
  fs.mkdirSync(GEN, { recursive: true });
  const workerFile = path.join(GEN, 'bench-worker.js');
  const configFile = path.join(GEN, 'bench-wrangler.toml');
  fs.writeFileSync(workerFile, WORKER_SRC, 'utf8');
  fs.writeFileSync(configFile, CONFIG_SRC, 'utf8');

  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--config', configFile, '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore' }
  );

  const base = `http://127.0.0.1:${PORT}/`;
  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        await fetch(`${base}?iters=1000&n=1`);
        break;
      } catch {
        await sleep(1000);
      }
    }

    // warm the isolate so the first setting is not charged for startup
    await median(`${base}?iters=100000&n=5`, 5);

    console.log('');
    console.log('  PBKDF2-SHA256 under wrangler dev --local (workerd)');
    console.log(`  ${DERIVES_PER_REQUEST} derives/request, median of ${SAMPLES} requests`);
    console.log('');
    console.log('  iterations   control    with derives    per derive');
    console.log('  ----------   -------    ------------    ----------');

    for (const iters of SETTINGS) {
      const control = await median(`${base}?iters=${iters}&n=0`, SAMPLES);
      const loaded = await median(`${base}?iters=${iters}&n=${DERIVES_PER_REQUEST}`, SAMPLES);
      const per = (loaded - control) / DERIVES_PER_REQUEST;
      console.log(
        `  ${String(iters).padStart(10)}   ${control.toFixed(1).padStart(5)} ms   ` +
          `${loaded.toFixed(1).padStart(9)} ms    ${per.toFixed(2).padStart(6)} ms`
      );
    }
    console.log('');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(workerFile, { force: true });
    fs.rmSync(configFile, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
