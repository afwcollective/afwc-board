/**
 * Port of src/routes/events.js — off-site event attachments, streamed to
 * members:
 *
 *   GET /events/:meetingId/files/:attachmentId
 *
 * The privacy rule for an off-site event (a leader's home, someone's address)
 * is that its address, its details and its attachments are MEMBERS-ONLY. This
 * route is the enforcement point for the third of those, and it is why the file
 * store has no public door: a URL from here is dead the moment it leaves a
 * session, and the bytes are rows in a private database reachable only through
 * a row that names them.
 *
 * A file 404s — never 403s, never streams — when the meeting is deleted or
 * cancelled, when the meeting is no longer an off-site event, when the
 * attachment does not belong to that meeting, or when the file itself has aged
 * out of the retention window (worker/src/scheduled.js). A cancelled event's
 * flyer is not a thing the site still hands out, and neither is one from three
 * years ago. (A LOGGED-OUT visitor is redirected to /login by requireMember
 * before any of that is asked, so they learn nothing about whether the file
 * exists and receive zero bytes.)
 */

import { Hono } from 'hono';

import { meetings, eventFiles } from '../models.js';
import { requireMember } from '../auth/middleware.js';
import * as attachments from '../services/events/attachments.js';

const router = new Hono();

router.use('*', requireMember);

/** Images and PDFs are meant to be looked at in the tab, not downloaded. */
const INLINE_MIME = new Set(Object.values(attachments.ALLOWED));

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

const notHere = (c, message) => c.text(message, 404, NO_STORE);

router.get('/:meetingId/files/:attachmentId', async (c) => {
  const db = c.env.DB;
  const meetingId = Number(c.req.param('meetingId'));
  const attachmentId = Number(c.req.param('attachmentId'));
  if (!Number.isInteger(meetingId) || !Number.isInteger(attachmentId)) {
    return notHere(c, 'That file is not here.');
  }

  const meeting = await meetings.byId(db, meetingId);
  if (!meeting || meeting.is_cancelled || meeting.kind !== 'offsite') {
    return notHere(c, 'That file is not here — the event may have been cancelled or removed.');
  }

  const row = await eventFiles.byId(db, attachmentId, meetingId);
  if (!row) return notHere(c, 'That file is not here.');

  const res = await attachments.open(c.env, meetingId, row.stored_name);
  if (!res) return notHere(c, 'That file is missing.');

  const mime = INLINE_MIME.has(row.mime) ? row.mime : 'application/octet-stream';
  return c.body(res.body, 200, {
    ...NO_STORE,
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Type': mime,
    'Content-Disposition': mime === 'application/octet-stream' ? 'attachment' : 'inline',
  });
});

export default router;
