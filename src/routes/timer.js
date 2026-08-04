'use strict';

/**
 * Writing-sprint timer (standalone).
 * Mounted at /timer by src/app.js — add routes here, not there.
 *
 * Intentionally public: no requireMember. The real use case is a laptop on
 * the table mid-session, before or without anyone signing in. The phase
 * plan (settle/sprint/rest durations) is computed client-side in
 * public/js/timer.js — this route only renders the shell.
 */

const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('timer', {
    title: 'Sprint timer',
    pageCss: ['/css/timer.css'],
    pageJs: ['/js/timer.js'],
  });
});

module.exports = router;
