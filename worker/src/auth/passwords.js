/**
 * Password hashing on Workers — PBKDF2-SHA256 via WebCrypto.
 *
 * WHY NOT SCRYPT (what src/auth/passwords.js used): crypto.subtle has no scrypt,
 * and workerd has no node:crypto scryptSync. A pure-JS scrypt would be an order
 * of magnitude slower than the native one AND would burn the whole 10 ms CPU
 * budget, so it is worse on both axes. PBKDF2-SHA256 is native in workerd,
 * which makes it the only credible option — the trade is that PBKDF2 is not
 * memory-hard, so it buys less per unit of work against a GPU attacker than
 * scrypt did. The mitigations that make that acceptable here are the ones the
 * app already had: registration is behind a shared group passcode, login is rate
 * limited (10 failures / 15 min per IP+username, worker/src/util/ratelimit.js),
 * and the hashes never leave D1.
 *
 * STORED FORMAT — "pbkdf2$<iters>$<saltB64>$<hashB64>"
 * The iteration count travels WITH the hash, so raising ITERATIONS later
 * verifies old passwords at their original cost and only new/changed passwords
 * pay the new one. No migration, no flag day.
 *
 * ------------------------------------------------------------------ CPU ----
 * MEASURED, not guessed. `npm run worker:bench:pbkdf2` boots a throwaway Worker
 * under `wrangler dev --local` (workerd) and times 20 derives per request
 * against an identical zero-derive control, median of 15 requests. Apple
 * M-series laptop, wrangler 4.120, 2026-08-07:
 *
 *   iterations   control   with 20 derives   per derive
 *   ----------   -------   ---------------   ----------
 *       25,000    1.2 ms          41.5 ms      2.01 ms
 *       50,000    1.4 ms          88.1 ms      4.33 ms
 *       60,000    1.0 ms          96.0 ms      4.75 ms   ← chosen
 *       75,000    1.0 ms         121.4 ms      6.02 ms
 *      100,000    1.1 ms         163.3 ms      8.11 ms
 *      150,000    1.2 ms         255.2 ms     12.70 ms
 *      210,000    1.0 ms         357.1 ms     17.81 ms
 *
 * The relationship is linear at ~0.079 ms per 1,000 iterations, which makes the
 * budget arithmetic simple: the plan allows ~5 ms for hashing out of the free
 * plan's 10 ms per-request CPU, and 60,000 is the largest round number that
 * fits, leaving ~5 ms for the D1 round-trips and the template render. Never more
 * than one derive per request — /login verifies once, /register and /reset hash
 * once.
 *
 * WHAT 60,000 COSTS US, stated plainly: OWASP's 2023 guidance for PBKDF2-SHA256
 * is 600,000 iterations, ten times this. That number assumes a server whose only
 * job is the login and cannot be paid for out of a 10 ms budget on a free plan;
 * the plan (PORT-CLOUDFLARE.md §5) fixes the budget, so the budget wins and the
 * gap is covered elsewhere: registration is gated by a shared group passcode,
 * login and reset are rate limited to 10 failures per 15 minutes per IP+username
 * (worker/src/util/ratelimit.js), the hashes never leave D1, and every password
 * is a volunteer writing group's, not a bank's. If the board ever moves to a
 * paid plan the only change needed is this constant — the iteration count
 * travels inside each stored hash, so old passwords keep verifying at their own
 * cost and nothing has to be migrated.
 *
 * NOTE ON MEASUREMENT: the timings are wall-clock from OUTSIDE the Worker, on
 * purpose. Date.now() inside workerd does not advance during pure computation
 * (it only moves on I/O, as a Spectre mitigation), so an in-Worker stopwatch
 * around the derive reports zero and is worse than useless.
 */

const ITERATIONS = 60000;
const KEY_BITS = 256; // 32 bytes
const SALT_BYTES = 16;

const enc = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function derive(plain, salt, iterations, bits = KEY_BITS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(plain)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const buf = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    bits
  );
  return new Uint8Array(buf);
}

/** Returns "pbkdf2$<iters>$<saltB64>$<hashB64>". */
export async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Constant-time verify. Never throws on malformed stored values — a row whose
 * password_hash is empty, truncated or in some older format simply fails to
 * verify, exactly like the scrypt version did.
 */
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5000000) return false;

  let salt;
  let expected;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== KEY_BITS / 8) return false;

  let actual;
  try {
    actual = await derive(plain, salt, iterations, expected.length * 8);
  } catch {
    return false;
  }
  return timingSafeEqualBytes(actual, expected);
}

/** Byte compare with no early exit. */
export function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Same format, used for the shared group passcode and one-time reset codes. */
export const hashSecret = hashPassword;
export const verifySecret = verifyPassword;

export { ITERATIONS };
