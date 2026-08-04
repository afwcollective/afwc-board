'use strict';

/**
 * Where an off-site event's attachments live on disk:
 *
 *   DATA_DIR/uploads/events/<meetingId>/<stored_name>
 *
 * Same shape and same rules as the drafts tree (src/services/ingest/paths.js):
 * the directory is NEVER routed statically — every byte leaves through
 * GET /events/:meetingId/files/:attachmentId in src/routes/events.js, behind
 * requireMember. Stored names are generated here, so nothing a leader's file
 * manager called a file ever becomes part of a path.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../config');

const EVENTS_ROOT = path.join(config.uploadsDir, 'events');

function eventDir(meetingId) {
  const id = Number(meetingId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad meeting id');
  return path.join(EVENTS_ROOT, String(id));
}

/**
 * Resolves a stored filename inside an event directory, refusing anything that
 * escapes it. Returns null when the name is not safe.
 */
function resolveInEvent(meetingId, storedName) {
  const name = String(storedName || '').replace(/\\/g, '/');
  if (!name || name.includes('/') || name === '.' || name === '..') return null;
  const base = eventDir(meetingId);
  const full = path.resolve(base, name);
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

/** A collision-proof stored name: timestamp + random, and only our extension. */
function makeStoredName(ext) {
  const clean = /^\.[a-z0-9]{1,8}$/.test(String(ext || '')) ? ext : '';
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${clean}`;
}

module.exports = { EVENTS_ROOT, eventDir, resolveInEvent, makeStoredName };
