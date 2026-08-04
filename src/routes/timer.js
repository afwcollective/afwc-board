'use strict';

/**
 * Writing-sprint timer (standalone).
 * Mounted at /timer by src/app.js — add routes here, not there.
 *
 * GATE: leader-only (requireLeader — leader or architect, see
 * src/auth/middleware.js). A leader hosts the meeting and runs the timer;
 * members see it as the floating widget's "Full screen" link, which is
 * useless to them without this same gate, so there's no separate public view
 * to keep in sync.
 *
 * Access is leaders OR session hosts (someone assigned to run an upcoming
 * session — res.locals.isHost, computed in loadUser). The matching
 * client-side gates are the isLeader || isHost guards around the widget
 * include in views/layout.ejs (search "timer-widget") and the Timer link in
 * views/partials/nav.ejs — all three must move together or the nav link /
 * widget will disagree with what the route actually allows.
 *
 * The phase engine (manual sprint/break + opt-in auto session plans) is
 * computed client-side in public/js/timer-core.js — this route only renders
 * the shell.
 */

const express = require('express');
const { requireMember } = require('../auth/middleware');

const router = express.Router();

/** Leaders, the architect, or a member hosting an upcoming session. */
function requireTimerAccess(req, res, next) {
  if (res.locals.isLeader || res.locals.isHost) return next();
  const err = new Error('The timer is for leaders and session hosts.');
  err.status = 403;
  return next(err);
}

router.get('/', requireMember, requireTimerAccess, (req, res) => {
  res.render('timer', {
    title: 'Sprint timer',
    pageCss: ['/css/timer.css'],
    pageJs: ['/js/timer.js'],
  });
});

module.exports = router;
