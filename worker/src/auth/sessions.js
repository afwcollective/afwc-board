/**
 * Port of src/auth/sessions.js. The DESIGN is untouched (PORT-CLOUDFLARE.md §7):
 * a crypto-random opaque token in an HttpOnly cookie, only its SHA-256 stored in
 * D1, a per-session CSRF token, and a rolling 30-day expiry extended at most
 * once a day so a browse does not cost a write.
 *
 * Two mechanical changes:
 *   * sha256 is crypto.subtle.digest, so every function that touches a token is
 *     async. Callers await; nothing else moved.
 *   * cookies go through worker/src/util/cookies.js (Hono's Set-Cookie writer)
 *     instead of Express's res.cookie. Same names, same attributes.
 */

import config from '../config.js';
import { one, run } from '../db.js';
import { parseCookies, setCookie, clearCookie } from '../util/cookies.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- tokens ---------- */

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Hex SHA-256, the same digest the Express app stored. */
export async function sha256(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return hex(new Uint8Array(buf));
}

/** 32 random bytes, base64url — the same shape crypto.randomBytes(32) gave. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- sessions ---------- */

const FIND_SQL = `
  SELECT s.token_hash, s.user_id, s.csrf_token, s.expires_at,
         u.id AS uid, u.username, u.display_name, u.role, u.role_expires_at, u.is_active
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = ?`;

/** Creates a session row and sets the HttpOnly cookie. Returns the session. */
export async function createSession(c, db, user) {
  const token = newToken();
  const csrf = newToken();
  const expires = new Date(Date.now() + config.sessionTtlDays * DAY_MS);
  await run(
    db,
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    await sha256(token),
    user.id,
    csrf,
    expires.toISOString(),
    c.req.header('user-agent') || null,
    c.req.header('cf-connecting-ip') || null
  );
  setCookie(c, config.sessionCookie, token, { maxAge: config.sessionTtlDays * DAY_MS });
  // Once a real session exists the pre-auth CSRF cookie is dead weight.
  clearCookie(c, config.csrfCookie);
  return { csrf_token: csrf, user_id: user.id, expires_at: expires.toISOString() };
}

/**
 * Looks up the session from the request cookie. Rolls the expiry forward when
 * it is more than a day old. Returns null when absent/expired/unknown.
 */
export async function readSession(c, db) {
  const token = parseCookies(c)[config.sessionCookie];
  if (!token) return null;
  const hash = await sha256(token);
  const row = await one(db, FIND_SQL, hash);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await run(db, 'DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
    clearCookie(c, config.sessionCookie);
    return null;
  }
  // rolling expiry: extend at most once a day to avoid a write per request
  if (new Date(row.expires_at).getTime() - Date.now() < (config.sessionTtlDays - 1) * DAY_MS) {
    const fresh = new Date(Date.now() + config.sessionTtlDays * DAY_MS);
    await run(db, 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', fresh.toISOString(), row.token_hash);
    setCookie(c, config.sessionCookie, token, { maxAge: config.sessionTtlDays * DAY_MS });
  }
  return row;
}

export async function destroySession(c, db) {
  const token = parseCookies(c)[config.sessionCookie];
  if (token) await run(db, 'DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
  clearCookie(c, config.sessionCookie);
}

/** Instant revocation — used when a leader deactivates a member. */
export async function destroyAllForUser(db, userId) {
  const meta = await run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
  return meta.changes || 0;
}

/**
 * Password-change rotation: kill every OTHER session for this user, keeping
 * the one making this request alive. Falls back to destroyAllForUser when the
 * request has no readable session cookie (defensive — should not happen for
 * an authenticated POST).
 */
export async function destroyOtherSessions(c, db, userId) {
  const token = parseCookies(c)[config.sessionCookie];
  if (!token) return destroyAllForUser(db, userId);
  const meta = await run(
    db,
    'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?',
    userId,
    await sha256(token)
  );
  return meta.changes || 0;
}

export async function sweepExpired(db) {
  const meta = await run(
    db,
    "DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')"
  );
  return meta.changes || 0;
}

/**
 * CSRF token for the current request. Logged-in requests use the session's
 * token; logged-out forms (/setup, /login, /register, /reset) get a
 * cookie-backed one that lives 12 hours.
 */
export function ensureCsrfToken(c, session) {
  if (session && session.csrf_token) return session.csrf_token;
  const cookies = parseCookies(c);
  let token = cookies[config.csrfCookie];
  if (!token || token.length < 20) {
    token = newToken();
    // Stash it so checkCsrf on THIS request sees the same value the form got.
    c.set('freshCsrfCookie', token);
    setCookie(c, config.csrfCookie, token, { maxAge: 12 * 60 * 60 * 1000 });
  }
  return token;
}
