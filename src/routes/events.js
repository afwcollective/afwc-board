'use strict';

/**
 * Off-site event attachments, streamed to members:
 *
 *   GET /events/:meetingId/files/:attachmentId
 *
 * The privacy rule for an off-site event (a leader's home, someone's address)
 * is that its address, its details and its attachments are MEMBERS-ONLY. This
 * route is the enforcement point for the third of those. Like the draft reader,
 * it exists because DATA_DIR/uploads is never a static directory: a URL from
 * here is dead the moment it leaves a session, and nothing on disk is reachable
 * except through a row that names it.
 *
 * A file 404s — never 403s, never streams — when the meeting is deleted or
 * cancelled, when the meeting is no longer an off-site event, or when the
 * attachment does not belong to that meeting. A cancelled event's flyer is not
 * a thing the site still hands out.
 */

const fs = require('node:fs');
const express = require('express');

const { meetings, eventFiles } = require('../models');
const { requireMember } = require('../auth/middleware');
const { resolveInEvent } = require('../services/events/paths');
const { ALLOWED } = require('../services/events/attachments');

const router = express.Router();

/** Images and PDFs are meant to be looked at in the tab, not downloaded. */
const INLINE_MIME = new Set(Object.values(ALLOWED));

function notFound(res, message) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.status(404).type('text/plain').send(message);
}

router.get('/:meetingId/files/:attachmentId', requireMember, (req, res) => {
  const meetingId = Number(req.params.meetingId);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(meetingId) || !Number.isInteger(attachmentId)) {
    return notFound(res, 'That file is not here.');
  }

  const meeting = meetings.byId(meetingId);
  if (!meeting || meeting.is_cancelled || meeting.kind !== 'offsite') {
    return notFound(res, 'That file is not here — the event may have been cancelled or removed.');
  }

  const row = eventFiles.byId(attachmentId, meetingId);
  if (!row) return notFound(res, 'That file is not here.');

  const full = resolveInEvent(meetingId, row.stored_name);
  if (!full || !fs.existsSync(full)) return notFound(res, 'That file is missing.');

  const mime = INLINE_MIME.has(row.mime) ? row.mime : 'application/octet-stream';
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Content-Type', mime);
  res.set(
    'Content-Disposition',
    mime === 'application/octet-stream' ? 'attachment' : 'inline'
  );
  return fs.createReadStream(full).pipe(res);
});

module.exports = router;
