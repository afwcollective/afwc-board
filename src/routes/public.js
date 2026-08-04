'use strict';

const express = require('express');
const { meetings, recurring, announcements, eventFiles, about } = require('../models');
const { noUsersYet } = require('../auth/middleware');
const { mdToHtml, toPlainText } = require('../util/sanitize');

/** How many of the most recent unpinned announcements the landing page shows. */
const RECENT_ANNOUNCEMENT_COUNT = 6;
/** How many special events the landing page lists before it would need paging. */
const SPECIAL_EVENT_COUNT = 20;

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

  /*
   * News & announcements: pinned ones are the newsletter — featured in full,
   * markdown body and all. Unpinned ones are a compact recent list (no
   * pagination yet, so just the most recent few). `announcements.list` already
   * sorts pinned-first, newest-first, so one query covers both halves.
   */
  const allAnnouncements = firstRun ? [] : announcements.list(30);
  const pinnedAnnouncements = allAnnouncements.filter((a) => a.is_pinned);
  const recentAnnouncements = allAnnouncements
    .filter((a) => !a.is_pinned)
    .slice(0, RECENT_ANNOUNCEMENT_COUNT)
    .map((a) => ({ ...a, snippet: toPlainText(a.body_html, 140) }));

  /*
   * Special events: every future one-off meeting except whichever one is
   * already the next-session card above (nothing should appear twice on the
   * page). Same privacy rule as the next-session card — meetings.publicSafe
   * nulls the members-only columns of an off-site row before a logged-out
   * visitor ever sees it; this reuses that helper rather than re-deriving it.
   */
  const excludeId = unified && !unified.is_recurring ? unified.id : null;
  const specialRaw = firstRun ? [] : meetings.upcomingSpecial(SPECIAL_EVENT_COUNT, excludeId);
  const specialEvents = signedIn ? specialRaw : specialRaw.map(meetings.publicSafe);

  res.render('home', {
    title: null, // layout falls back to the site name
    bodyClass: 'page-home',
    pageCss: ['/css/events.css'],
    firstRun,
    meeting,
    eventAttachments,
    weekly: firstRun ? [] : recurring.listActive(),
    aboutHtml: firstRun ? '' : mdToHtml(about.getMd()),
    pinnedAnnouncements,
    recentAnnouncements,
    specialEvents,
    pageJs: [],
  });
});

module.exports = router;
