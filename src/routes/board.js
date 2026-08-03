'use strict';

/**
 * General discussion board (Phase 3).
 * Mounted at /board by src/app.js — add routes here, not there.
 */

const express = require('express');
const { requireMember } = require('../auth/middleware');

const router = express.Router();

router.get('/', requireMember, (req, res) => {
  res.render('coming-soon', {
    title: 'Board',
    bodyClass: 'page-soon',
    heading: 'The board',
    eyebrow: 'Members · Discussion',
    blurb:
      'Threads, replies and markdown are the next thing being built. Until then, announcements on the front page carry the news.',
  });
});

module.exports = router;
