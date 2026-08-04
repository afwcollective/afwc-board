'use strict';

const express = require('express');
const { meetings, recurring, announcements, eventFiles } = require('../models');
const { noUsersYet } = require('../auth/middleware');

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

router.get('/', (req, res) => {
  const firstRun = noUsersYet();
  const unified = firstRun ? null : meetings.nextUnified();

  /*
   * THE PRIVACY RULE for off-site events (decided with the group): the address,
   * the details and the attachments belong to members. A logged-out visitor
   * gets the title, the date and time, and an invitation to sign in.
   *
   * Both halves of that are done here rather than in the template: the row is
   * passed through meetings.publicSafe(), which nulls the private columns
   * outright, and the attachment list is simply not fetched. A template that
   * forgot the rule would have nothing to leak.
   */
  const signedIn = !!req.user;
  const meeting = signedIn ? unified : meetings.publicSafe(unified);
  const eventAttachments =
    signedIn && meeting && meeting.kind === 'offsite' && meeting.id
      ? eventFiles.forMeeting(meeting.id)
      : [];

  res.render('home', {
    title: null, // layout falls back to the site name
    bodyClass: 'page-home',
    pageCss: ['/css/events.css'],
    firstRun,
    meeting,
    eventAttachments,
    weekly: firstRun ? [] : recurring.listActive(),
    announcements: firstRun ? [] : announcements.list(10),
    pageJs: [],
  });
});

module.exports = router;
