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
 * A FUTURE AGENT WIDENING ACCESS TO PER-SESSION HOSTS: this is the one place
 * to change on the server side. Swap requireLeader below for whatever check
 * decides "is this user hosting the current/next meeting" — everything else
 * (the engine, the widget, the page) is host-agnostic and reads res.locals
 * only for isLeader. The matching client-side gate is the isLeader guard
 * around the widget include in views/layout.ejs (search "timer-widget") —
 * both need to move together or the nav link / widget will disagree with
 * what the route actually allows.
 *
 * The phase engine (manual sprint/break + opt-in auto session plans) is
 * computed client-side in public/js/timer-core.js — this route only renders
 * the shell.
 */

const express = require('express');
const { requireLeader } = require('../auth/middleware');

const router = express.Router();

router.get('/', requireLeader, (req, res) => {
  res.render('timer', {
    title: 'Sprint timer',
    pageCss: ['/css/timer.css'],
    pageJs: ['/js/timer.js'],
  });
});

module.exports = router;
