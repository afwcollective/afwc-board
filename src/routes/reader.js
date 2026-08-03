'use strict';

/**
 * The locked in-browser reader and its auth-gated content streams (Phases 4–5):
 *   GET /drafts/:id/page/:n   sanitized HTML fragment, no-store
 *   GET /drafts/:id/file.pdf  inline PDF stream with Range support
 *   GET /drafts/:id/img/:n    page image streamed through the session check
 *
 * Mounted at / by src/app.js (after the /drafts router) so those paths can sit
 * alongside the draft library without either file importing the other.
 */

const express = require('express');
const { requireMember } = require('../auth/middleware');

const router = express.Router();

router.get('/reader', requireMember, (req, res) => {
  res.render('coming-soon', {
    title: 'Reader',
    bodyClass: 'page-soon',
    heading: 'The reader',
    eyebrow: 'Members · In-browser',
    blurb: 'Open a draft from the library to read it. The reader itself is being built.',
  });
});

module.exports = router;
