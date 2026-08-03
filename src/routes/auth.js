'use strict';

const express = require('express');
const { getSetting, setSetting } = require('../db');
const { users } = require('../models');
const { hashPassword, verifyPassword, hashSecret, verifySecret } = require('../auth/passwords');
const sessions = require('../auth/sessions');
const { noUsersYet, requireGuest, safeEqual } = require('../auth/middleware');
const { flash } = require('../util/flash');
const ratelimit = require('../util/ratelimit');
const { normalizeResetCode } = require('../util/resetcode');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;

/** Shared field validation for /setup and /register. Returns array of errors. */
function validateAccount({ username, display_name, password, password2 }) {
  const errors = [];
  if (!USERNAME_RE.test(String(username || '').trim())) {
    errors.push('Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  } else if (users.byUsername(username)) {
    errors.push('That username is already taken.');
  }
  if (!String(display_name || '').trim()) errors.push('Please give a display name.');
  if (String(display_name || '').trim().length > 60) errors.push('Display name is too long.');
  if (String(password || '').length < MIN_PASSWORD) {
    errors.push(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password2 !== undefined && password !== password2) errors.push('The two passwords do not match.');
  return errors;
}

function safeNext(value) {
  const v = String(value || '');
  return /^\/(?!\/)[^\s]*$/.test(v) ? v : '/';
}

/* ------------------------------------------------------------------ setup */
// Available only while the users table is empty. Hard 404 afterwards, so the
// route cannot be used to mint a second leader.

router.get('/setup', (req, res, next) => {
  if (!noUsersYet()) return next();
  return res.render('auth/setup', {
    title: 'First run — set up your board',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
  });
});

router.post('/setup', (req, res, next) => {
  if (!noUsersYet()) return next();
  const { username, display_name, email, password, password2, passcode, passcode2 } = req.body;
  const errors = validateAccount({ username, display_name, password, password2 });
  if (String(passcode || '').trim().length < 4) {
    errors.push('The group passcode must be at least 4 characters.');
  } else if (passcode !== passcode2) {
    errors.push('The two group passcodes do not match.');
  }

  if (errors.length) {
    return res.status(400).render('auth/setup', {
      title: 'First run — set up your board',
      bodyClass: 'page-auth',
      errors,
      values: { username, display_name, email },
    });
  }

  const info = users.create({
    username,
    display_name,
    email,
    password_hash: hashPassword(password),
    role: 'leader',
  });
  setSetting('group_passcode_hash', hashSecret(String(passcode).trim()));
  setSetting('site_name', 'AFWC Board');

  const user = users.byId(info.lastInsertRowid);
  sessions.createSession(res, user, req);
  users.touchLogin(user.id);
  flash(res, 'ok', `Welcome, ${user.display_name}. Your board is live — set the next meeting.`);
  return res.redirect('/admin');
});

/* --------------------------------------------------------------- register */

router.get('/register', requireGuest, (req, res) => {
  res.render('auth/register', {
    title: 'Join the board',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
    setupNeeded: noUsersYet(),
  });
});

router.post('/register', requireGuest, (req, res) => {
  const { username, display_name, email, password, password2, passcode } = req.body;
  const errors = [];

  const stored = getSetting('group_passcode_hash');
  if (!stored) {
    errors.push('Registration is not open yet — a leader still has to set the group passcode.');
  } else if (!verifySecret(String(passcode || '').trim(), stored)) {
    errors.push('That group passcode is not right. Ask a leader for the current one.');
  }
  errors.push(...validateAccount({ username, display_name, password, password2 }));

  if (errors.length) {
    return res.status(400).render('auth/register', {
      title: 'Join the board',
      bodyClass: 'page-auth',
      errors,
      values: { username, display_name, email },
      setupNeeded: noUsersYet(),
    });
  }

  const info = users.create({
    username,
    display_name,
    email,
    password_hash: hashPassword(password),
    role: 'member',
  });
  const user = users.byId(info.lastInsertRowid);
  sessions.createSession(res, user, req);
  users.touchLogin(user.id);
  flash(res, 'ok', `You're in, ${user.display_name}.`);
  return res.redirect('/');
});

/* ------------------------------------------------------------------ login */

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  return res.render('auth/login', {
    title: 'Sign in',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
    next: safeNext(req.query.next),
    setupNeeded: noUsersYet(),
  });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const next = safeNext(req.body.next);

  if (ratelimit.isBlocked(req.ip, username)) {
    return res.status(429).render('auth/login', {
      title: 'Sign in',
      bodyClass: 'page-auth',
      errors: ['Too many attempts — wait a few minutes and try again.'],
      values: { username },
      next,
      setupNeeded: noUsersYet(),
    });
  }

  const user = users.byUsername(username);
  const ok = user && verifyPassword(String(password || ''), user.password_hash);

  if (!ok || !user.is_active) {
    ratelimit.recordFailure(req.ip, username);
    const message = ok && !user.is_active
      ? 'That account is no longer active. Talk to a group leader.'
      : 'Username or password is not right.';
    return res.status(401).render('auth/login', {
      title: 'Sign in',
      bodyClass: 'page-auth',
      errors: [message],
      values: { username },
      next,
      setupNeeded: noUsersYet(),
    });
  }

  ratelimit.clear(req.ip, username);
  sessions.createSession(res, user, req);
  users.touchLogin(user.id);
  flash(res, 'ok', `Signed in as ${user.display_name}.`);
  return res.redirect(next);
});

/* ------------------------------------------------------------------ reset */
// Leader-issued codes, not email — see src/util/resetcode.js. Username + code
// + new password; wrong/expired/reused all fail with the same generic
// message so the form can't be used to probe which usernames exist.

router.get('/reset', requireGuest, (req, res) => {
  res.render('auth/reset', {
    title: 'Reset your password',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
  });
});

router.post('/reset', requireGuest, (req, res) => {
  const { username, code, password, password2 } = req.body;
  const GENERIC_ERROR = 'That reset code is not valid or has expired. Ask a leader for a new one.';

  if (ratelimit.isBlocked(req.ip, username)) {
    return res.status(429).render('auth/reset', {
      title: 'Reset your password',
      bodyClass: 'page-auth',
      errors: ['Too many attempts — wait a few minutes and try again.'],
      values: { username },
    });
  }

  const errors = [];
  if (String(password || '').length < MIN_PASSWORD) {
    errors.push(`New password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password !== password2) errors.push('The two new passwords do not match.');

  const user = users.byUsername(username);
  const supplied = normalizeResetCode(code);
  const validCode =
    !!user &&
    !!user.reset_code_hash &&
    !!user.reset_expires_at &&
    user.reset_expires_at > new Date().toISOString() &&
    safeEqual(sessions.sha256(supplied), user.reset_code_hash);

  if (!validCode) errors.push(GENERIC_ERROR);

  if (errors.length) {
    ratelimit.recordFailure(req.ip, username);
    return res.status(400).render('auth/reset', {
      title: 'Reset your password',
      bodyClass: 'page-auth',
      errors,
      values: { username },
    });
  }

  ratelimit.clear(req.ip, username);
  users.setPasswordHash(user.id, hashPassword(password));
  users.clearResetCode(user.id);
  sessions.destroyAllForUser(user.id);
  sessions.createSession(res, user, req);
  users.touchLogin(user.id);
  flash(res, 'ok', `Password reset. Signed in as ${user.display_name}.`);
  return res.redirect('/');
});

/* ----------------------------------------------------------------- logout */

router.post('/logout', (req, res) => {
  sessions.destroySession(req, res);
  flash(res, 'info', 'Signed out.');
  res.redirect('/');
});

module.exports = router;
