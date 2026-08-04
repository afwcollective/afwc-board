'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { db } = require('../db');
const sessions = require('./sessions');
const roles = require('./roles');
const { flash } = require('../util/flash');

/**
 * Required lazily: src/models.js is the query layer that sits ON TOP of this
 * file's siblings, and pulling it in at module scope would make the auth layer
 * depend on it at load time. One call, one statement — see loadUser below.
 */
function hostsHasUpcoming(userId) {
  try {
    // eslint-disable-next-line global-require
    return require('../models').hosts.hasUpcoming(userId);
  } catch (err) {
    // A database that has not reached migration 004 yet has no occurrence_hosts
    // table. Nobody is hosting anything on it, which is exactly what to answer.
    return false;
  }
}

/** Prepared lazily — db.js is required before the users table exists on boot. */
const expireLeaderStmt = () =>
  db.prepare(
    `UPDATE users SET role = 'member', role_expires_at = NULL
      WHERE id = ? AND role = 'leader' AND role_expires_at IS NOT NULL AND role_expires_at <= ?`
  );

/**
 * A time-boxed leader whose term has run out, demoted the moment they touch the
 * app. Cheap by design: one guarded UPDATE, and only when the loaded session row
 * actually carries an expiry that has passed. The boot sweep in src/db.js covers
 * everyone who is not making a request.
 *
 * The demotion never touches sessions — losing leadership is not being booted.
 * They stay signed in and simply stop seeing /admin from this request on.
 */
function expireRoleIfDue(session) {
  if (!session || session.role !== roles.LEADER) return session;
  const expires = session.role_expires_at;
  if (!expires || expires > new Date().toISOString()) return session;
  expireLeaderStmt().run(session.uid, new Date().toISOString());
  session.role = roles.MEMBER;
  session.role_expires_at = null;
  return session;
}

/**
 * loadUser — resolves the session cookie into req.session / req.user and
 * publishes the view locals every template relies on:
 *   currentUser, isLeader, isArchitect, isHost, csrfToken, hasUsers
 * Booted users (is_active = 0) are treated as logged out and their cookie is
 * dropped, so deactivation takes effect on the very next request.
 *
 * res.locals.isHost — "this member is running a session in the next 30 days."
 * One prepared statement (models.hosts.hasUpcoming), run only when somebody is
 * signed in, and false for everyone else. It is published as a FACT, not as a
 * gate: nothing in this file or in the routes it fronts uses it to allow or
 * refuse anything. Host authorization is always per-occurrence and checked
 * server-side against the actual assignment in src/routes/host.js — a boolean
 * that says "hosting something, somewhere, this month" is not permission to
 * edit any particular meeting. Views may use it to offer a link; the sprint
 * timer's own gate is wired to it separately.
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

  session = expireRoleIfDue(session);

  req.session = session;
  req.user = session
    ? {
        id: session.uid,
        username: session.username,
        display_name: session.display_name,
        role: session.role,
        role_expires_at: session.role_expires_at,
        is_active: session.is_active,
      }
    : null;

  res.locals.currentUser = req.user;
  res.locals.isLeader = roles.isLeaderUser(req.user);
  res.locals.isArchitect = roles.isArchitectUser(req.user);
  res.locals.isHost = req.user ? hostsHasUpcoming(req.user.id) : false;
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

/** Leaders and the architect — the whole /admin console. */
function requireLeader(req, res, next) {
  if (req.user && req.user.is_active && roles.isLeaderUser(req.user)) return next();
  if (!req.user) {
    flash(res, 'error', 'Please sign in to see that.');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
  }
  const err = new Error('Leaders only.');
  err.status = 403;
  return next(err);
}

/**
 * The architect alone: anything that moves another account downward, and the
 * transfer of the chair itself. Server-side twin of the buttons the members
 * view hides — never trust the view.
 */
function requireArchitect(req, res, next) {
  if (req.user && req.user.is_active && roles.isArchitectUser(req.user)) return next();
  if (!req.user) {
    flash(res, 'error', 'Please sign in to see that.');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
  }
  const err = new Error('Only the architect can manage leaders.');
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
  requireArchitect,
  requireGuest,
  checkCsrf,
  noUsersYet,
  safeEqual,
};
