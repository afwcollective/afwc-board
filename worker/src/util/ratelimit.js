/**
 * Login / reset rate limiter, D1-backed.
 *
 * src/util/ratelimit.js kept its buckets in a process-local Map. That is exactly
 * right for one long-lived Node process and exactly wrong for Workers: every
 * request may land in a different isolate, and an isolate is evicted whenever
 * the runtime feels like it, so an in-memory bucket would forget a brute-force
 * attempt between the third guess and the fourth. The bucket therefore moves
 * into D1 (table `rate_limits`, added in migrations/0001_init.sql).
 *
 * The POLICY is unchanged: 10 failures per 15 minutes, keyed by IP + username so
 * one noisy IP guessing many usernames does not lock out the whole building and
 * one username hit from many IPs still gets throttled per-source. A success
 * clears the key immediately.
 *
 * Cost: two round-trips on a failed login (isBlocked + recordFailure) and one on
 * a successful one. Both are single-row primary-key operations, which is the
 * cheapest thing D1 does.
 */

import { one, run } from '../db.js';

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILS = 10;

function keyFor(ip, username) {
  return `${ip || 'unknown'}|${String(username || '').trim().toLowerCase()}`;
}

/**
 * The caller's IP. Cloudflare sets CF-Connecting-IP on every real request; under
 * `wrangler dev --local` there is no edge to set it, so the key collapses to
 * "unknown" for every local caller — which is what makes the rate-limit
 * verification step reproducible from one terminal.
 */
export function clientIp(c) {
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown';
}

/** True once a key has hit MAX_FAILS within the current window. */
export async function isBlocked(db, ip, username) {
  const key = keyFor(ip, username);
  const row = await one(db, 'SELECT count, reset_at FROM rate_limits WHERE key = ?', key);
  if (!row) return false;
  if (Date.now() > row.reset_at) {
    await run(db, 'DELETE FROM rate_limits WHERE key = ?', key);
    return false;
  }
  return row.count >= MAX_FAILS;
}

/**
 * One failure against a key. The window is restarted, rather than extended,
 * when the previous one has already elapsed — same as the Node version, done in
 * a single upsert so two simultaneous guesses cannot both read a stale count.
 */
export async function recordFailure(db, ip, username) {
  const key = keyFor(ip, username);
  const now = Date.now();
  await run(
    db,
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count    = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END`,
    key,
    now + WINDOW_MS,
    now,
    now,
    now + WINDOW_MS
  );
}

/** A success (or a leader's own recovery) clears the key immediately. */
export async function clear(db, ip, username) {
  await run(db, 'DELETE FROM rate_limits WHERE key = ?', keyFor(ip, username));
}

/**
 * Drop every elapsed bucket. The Node version did this on a setInterval, which a
 * Worker has no equivalent of; this is called from the P5 Cron Trigger and is
 * safe to call at any time — an elapsed row is already treated as absent by
 * isBlocked, so the sweep is housekeeping, not correctness.
 */
export async function sweepExpired(db) {
  const meta = await run(db, 'DELETE FROM rate_limits WHERE reset_at <= ?', Date.now());
  return meta.changes || 0;
}
