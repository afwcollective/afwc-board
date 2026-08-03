'use strict';

/**
 * In-memory login/reset rate limiter — a single process, no Redis, no build
 * step. Keyed by IP + username so one noisy IP guessing many usernames does
 * not lock out the whole building, and one username hit from many IPs still
 * gets throttled per-source.
 *
 * 10 failures / 15 minutes per key, then a friendly "wait a few minutes".
 * A success (or a leader's own recovery) clears the key immediately.
 *
 * This resets on every process restart, which is fine for a single-instance
 * app run by volunteers — see the plan's "exactly one instance" deployment
 * note.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

/** @type {Map<string, {count: number, resetAt: number}>} */
const buckets = new Map();

function keyFor(ip, username) {
  return `${ip || 'unknown'}|${String(username || '').trim().toLowerCase()}`;
}

/** True once a key has hit MAX_FAILS within the current window. */
function isBlocked(ip, username) {
  const bucket = buckets.get(keyFor(ip, username));
  if (!bucket) return false;
  if (Date.now() > bucket.resetAt) {
    buckets.delete(keyFor(ip, username));
    return false;
  }
  return bucket.count >= MAX_FAILS;
}

function recordFailure(ip, username) {
  const key = keyFor(ip, username);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) bucket = { count: 0, resetAt: now + WINDOW_MS };
  bucket.count += 1;
  buckets.set(key, bucket);
}

function clear(ip, username) {
  buckets.delete(keyFor(ip, username));
}

// Keep the map from growing forever on a long-lived process.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000);
sweep.unref();

module.exports = { isBlocked, recordFailure, clear, MAX_FAILS, WINDOW_MS };
