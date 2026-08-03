'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { db } = require('../db');
const sessions = require('./sessions');
const { flash } = require('../util/flash');

/**
 * loadUser — resolves the session cookie into req.session / req.user and
 * publishes the view locals every template relies on:
 *   currentUser, isLeader, csrfToken, hasUsers
 * Booted users (is_active = 0) are treated as logged out and their cookie is
 * dropped, so deactivation takes effect on the very next request.
 */
function loadUser(req, res, next) {
  let session = null;
  try {
    session = sessions.readSession(req, res);
  } catch {
    session = null;
  }

  if (session && !session.is_active) {
    sessions.destroySession(req, res);
    session = null;
  }

  req.session = session;
  req.user = session
    ? {
        id: session.uid,
        username: session.username,
        display_name: session.display_name,
        role: session.role,
        is_active: session.is_active,
      }
    : null;

  res.locals.currentUser = req.user;
  res.locals.isLeader = !!(req.user && req.user.role === 'leader');
  res.locals.csrfToken = sessions.ensureCsrfToken(req, res, session);
  res.locals.currentPath = req.path;
  next();
}

/** True while the users table is empty — enables /setup and the first-run card. */
function noUsersYet() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

function requireMember(req, res, next) {
  if (req.user && req.user.is_active) return next();
  const next_ = encodeURIComponent(req.originalUrl || '/');
  flash(res, 'error', 'Please sign in to see that.');
  return res.redirect(`/login?next=${next_}`);
}

function requireLeader(req, res, next) {
  if (req.user && req.user.is_active && req.user.role === 'leader') return next();
  if (!req.user) {
    flash(res, 'error', 'Please sign in to see that.');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
  }
  const err = new Error('Leaders only.');
  err.status = 403;
  return next(err);
}

function requireGuest(req, res, next) {
  if (req.user) return res.redirect('/');
  return next();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * checkCsrf — applied to every state-changing request. Two independent gates:
 *   1. the per-session (or pre-auth cookie) token echoed in a hidden _csrf field
 *   2. Origin/Referer host must match the request host when the header is present
 */
function checkCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const host = req.get('host');
  const source = req.get('origin') || req.get('referer');
  if (source) {
    let ok = false;
    try {
      ok = new URL(source).host === host;
    } catch {
      ok = false;
    }
    if (!ok) return csrfFail(req, res, next, 'cross-origin request blocked');
  }

  const supplied = (req.body && (req.body._csrf || req.body.csrf)) || req.get('x-csrf-token');
  const expected = req.session ? req.session.csrf_token : sessions.parseCookies(req)[config.csrfCookie];
  if (!expected || !safeEqual(supplied, expected)) {
    return csrfFail(req, res, next, 'form security token missing or stale');
  }
  return next();
}

function csrfFail(req, res, next, why) {
  const err = new Error(
    `Your session could not be verified (${why}). Please reload the page and try again.`
  );
  err.status = 403;
  return next(err);
}

module.exports = {
  loadUser,
  requireMember,
  requireLeader,
  requireGuest,
  checkCsrf,
  noUsersYet,
  safeEqual,
};
