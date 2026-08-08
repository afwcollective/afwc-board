'use strict';

/**
 * Chat — #general, project subgroups, private one-to-one messages (migration 007).
 * Mounted at /chat by src/app.js — add routes here, not there.
 *
 * THE PRIVACY STANCE, stated once so nobody has to infer it from the code:
 * a 'dm' channel is readable by its two participants and by nobody else. There
 * is no isLeaderUser() escape hatch on any DM path in this file; a leader or
 * the architect asking for someone else's DM gets the same 404 a stranger gets,
 * so the URL cannot even confirm the conversation exists. Deleting inside a DM
 * is author-only for the same reason. The moderation tool for a member who is
 * misusing DMs is deactivation (/admin/members), which is written down in the
 * leader handbook (views/admin/help.ejs #chat).
 *
 * Queries are route-local by design (see src/models.js header): nothing outside
 * this router touches a chat_* table.
 *
 * NOTE ON CSRF + MULTIPART (same shape as src/routes/drafts.js): checkCsrf runs
 * before any router and can only read req.body._csrf (urlencoded) or the
 * X-CSRF-Token header. A plain <form enctype="multipart/form-data"> can never
 * satisfy it, so the compose form is an ORDINARY urlencoded form — it works
 * with JavaScript off, posts text, and redirects back to the channel. When JS
 * is on, public/js/chat.js reveals the file input and submits the whole thing
 * as FormData carrying X-CSRF-Token, and this route answers JSON. Attachments
 * therefore need JavaScript; posting does not.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const { db } = require('../db');
const { requireMember } = require('../auth/middleware');
const { isLeaderUser } = require('../auth/roles');
const { flash } = require('../util/flash');
const { mdToHtml, toPlainText } = require('../util/sanitize');
const dates = require('../util/dates');

const router = express.Router();

/* ---------------------------------------------------------------- limits */

const MAX_MESSAGE_CHARS = 8000;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_NAME = 60;
const MAX_DESC = 140;

/** Newest N shown by default; "show earlier" walks this up in the query string. */
const PAGE_SIZE = 50;
const MAX_SHOW = 500;

/** Consecutive messages by the same person inside this window are grouped. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const CHAT_DIR = path.join(config.uploadsDir, 'chat');
const TMP_DIR = path.join(config.uploadsDir, 'tmp');

/**
 * Extension allowlist. `mime` is what the byte stream is labelled with on the
 * way back out; `inline` decides Content-Disposition (an image or a PDF opens
 * in place, everything else is offered as a download).
 */
const ALLOWED = {
  '.jpg': { mime: 'image/jpeg', inline: true, image: true },
  '.jpeg': { mime: 'image/jpeg', inline: true, image: true },
  '.png': { mime: 'image/png', inline: true, image: true },
  '.webp': { mime: 'image/webp', inline: true, image: true },
  '.gif': { mime: 'image/gif', inline: true, image: true },
  '.pdf': { mime: 'application/pdf', inline: true },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.txt': { mime: 'text/plain; charset=utf-8' },
  '.md': { mime: 'text/plain; charset=utf-8' },
  '.zip': { mime: 'application/zip' },
};

/* ------------------------------------------------------- magic-byte checks */

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * The extension is a hint; these bytes are the check — same contract as
 * src/routes/drafts.js sniff(). Returns null when the file is what it claims,
 * otherwise a member-readable complaint. Formats with no magic number of their
 * own (.txt/.md) are validated as UTF-8 text instead; .zip is allowed on its
 * PK signature, which .docx shares because every OOXML file is a zip.
 */
function sniff(ext, head, fullPath) {
  if (ext === '.jpg' || ext === '.jpeg') {
    return startsWith(head, [0xff, 0xd8, 0xff]) ? null : 'is not a real JPEG.';
  }
  if (ext === '.png') {
    return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? null
      : 'is not a real PNG.';
  }
  if (ext === '.gif') {
    const tag = head.subarray(0, 6).toString('latin1');
    return tag === 'GIF87a' || tag === 'GIF89a' ? null : 'is not a real GIF.';
  }
  if (ext === '.webp') {
    const ok =
      startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      head.length >= 12 &&
      head.subarray(8, 12).toString('latin1') === 'WEBP';
    return ok ? null : 'is not a real WebP image.';
  }
  if (ext === '.pdf') {
    return startsWith(head, [0x25, 0x50, 0x44, 0x46])
      ? null
      : 'is not a real PDF (its contents do not start with %PDF).';
  }
  if (ext === '.docx') {
    return startsWith(head, [0x50, 0x4b]) ? null : 'is not a real Word file (its contents are not a .docx).';
  }
  if (ext === '.zip') {
    return startsWith(head, [0x50, 0x4b]) ? null : 'is not a real zip archive.';
  }
  if (ext === '.txt' || ext === '.md') {
    try {
      UTF8_DECODER.decode(fs.readFileSync(fullPath));
      return null;
    } catch {
      return 'is not plain UTF-8 text.';
    }
  }
  return 'is not a file type chat accepts.';
}

function readHead(fullPath, n = 16) {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ multer */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(String(file.originalname || '')).toLowerCase().slice(0, 12);
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 8, parts: MAX_FILES + 10 },
});

/** multer skips a request that is not multipart, so the no-JS form falls straight through. */
const acceptFiles = upload.array('files', MAX_FILES);

function handleUpload(req, res, next) {
  acceptFiles(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = `Attachments max out at ${MAX_FILE_BYTES / 1024 / 1024} MB each.`;
      } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT') {
        req.uploadError = `Up to ${MAX_FILES} files per message.`;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        req.uploadError = 'That message had a file field we do not recognise.';
      } else {
        req.uploadError = 'The message did not arrive intact. Please try again.';
      }
    }
    next();
  });
}

function cleanupTmp(req) {
  for (const file of (req && req.files) || []) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* already gone */
    }
  }
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

const messageDir = (channelId, messageId) =>
  path.join(CHAT_DIR, String(Number(channelId)), String(Number(messageId)));

/* ------------------------------------------------- queries (route-local) */

const q = {
  channelById: () => db.prepare('SELECT * FROM chat_channels WHERE id = ?'),
  generalChannel: () => db.prepare("SELECT * FROM chat_channels WHERE kind = 'general' ORDER BY id LIMIT 1"),
  membership: () => db.prepare('SELECT * FROM chat_members WHERE channel_id = ? AND user_id = ?'),
  memberCount: () => db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE channel_id = ?'),
  // #general's member count, minus the architect — same "N members" figure
  // as everywhere else on the board that counts active people, and the
  // architect chair is not a member seat any more than it is in that count.
  activeMemberCount: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_active = 1 AND role <> 'architect'"),
  join: () =>
    db.prepare('INSERT OR IGNORE INTO chat_members (channel_id, user_id) VALUES (?, ?)'),
  leave: () => db.prepare('DELETE FROM chat_members WHERE channel_id = ? AND user_id = ?'),

  /** Groups the viewer has joined (archived ones included, flagged). */
  myGroups: () =>
    db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id) AS member_count,
              (SELECT MAX(id) FROM chat_messages x WHERE x.channel_id = c.id) AS last_message_id
         FROM chat_channels c
         JOIN chat_members cm ON cm.channel_id = c.id AND cm.user_id = ?
        WHERE c.kind = 'group'
        ORDER BY c.archived_at IS NOT NULL, LOWER(c.name)`
    ),
  /** Live groups the viewer is NOT in — name and description only. */
  joinableGroups: () =>
    db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id) AS member_count
         FROM chat_channels c
        WHERE c.kind = 'group' AND c.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
        ORDER BY LOWER(c.name)`
    ),
  /**
   * The viewer's DM conversations. Scoped by their own chat_members row, so
   * this statement cannot return somebody else's conversation even by accident.
   * A pair channel with no messages yet stays out of the list — "create on
   * first message" as far as anyone can see.
   */
  myDms: () =>
    db.prepare(
      `SELECT c.id, c.created_at,
              other.id AS other_id, other.display_name AS other_name,
              other.username AS other_username, other.is_active AS other_active,
              (SELECT MAX(id) FROM chat_messages x WHERE x.channel_id = c.id) AS last_message_id,
              (SELECT MAX(created_at) FROM chat_messages x WHERE x.channel_id = c.id) AS last_at
         FROM chat_channels c
         JOIN chat_members mine ON mine.channel_id = c.id AND mine.user_id = @me
         JOIN chat_members theirs ON theirs.channel_id = c.id AND theirs.user_id <> @me
         JOIN users other ON other.id = theirs.user_id
        WHERE c.kind = 'dm'
          AND EXISTS (SELECT 1 FROM chat_messages x WHERE x.channel_id = c.id)
        ORDER BY last_message_id DESC`
    ),
  dmPartner: () =>
    db.prepare(
      `SELECT u.id, u.display_name, u.username, u.is_active
         FROM chat_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = ? AND cm.user_id <> ? LIMIT 1`
    ),
  dmByPairKey: () => db.prepare("SELECT * FROM chat_channels WHERE kind = 'dm' AND pair_key = ?"),
  insertChannel: () =>
    db.prepare(
      'INSERT INTO chat_channels (kind, name, description, pair_key, created_by) VALUES (?, ?, ?, ?, ?)'
    ),
  renameChannel: () => db.prepare('UPDATE chat_channels SET name = ?, description = ? WHERE id = ?'),
  archiveChannel: () =>
    db.prepare(
      `UPDATE chat_channels SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), archived_by = ?
        WHERE id = ? AND archived_at IS NULL`
    ),
  unarchiveChannel: () =>
    db.prepare('UPDATE chat_channels SET archived_at = NULL, archived_by = NULL WHERE id = ?'),

  /** Newest `limit` messages of a channel, oldest-first once reversed. */
  latestMessages: () =>
    db.prepare(
      `SELECT m.id, m.user_id, m.body_html, m.created_at, m.deleted_at,
              u.display_name AS author_name
         FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = ?
        ORDER BY m.id DESC LIMIT ?`
    ),
  messageCount: () => db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ?'),
  head: () =>
    db.prepare(
      'SELECT MAX(id) AS latest_id, COUNT(*) AS count, MAX(deleted_at) AS last_delete FROM chat_messages WHERE channel_id = ?'
    ),
  messageById: () => db.prepare('SELECT * FROM chat_messages WHERE id = ?'),
  insertMessage: () =>
    db.prepare('INSERT INTO chat_messages (channel_id, user_id, body_html) VALUES (?, ?, ?)'),
  hardDeleteMessage: () => db.prepare('DELETE FROM chat_messages WHERE id = ?'),
  softDeleteMessage: () =>
    db.prepare(
      `UPDATE chat_messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
        WHERE id = ? AND deleted_at IS NULL`
    ),
  attachmentsForChannel: () =>
    db.prepare(
      `SELECT a.* FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id
        WHERE m.channel_id = ? AND m.deleted_at IS NULL`
    ),
  insertAttachment: () =>
    db.prepare(
      'INSERT INTO chat_attachments (message_id, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)'
    ),
  attachmentById: () =>
    db.prepare(
      `SELECT a.*, m.channel_id, m.deleted_at AS message_deleted_at
         FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id
        WHERE a.id = ?`
    ),
  /**
   * The member picker: everyone active except the viewer, and except the
   * architect — the "new message" picker hides the god-level account from
   * everybody (including the architect's own picker, though there the
   * `id <> ?` self-exclusion already does the work, since there is only one
   * architect). A member who already has a DM with the architect still sees
   * and can reply to it — see myDms, dmPartner, below — this only hides the
   * option to START a new one.
   */
  otherActiveMembers: () =>
    db.prepare(
      "SELECT id, display_name, username FROM users WHERE is_active = 1 AND id <> ? AND role <> 'architect' ORDER BY LOWER(display_name)"
    ),
  activeUserById: () => db.prepare('SELECT id, display_name, username, is_active FROM users WHERE id = ?'),
};

/* ------------------------------------------------------- #general bootstrap */

/**
 * There is always exactly one #general, and every active member is in it. Like
 * ensureArchitect() in src/db.js this is boot-time housekeeping rather than a
 * migration: it is idempotent, it re-heals a database whose seed row was hand
 * deleted, and it never guesses at anything. Called once at module init (after
 * server.js has run migrate()) and defensively before the index renders.
 */
let generalCache = null;
function ensureGeneralChannel() {
  if (generalCache) {
    const fresh = q.channelById().get(generalCache.id);
    if (fresh && fresh.kind === 'general') return fresh;
    generalCache = null;
  }
  let row = q.generalChannel().get();
  if (!row) {
    q.insertChannel().run(
      'general',
      'general',
      'Everyone in the collective. Announcements, questions, and whatever else the group is talking about.',
      null,
      null
    );
    row = q.generalChannel().get();
    console.log('[afwc] chat: seeded #general');
  }
  generalCache = row;
  return row;
}

try {
  ensureGeneralChannel();
} catch (err) {
  // A database that has not reached migration 007 (a router loaded by a tool
  // that skipped server.js) must not take the whole app down at require time.
  console.error('[afwc] chat: could not ensure #general yet:', err.message);
}

/* ------------------------------------------------------------- access rules */

const isGeneral = (channel) => channel.kind === 'general';
const isDm = (channel) => channel.kind === 'dm';

/** A joined-or-general test. DMs are never "general", so this is exact. */
function isParticipant(channel, userId) {
  if (isGeneral(channel)) return true;
  return !!q.membership().get(channel.id, userId);
}

/**
 * May this person READ the transcript? #general: every member. Group: joined
 * members only. DM: the two participants, full stop — no leader branch, by
 * design (see the file header).
 */
const canRead = (channel, user) => isParticipant(channel, user.id);

/** May this person POST? Reading plus "the channel is still open". */
const canPost = (channel, user) => canRead(channel, user) && !channel.archived_at;

/**
 * Rename / archive. The creator or any leader — for groups. #general is
 * unarchivable and unrenamable, and a DM has no such controls at all.
 */
const canAdminChannel = (channel, user) =>
  channel.kind === 'group' && (channel.created_by === user.id || isLeaderUser(user));

/**
 * Deleting a message. In a channel it is the ordinary author-or-leader rule the
 * rest of the site uses. In a DM it is AUTHOR ONLY: a leader who is not one of
 * the two participants cannot even see the message, and the participant on the
 * other end does not get to edit somebody's else words out of their own
 * transcript either.
 */
function canDeleteMessage(channel, message, user) {
  if (message.user_id === user.id) return true;
  if (isDm(channel)) return false;
  return isLeaderUser(user);
}

const channelTitle = (channel, partnerName) => {
  if (isGeneral(channel)) return '#general';
  if (isDm(channel)) return partnerName || 'Direct message';
  return channel.name || 'Channel';
};

const channelHref = (channel) => `/chat/c/${channel.id}`;

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

const trim = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

const pairKeyFor = (a, b) => `dm:${Math.min(a, b)}:${Math.max(a, b)}`;

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------- transcript builder */

/**
 * Newest `show` messages, oldest first, decorated for the view: day separators,
 * author grouping inside GROUP_WINDOW_MS, per-row delete permission, and each
 * message's attachments. `hasEarlier` drives the "show earlier" link.
 */
function buildTranscript(channel, user, show) {
  const limit = Math.max(PAGE_SIZE, Math.min(Number(show) || PAGE_SIZE, MAX_SHOW));
  const rows = q.latestMessages().all(channel.id, limit).reverse();
  const total = q.messageCount().get(channel.id).n;

  const byMessage = new Map();
  for (const a of q.attachmentsForChannel().all(channel.id)) {
    if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
    byMessage.get(a.message_id).push({
      id: a.id,
      name: a.original_name,
      size: humanSize(a.size),
      mime: a.mime,
      isImage: String(a.mime || '').startsWith('image/'),
    });
  }

  let prev = null;
  const messages = rows.map((row) => {
    const removed = !!row.deleted_at;
    const dayKey = dates.localDateKey(row.created_at);
    const daySep = !prev || dates.localDateKey(prev.created_at) !== dayKey;
    const withinWindow =
      !!prev &&
      !daySep &&
      !removed &&
      !prev.deleted_at &&
      prev.user_id === row.user_id &&
      row.user_id !== null &&
      Math.abs(
        (dates.toDate(row.created_at) || 0) - (dates.toDate(prev.created_at) || 0)
      ) <= GROUP_WINDOW_MS;

    const out = {
      id: row.id,
      user_id: row.user_id,
      author: row.author_name || 'Former member',
      body_html: removed ? '' : row.body_html,
      created_at: row.created_at,
      removed,
      daySep,
      dayLabel: dates.formatDateShort(row.created_at),
      grouped: withinWindow,
      mine: row.user_id === user.id,
      canDelete: !removed && canDeleteMessage(channel, row, user),
      attachments: removed ? [] : byMessage.get(row.id) || [],
    };
    prev = row;
    return out;
  });

  return { messages, show: limit, hasEarlier: total > rows.length, total };
}

/* ------------------------------------------------------------- the router */

router.use(requireMember);

/**
 * Loads the channel named by :id and checks access in ONE place.
 * Returns null after having answered the request when access fails:
 *   · a DM the caller is not in                 -> 404 (never 403: a 403 would
 *     confirm that the conversation exists, which is exactly the leak the DM
 *     rules are there to prevent)
 *   · an archived group the caller never joined -> 404
 *   · a live group the caller has not joined    -> allowed through with
 *     read = false, so the pane can show the name, the blurb and a Join button
 *     and nothing else. `mode` shapes the failure the same way reader.js does.
 */
function loadChannel(req, res, next, mode = 'html') {
  const id = Number(req.params.channelId || req.params.id);
  if (!Number.isInteger(id) || id <= 0) return notHere(res, next, mode);

  const channel = q.channelById().get(id);
  if (!channel) return notHere(res, next, mode);

  const read = canRead(channel, req.user);
  if (!read && (isDm(channel) || channel.archived_at)) return notHere(res, next, mode);

  channel._read = read;
  return channel;
}

function notHere(res, next, mode) {
  if (mode === 'json') {
    noStore(res);
    res.status(404).json({ ok: false, error: 'That conversation is not here.' });
    return null;
  }
  if (mode === 'bytes') {
    noStore(res);
    res.status(404).type('text/plain').send('Not found.');
    return null;
  }
  next();
  return null;
}

/* ---------------------------------------------------------------- the index */

function renderIndex(req, res, channel) {
  const me = req.user.id;
  const general = ensureGeneralChannel();
  const myGroups = q.myGroups().all(me);
  const joinable = q.joinableGroups().all(me);
  const dms = q.myDms().all({ me });
  const partner = isDm(channel) ? q.dmPartner().get(channel.id, me) : null;

  const transcript = channel._read
    ? buildTranscript(channel, req.user, req.query.show)
    : { messages: [], show: PAGE_SIZE, hasEarlier: false, total: 0 };

  const memberCount = isGeneral(channel)
    ? q.activeMemberCount().get().n
    : q.memberCount().get(channel.id).n;

  noStore(res);
  res.render('chat/index', {
    title: channelTitle(channel, partner && partner.display_name),
    bodyClass: 'page-chat',
    pageCss: ['/css/chat.css'],
    pageJs: ['/js/chat.js'],
    general,
    channel,
    partner,
    channelTitle: channelTitle(channel, partner && partner.display_name),
    memberCount,
    myGroups,
    joinable,
    dms,
    people: q.otherActiveMembers().all(me),
    messages: transcript.messages,
    show: transcript.show,
    hasEarlier: transcript.hasEarlier,
    pageSize: PAGE_SIZE,
    canRead: channel._read,
    canPost: canPost(channel, req.user),
    canAdmin: canAdminChannel(channel, req.user),
    joined: !isGeneral(channel) && !!q.membership().get(channel.id, me),
    // Only a /chat/c/:id URL means "the member picked this conversation"; the
    // bare /chat lands on #general and stays on the list at phone width.
    conversationFocused: req.path !== '/',
    limits: { maxFiles: MAX_FILES, maxFileMb: MAX_FILE_BYTES / 1024 / 1024, maxChars: MAX_MESSAGE_CHARS },
    channelHref,
  });
}

router.get('/', (req, res) => renderIndex(req, res, { ...ensureGeneralChannel(), _read: true }));

router.get('/c/:channelId', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'html');
  if (!channel) return undefined;
  return renderIndex(req, res, channel);
});

/* ------------------------------------------------- poll head + list fragment */

/**
 * The 20-second poll, deliberately boring: two integers and the newest
 * deletion stamp. public/js/chat.js compares them with what it last drew and
 * only then asks for the fragment below. No websockets, no server state.
 */
router.get('/c/:channelId/head', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'json');
  if (!channel) return undefined;
  noStore(res);
  if (!channel._read) return res.status(404).json({ ok: false, error: 'That conversation is not here.' });
  const head = q.head().get(channel.id);
  return res.json({
    ok: true,
    latest_id: head.latest_id || 0,
    count: head.count || 0,
    last_delete: head.last_delete || null,
  });
});

router.get('/c/:channelId/fragment', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'bytes');
  if (!channel) return undefined;
  noStore(res);
  if (!channel._read) return res.status(404).type('text/plain').send('Not found.');

  const transcript = buildTranscript(channel, req.user, req.query.show);
  return res.render(
    'chat/messages',
    {
      layout: false,
      channel,
      messages: transcript.messages,
      show: transcript.show,
      hasEarlier: transcript.hasEarlier,
      pageSize: PAGE_SIZE,
    },
    (err, html) => {
      if (err) return next(err);
      res.type('text/html; charset=utf-8');
      return res.send(html);
    }
  );
});

/* ------------------------------------------------------------ post a message */

router.post('/c/:channelId/messages', handleUpload, (req, res, next) => {
  const wantsJson =
    String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
    String(req.get('accept') || '').includes('application/json');

  const channel = loadChannel(req, res, next, wantsJson ? 'json' : 'html');
  if (!channel) {
    cleanupTmp(req);
    return undefined;
  }

  const back = channelHref(channel);
  const files = req.files || [];
  const fail = (status, message) => {
    cleanupTmp(req);
    if (wantsJson) {
      noStore(res);
      return res.status(status).json({ ok: false, errors: [message] });
    }
    flash(res, 'error', message);
    return res.redirect(back);
  };

  if (!channel._read) return fail(404, 'That conversation is not here.');
  if (!canPost(channel, req.user)) {
    return fail(403, channel.archived_at ? 'This channel is archived.' : 'Join this channel first.');
  }
  if (req.uploadError) return fail(400, req.uploadError);
  if (files.length > MAX_FILES) return fail(400, `Up to ${MAX_FILES} files per message.`);

  const body = trim((req.body || {}).body, MAX_MESSAGE_CHARS);
  if (!body && !files.length) return fail(400, 'Write something (or attach a file) first.');

  const bodyHtml = body ? mdToHtml(body) : '';
  if (body && !toPlainText(bodyHtml).trim() && !files.length) {
    return fail(400, 'Nothing survived the formatting filter — try plain text or simple markdown.');
  }

  /* ---- every attachment is checked before a single byte is kept ---- */
  for (const file of files) {
    const name = toPlainText(file.originalname, 80) || 'that file';
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    if (!ALLOWED[ext]) {
      return fail(
        400,
        `“${name}” is not a file type chat accepts (images, PDF, Word, text, markdown or zip).`
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return fail(400, `“${name}” is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    }
    const complaint = sniff(ext, readHead(file.path), file.path);
    if (complaint) return fail(400, `“${name}” ${complaint}`);
  }

  /* ---- row first (its id names the directory), then the bytes ---- */
  const messageId = Number(q.insertMessage().run(channel.id, req.user.id, bodyHtml).lastInsertRowid);
  try {
    if (files.length) {
      const dir = messageDir(channel.id, messageId);
      fs.mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const ext = path.extname(String(file.originalname || '')).toLowerCase();
        const stored = `${crypto.randomBytes(10).toString('hex')}${ext}`;
        moveFile(file.path, path.join(dir, stored));
        q.insertAttachment().run(
          messageId,
          toPlainText(file.originalname, 160) || `file${ext}`,
          stored,
          ALLOWED[ext].mime,
          file.size
        );
      }
    }
  } catch (err) {
    console.error('[afwc] chat attachment store failed:', err);
    cleanupTmp(req);
    try {
      q.hardDeleteMessage().run(messageId); // attachments cascade
    } catch {
      /* nothing more to do */
    }
    return fail(500, 'We could not store that attachment. Please try again.');
  }

  if (wantsJson) {
    noStore(res);
    return res.status(201).json({ ok: true, id: messageId, redirect: `${back}#m-${messageId}` });
  }
  return res.redirect(`${back}#m-${messageId}`);
});

/* ------------------------------------------------------------ delete a message */

router.post('/messages/:id/delete', (req, res, next) => {
  const message = q.messageById().get(Number(req.params.id));
  if (!message || message.deleted_at) return next();

  const channel = q.channelById().get(message.channel_id);
  // A DM the caller is not in is 404 all the way down — including its messages.
  if (!channel || !canRead(channel, req.user)) return next();

  if (!canDeleteMessage(channel, message, req.user)) {
    const err = new Error(
      isDm(channel)
        ? 'Only the person who wrote a private message can remove it.'
        : 'Only the person who wrote a message (or a leader) can remove it.'
    );
    err.status = 403;
    return next(err);
  }

  q.softDeleteMessage().run(req.user.id, message.id);
  return res.redirect(`${channelHref(channel)}#m-${message.id}`);
});

/* ------------------------------------------------------------------- groups */

router.post('/groups', (req, res) => {
  const name = trim(req.body.name, MAX_NAME).replace(/\s+/g, ' ');
  const description = trim(req.body.description, MAX_DESC).replace(/\s+/g, ' ');

  if (!name) {
    flash(res, 'error', 'Give the group a name.');
    return res.redirect('/chat');
  }

  const create = db.transaction(() => {
    const id = Number(
      q.insertChannel().run('group', name, description || null, null, req.user.id).lastInsertRowid
    );
    q.join().run(id, req.user.id);
    return id;
  });
  const id = create();

  flash(res, 'ok', `“${name}” is open. Anyone in the group can join it.`);
  return res.redirect(`/chat/c/${id}`);
});

router.post('/c/:channelId/rename', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'html');
  if (!channel) return undefined;
  if (!canAdminChannel(channel, req.user)) {
    const err = new Error('Only the member who started this group (or a leader) can rename it.');
    err.status = 403;
    return next(err);
  }
  const name = trim(req.body.name, MAX_NAME).replace(/\s+/g, ' ');
  const description = trim(req.body.description, MAX_DESC).replace(/\s+/g, ' ');
  if (!name) {
    flash(res, 'error', 'A group needs a name.');
    return res.redirect(channelHref(channel));
  }
  q.renameChannel().run(name, description || null, channel.id);
  flash(res, 'ok', 'Group updated.');
  return res.redirect(channelHref(channel));
});

router.post('/c/:channelId/join', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'html');
  if (!channel) return undefined;
  if (channel.kind !== 'group') {
    flash(res, 'info', 'Everyone is already in #general.');
    return res.redirect(channelHref(channel));
  }
  if (channel.archived_at) {
    flash(res, 'error', 'That group is archived.');
    return res.redirect('/chat');
  }
  q.join().run(channel.id, req.user.id);
  flash(res, 'ok', `You’re in “${channel.name}”.`);
  return res.redirect(channelHref(channel));
});

router.post('/c/:channelId/leave', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'html');
  if (!channel) return undefined;
  if (channel.kind !== 'group') {
    flash(res, 'error', 'You cannot leave that conversation.');
    return res.redirect(channelHref(channel));
  }
  q.leave().run(channel.id, req.user.id);
  flash(res, 'info', `You left “${channel.name}”.`);
  return res.redirect('/chat');
});

router.post('/c/:channelId/archive', (req, res, next) => {
  const channel = loadChannel(req, res, next, 'html');
  if (!channel) return undefined;

  // #general is the one room nobody can close, and a DM is not a room at all.
  if (channel.kind !== 'group') {
    const err = new Error('That conversation cannot be archived.');
    err.status = 403;
    return next(err);
  }
  if (!canAdminChannel(channel, req.user)) {
    const err = new Error('Only the member who started this group (or a leader) can archive it.');
    err.status = 403;
    return next(err);
  }

  if (channel.archived_at) {
    q.unarchiveChannel().run(channel.id);
    flash(res, 'ok', `“${channel.name}” is open again.`);
  } else {
    q.archiveChannel().run(req.user.id, channel.id);
    flash(res, 'info', `“${channel.name}” is archived. Its messages are still here to read.`);
  }
  return res.redirect(channelHref(channel));
});

/* ------------------------------------------------------------------- DMs */

router.post('/dm', (req, res) => {
  const targetId = Number(req.body.user_id);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.user.id) {
    flash(res, 'error', 'Pick somebody to write to.');
    return res.redirect('/chat');
  }
  const target = q.activeUserById().get(targetId);
  if (!target || !target.is_active) {
    flash(res, 'error', 'That member is not active any more.');
    return res.redirect('/chat');
  }

  const key = pairKeyFor(req.user.id, target.id);
  let channel = q.dmByPairKey().get(key);
  if (!channel) {
    // UNIQUE(pair_key) is the real guarantee; two tabs racing here means one
    // INSERT throws and we re-read the row the other one wrote.
    try {
      const create = db.transaction(() => {
        const id = Number(q.insertChannel().run('dm', null, null, key, req.user.id).lastInsertRowid);
        q.join().run(id, req.user.id);
        q.join().run(id, target.id);
        return id;
      });
      channel = q.channelById().get(create());
    } catch (err) {
      channel = q.dmByPairKey().get(key);
      if (!channel) throw err;
    }
  }
  return res.redirect(channelHref(channel));
});

/* ------------------------------------------------------- attachment streams */

/**
 * The only way an attachment's bytes leave this app. Access is re-derived from
 * the message's channel on every request — a URL copied out of a DM is dead the
 * moment it reaches anyone who is not one of the two participants (and 404s,
 * not 403s, so it does not even admit the file exists). uploads/ is never a
 * static directory: src/app.js serves public/ only.
 */
router.get('/files/:id', (req, res, next) => {
  const row = q.attachmentById().get(Number(req.params.id));
  if (!row || row.message_deleted_at) return notHere(res, next, 'bytes');

  const channel = q.channelById().get(row.channel_id);
  if (!channel || !canRead(channel, req.user)) return notHere(res, next, 'bytes');

  const ext = path.extname(String(row.stored_name || '')).toLowerCase();
  const rule = ALLOWED[ext];
  // stored_name is generated by this file (hex + allowlisted extension); the
  // basename() is belt-and-braces so a hand-edited row cannot walk the path.
  const file = path.join(messageDir(channel.id, row.message_id), path.basename(row.stored_name));
  if (!rule || !fs.existsSync(file)) return notHere(res, next, 'bytes');

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return notHere(res, next, 'bytes');
  }

  noStore(res);
  res.set('Content-Type', row.mime || rule.mime || 'application/octet-stream');
  res.set('Content-Length', String(stat.size));
  const safeName = String(row.original_name || 'file').replace(/["\\\r\n]/g, '');
  res.set(
    'Content-Disposition',
    `${rule.inline ? 'inline' : 'attachment'}; filename="${safeName}"`
  );
  return fs.createReadStream(file).pipe(res);
});

module.exports = router;
