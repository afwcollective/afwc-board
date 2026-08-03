'use strict';

/**
 * The signed-in member's own account page — currently just a password
 * change. Mounted at / by src/app.js, next to auth.js (a full
 * src/routes/auth.js already owns /login /register /reset; this file is
 * separate because it is member-only rather than guest-only).
 */

const express = require('express');
const { users } = require('../models');
const { requireMember } = require('../auth/middleware');
const { hashPassword, verifyPassword } = require('../auth/passwords');
const sessions = require('../auth/sessions');
const { flash } = require('../util/flash');

const router = express.Router();

const MIN_PASSWORD = 8;

router.get('/account', requireMember, (req, res) => {
  res.render('account/show', {
    title: 'Your account',
    errors: [],
  });
});

router.post('/account/password', requireMember, (req, res) => {
  const { current_password, new_password, new_password2 } = req.body;
  const user = users.byId(req.user.id);
  const errors = [];

  if (!user || !verifyPassword(String(current_password || ''), user.password_hash)) {
    errors.push('Current password is not right.');
  }
  if (String(new_password || '').length < MIN_PASSWORD) {
    errors.push(`New password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (new_password !== new_password2) {
    errors.push('The two new passwords do not match.');
  }

  if (errors.length) {
    return res.status(400).render('account/show', {
      title: 'Your account',
      errors,
    });
  }

  users.setPasswordHash(req.user.id, hashPassword(new_password));
  // Rotate: kill every other session, keep the one making this request alive.
  sessions.destroyOtherSessions(req, req.user.id);
  flash(res, 'ok', 'Password changed. Any other signed-in sessions were signed out.');
  return res.redirect('/account');
});

module.exports = router;
