'use strict';

const express = require('express');
const { meetings, announcements } = require('../models');
const { noUsersYet } = require('../auth/middleware');

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

router.get('/', (req, res) => {
  const firstRun = noUsersYet();
  const meeting = firstRun ? null : meetings.next();
  res.render('home', {
    title: null, // layout falls back to the site name
    bodyClass: 'page-home',
    firstRun,
    meeting,
    announcements: firstRun ? [] : announcements.list(10),
    pageJs: [],
  });
});

module.exports = router;
