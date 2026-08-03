'use strict';

/**
 * Draft library — upload, ingest, listing (Phases 4–5).
 * Mounted at /drafts by src/app.js — add routes here, not there.
 */

const express = require('express');
const { requireMember } = require('../auth/middleware');

const router = express.Router();

router.get('/', requireMember, (req, res) => {
  res.render('coming-soon', {
    title: 'Drafts',
    bodyClass: 'page-soon',
    heading: 'The draft library',
    eyebrow: 'Members · Read & critique',
    blurb:
      'Upload a chapter as .docx, .pdf, images or plain text and it becomes a page-turner in the browser, with comments on every page. Being built now.',
  });
});

module.exports = router;
