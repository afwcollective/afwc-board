'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { db } = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- cookies (hand-rolled; no cookie-parser dependency) ---------- */

function parseCookies(req) {
  if (req._cookies) return req._cookies;
  const out = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (!k || k in out) continue;
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  req._cookies = out;
  return out;
}

function setCookie(res, name, value, opts = {}) {
  res.cookie(name, value, {
    httpOnly: opts.httpOnly !== false,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    ...opts,
  });
}

function clearCookie(res, name) {
  res.clearCookie(name, { path: '/', sameSite: 'lax', secure: config.isProd, httpOnly: true });
}

/* ---------- session tokens ---------- */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

const stmt = {
  insert: () =>
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
  find: () =>
    db.prepare(
      `SELECT s.token_hash, s.user_id, s.csrf_token, s.expires_at,
              u.id AS uid, u.username, u.display_name, u.role, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    ),
  touch: () => db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
  del: () => db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delForUser: () => db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  sweep: () => db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
};

/** Creates a session row and sets the HttpOnly cookie. Returns the session. */
function createSession(res, user, req) {
  const token = newToken();
  const csrf = newToken();
  const expires = new Date(Date.now() + config.sessionTtlDays * DAY_MS);
  stmt.insert().run(
    sha256(token),
    user.id,
    csrf,
    expires.toISOString(),
    (req && req.get && req.get('user-agent')) || null,
    (req && req.ip) || null
  );
  setCookie(res, config.sessionCookie, token, { maxAge: config.sessionTtlDays * DAY_MS });
  // Once a real session exists the pre-auth CSRF cookie is dead weight.
  clearCookie(res, config.csrfCookie);
  return { csrf_token: csrf, user_id: user.id, expires_at: expires.toISOString() };
}

/**
 * Looks up the session from the request cookie. Rolls the expiry forward when
 * it is more than a day old. Returns null when absent/expired/unknown.
 */
function readSession(req, res) {
  const token = parseCookies(req)[config.sessionCookie];
  if (!token) return null;
  const row = stmt.find().get(sha256(token));
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    stmt.del().run(row.token_hash);
    if (res) clearCookie(res, config.sessionCookie);
    return null;
  }
  // rolling expiry: extend at most once a day to avoid a write per request
  const fresh = new Date(Date.now() + config.sessionTtlDays * DAY_MS);
  if (new Date(row.expires_at).getTime() - Date.now() < (config.sessionTtlDays - 1) * DAY_MS) {
    stmt.touch().run(fresh.toISOString(), row.token_hash);
    if (res) setCookie(res, config.sessionCookie, token, { maxAge: config.sessionTtlDays * DAY_MS });
  }
  return row;
}

function destroySession(req, res) {
  const token = parseCookies(req)[config.sessionCookie];
  if (token) stmt.del().run(sha256(token));
  clearCookie(res, config.sessionCookie);
}

/** Instant revocation — used when a leader deactivates a member. */
function destroyAllForUser(userId) {
  return stmt.delForUser().run(userId).changes;
}

function sweepExpired() {
  return stmt.sweep().run().changes;
}

/**
 * CSRF token for the current request. Logged-in requests use the session's
 * token; logged-out forms (/setup, /login, /register) get a cookie-backed one.
 */
function ensureCsrfToken(req, res, session) {
  if (session && session.csrf_token) return session.csrf_token;
  const cookies = parseCookies(req);
  let token = cookies[config.csrfCookie];
  if (!token || token.length < 20) {
    token = newToken();
    cookies[config.csrfCookie] = token;
    setCookie(res, config.csrfCookie, token, { maxAge: 12 * 60 * 60 * 1000 });
  }
  return token;
}

module.exports = {
  parseCookies,
  setCookie,
  clearCookie,
  sha256,
  newToken,
  createSession,
  readSession,
  destroySession,
  destroyAllForUser,
  sweepExpired,
  ensureCsrfToken,
};
