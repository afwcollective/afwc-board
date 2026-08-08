/**
 * Port of src/routes/chat.js — #general, project subgroups, private DMs.
 *
 * THE PRIVACY STANCE, restated because it is the reason this file is shaped the
 * way it is: a 'dm' channel is readable by its two participants and by nobody
 * else. There is NO isLeaderUser() escape hatch on any DM path here; a leader or
 * the architect asking for someone else's DM gets the same 404 a stranger gets,
 * so the URL cannot even confirm the conversation exists. Every refusal that
 * could otherwise leak existence — the page, /head, /fragment, POST messages,
 * POST delete, GET /chat/files/:id — answers 404, never 403. Deleting inside a
 * DM is author-only for the same reason. The moderation tool for a member
 * misusing DMs is deactivation (/admin/members), documented in the leader
 * handbook (views/admin/help.ejs #chat).
 *
 * WHAT CHANGED IN THE MOVE TO WORKERS
 *
 *  * #GENERAL IS ENSURED LAZILY, ON FIRST /chat REQUEST. The Express module ran
 *    ensureGeneralChannel() at require time and cached the row in a module
 *    variable. A Worker has no boot, and a module-scope cache outlives the
 *    request in an isolate that may be reused, so the cache is gone and the
 *    find-or-create runs where the Express code also called it defensively:
 *    just before the index renders. Same name, same description, same
 *    idempotence — a board whose #general row was hand-deleted re-heals on the
 *    next visit. The POLL ENDPOINTS deliberately do NOT call it: /head stays at
 *    the two-integer query it has always been.
 *
 *  * MULTER IS GONE, so its declarative caps become explicit checks in
 *    worker/src/services/chat/attachments.js (≤3 files, ≤10 MB each) with the
 *    same sentences multer's error codes mapped to. The tmp-file dance and the
 *    magic-byte read off disk collapse into "read the part once, check the
 *    bytes in hand, then put to R2" — THE R2 PATTERN, four rules, written down
 *    at the top of worker/src/services/events/attachments.js and applied again
 *    at the top of the chat one.
 *
 *  * `return next()` for a missing thing becomes an explicit 404 renderer.
 *
 * CSRF + MULTIPART is unchanged and is why the compose form is an ORDINARY
 * urlencoded form: checkCsrf runs before any body is consumed and can only read
 * the token out of a urlencoded body or the X-CSRF-Token header (see
 * worker/src/util/body.js). Posting text works with JavaScript off; attachments
 * ride on a multipart request that only public/js/chat.js can send, and this
 * route answers JSON for that path.
 *
 * Queries are route-local by design (see worker/src/models.js header): nothing
 * outside this router touches a chat_* table.
 */

import { Hono } from 'hono';

import { one, all, run, stmt } from '../db.js';
import { requireMember, HttpError } from '../auth/middleware.js';
import { isLeaderUser } from '../auth/roles.js';
import { flash } from '../util/flash.js';
import { mdToHtml, toPlainText } from '../util/sanitize.js';
import * as dates from '../util/dates.js';
import { getBody, getFormData } from '../util/body.js';
import { render, renderBare } from '../render.js';
import { notFound } from './errors.js';
import * as attachments from '../services/chat/attachments.js';
import * as ratelimit from '../util/ratelimit.js';

const router = new Hono();

/* ---------------------------------------------------------------- limits */

const MAX_MESSAGE_CHARS = 8000;
const MAX_FILES = attachments.MAX_FILES;
const MAX_FILE_BYTES = attachments.MAX_FILE_BYTES;
const MAX_NAME = 60;

/**
 * P5 anti-runaway ceiling on posting, not a meter on a real conversation — 30
 * messages a minute is a fast typist chaining short lines during a sprint, not
 * a bot. Keyed to the poster, not the channel, so it follows a person across
 * #general, a group and a DM rather than resetting at each door.
 */
const MESSAGE_POST_MAX = 30;
const MESSAGE_POST_WINDOW = ratelimit.MINUTE_MS;
const MAX_DESC = 140;

/** Newest N shown by default; "show earlier" walks this up in the query string. */
const PAGE_SIZE = 50;
const MAX_SHOW = 500;

/** Consecutive messages by the same person inside this window are grouped. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const GENERAL_DESCRIPTION =
  'Everyone in the collective. Announcements, questions, and whatever else the group is talking about.';

/* ------------------------------------------------- queries (route-local) */

const channelById = (db, id) => one(db, 'SELECT * FROM chat_channels WHERE id = ?', id);

const generalRow = (db) =>
  one(db, "SELECT * FROM chat_channels WHERE kind = 'general' ORDER BY id LIMIT 1");

const membershipRow = (db, channelId, userId) =>
  one(db, 'SELECT * FROM chat_members WHERE channel_id = ? AND user_id = ?', channelId, userId);

const memberCountOf = async (db, channelId) =>
  (await one(db, 'SELECT COUNT(*) AS n FROM chat_members WHERE channel_id = ?', channelId)).n;

const activeMemberCount = async (db) =>
  (await one(db, 'SELECT COUNT(*) AS n FROM users WHERE is_active = 1')).n;

const joinChannel = (db, channelId, userId) =>
  run(db, 'INSERT OR IGNORE INTO chat_members (channel_id, user_id) VALUES (?, ?)', channelId, userId);

const leaveChannel = (db, channelId, userId) =>
  run(db, 'DELETE FROM chat_members WHERE channel_id = ? AND user_id = ?', channelId, userId);

/** Groups the viewer has joined (archived ones included, flagged). */
const myGroupsOf = (db, userId) =>
  all(
    db,
    `SELECT c.*, (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id) AS member_count,
            (SELECT MAX(id) FROM chat_messages x WHERE x.channel_id = c.id) AS last_message_id
       FROM chat_channels c
       JOIN chat_members cm ON cm.channel_id = c.id AND cm.user_id = ?
      WHERE c.kind = 'group'
      ORDER BY c.archived_at IS NOT NULL, LOWER(c.name)`,
    userId
  );

/** Live groups the viewer is NOT in — name and description only. */
const joinableGroupsOf = (db, userId) =>
  all(
    db,
    `SELECT c.*, (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id) AS member_count
       FROM chat_channels c
      WHERE c.kind = 'group' AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
      ORDER BY LOWER(c.name)`,
    userId
  );

/**
 * The viewer's DM conversations. Scoped by their OWN chat_members row, so this
 * statement cannot return somebody else's conversation even by accident. A pair
 * channel with no messages yet stays out of the list — "created on first
 * message" as far as anyone can see. (@me appeared twice in the Express SQL and
 * is therefore bound twice here — worker/src/db.js rule 2.)
 */
const myDmsOf = (db, userId) =>
  all(
    db,
    `SELECT c.id, c.created_at,
            other.id AS other_id, other.display_name AS other_name,
            other.username AS other_username, other.is_active AS other_active,
            (SELECT MAX(id) FROM chat_messages x WHERE x.channel_id = c.id) AS last_message_id,
            (SELECT MAX(created_at) FROM chat_messages x WHERE x.channel_id = c.id) AS last_at
       FROM chat_channels c
       JOIN chat_members mine ON mine.channel_id = c.id AND mine.user_id = ?
       JOIN chat_members theirs ON theirs.channel_id = c.id AND theirs.user_id <> ?
       JOIN users other ON other.id = theirs.user_id
      WHERE c.kind = 'dm'
        AND EXISTS (SELECT 1 FROM chat_messages x WHERE x.channel_id = c.id)
      ORDER BY last_message_id DESC`,
    userId,
    userId
  );

const dmPartnerOf = (db, channelId, userId) =>
  one(
    db,
    `SELECT u.id, u.display_name, u.username, u.is_active
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.channel_id = ? AND cm.user_id <> ? LIMIT 1`,
    channelId,
    userId
  );

const dmByPairKey = (db, pairKey) =>
  one(db, "SELECT * FROM chat_channels WHERE kind = 'dm' AND pair_key = ?", pairKey);

const insertChannelStmt = (db, kind, name, description, pairKey, createdBy) =>
  stmt(
    db,
    'INSERT INTO chat_channels (kind, name, description, pair_key, created_by) VALUES (?, ?, ?, ?, ?)',
    kind,
    name,
    description,
    pairKey,
    createdBy
  );

/** Newest `limit` messages of a channel, oldest-first once reversed. */
const latestMessages = (db, channelId, limit) =>
  all(
    db,
    `SELECT m.id, m.user_id, m.body_html, m.created_at, m.deleted_at,
            u.display_name AS author_name
       FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ?
      ORDER BY m.id DESC LIMIT ?`,
    channelId,
    limit
  );

const messageCountOf = async (db, channelId) =>
  (await one(db, 'SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ?', channelId)).n;

const attachmentsForChannel = (db, channelId) =>
  all(
    db,
    `SELECT a.* FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id
      WHERE m.channel_id = ? AND m.deleted_at IS NULL`,
    channelId
  );

/** The member picker: everyone active except the viewer. */
const otherActiveMembers = (db, userId) =>
  all(
    db,
    'SELECT id, display_name, username FROM users WHERE is_active = 1 AND id <> ? ORDER BY LOWER(display_name)',
    userId
  );

/* ------------------------------------------------------- #general bootstrap */

/**
 * There is always exactly one #general, and every active member is in it by
 * construction (no chat_members rows — "everyone" is not a list that can drift).
 *
 * Idempotent find-or-create, called where the Express module called it
 * defensively: on the way into the index. Two tabs racing the very first visit
 * both insert; the SELECT that follows takes the lowest id, and the loser is a
 * dead row nothing links to. That was true of the Express version too — the
 * only "boot" a Worker has is its first request.
 */
async function ensureGeneralChannel(db) {
  let row = await generalRow(db);
  if (!row) {
    await run(
      db,
      'INSERT INTO chat_channels (kind, name, description, pair_key, created_by) VALUES (?, ?, ?, ?, ?)',
      'general',
      'general',
      GENERAL_DESCRIPTION,
      null,
      null
    );
    row = await generalRow(db);
    console.log('[afwc] chat: seeded #general');
  }
  return row;
}

/* ------------------------------------------------------------- access rules */

const isGeneral = (channel) => channel.kind === 'general';
const isDm = (channel) => channel.kind === 'dm';

/** May this person POST? Reading plus "the channel is still open". */
const canPostTo = (channel) => channel._read && !channel.archived_at;

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
 * other end does not get to edit somebody else's words out of their own
 * transcript either.
 */
function canDeleteMessage(channel, message, user) {
  if (message.user_id === user.id) return true;
  if (isDm(channel)) return false;
  return isLeaderUser(user);
}

const channelTitleOf = (channel, partnerName) => {
  if (isGeneral(channel)) return '#general';
  if (isDm(channel)) return partnerName || 'Direct message';
  return channel.name || 'Channel';
};

const channelHref = (channel) => `/chat/c/${channel.id}`;

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

function noStore(c) {
  for (const [name, value] of Object.entries(NO_STORE)) c.header(name, value);
}

const trim = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

const pairKeyFor = (a, b) => `dm:${Math.min(a, b)}:${Math.max(a, b)}`;

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The one refusal shape in this file, in the three flavours the Express version
 * had. `mode` shapes the failure without ever changing the STATUS: everything
 * that cannot be shown is 404, so no response ever confirms that a DM exists.
 */
function notHere(c, mode) {
  if (mode === 'json') {
    return c.json({ ok: false, error: 'That conversation is not here.' }, 404, NO_STORE);
  }
  if (mode === 'bytes') {
    return c.text('Not found.', 404, NO_STORE);
  }
  return notFound(c);
}

/**
 * Loads the channel named by the route parameter and checks access in ONE
 * place. Returns null — caller answers with notHere() — when:
 *   · the id is not a positive integer, or names nothing
 *   · a DM the caller is not in            (404, never 403: a 403 would confirm
 *     the conversation exists, which is exactly the leak the DM rules prevent)
 *   · an archived group the caller never joined
 * A LIVE group the caller has not joined comes back with _read = false, so the
 * pane can show the name, the blurb and a Join button and nothing else.
 *
 * The membership row is fetched once and parked on the channel, because the
 * Express code asked for it three times per render (canRead, canPost, joined).
 */
async function loadChannel(db, c, user, param = 'channelId') {
  const id = Number(c.req.param(param));
  if (!Number.isInteger(id) || id <= 0) return null;

  const channel = await channelById(db, id);
  if (!channel) return null;

  channel._member = isGeneral(channel) ? null : await membershipRow(db, channel.id, user.id);
  const read = isGeneral(channel) || !!channel._member;
  if (!read && (isDm(channel) || channel.archived_at)) return null;

  channel._read = read;
  return channel;
}

/* ------------------------------------------------------- transcript builder */

/**
 * Newest `show` messages, oldest first, decorated for the view: day separators,
 * author grouping inside GROUP_WINDOW_MS, per-row delete permission, and each
 * message's attachments. `hasEarlier` drives the "show earlier" link.
 */
async function buildTranscript(db, channel, user, show) {
  const limit = Math.max(PAGE_SIZE, Math.min(Number(show) || PAGE_SIZE, MAX_SHOW));
  const [raw, total, attachmentRows] = await Promise.all([
    latestMessages(db, channel.id, limit),
    messageCountOf(db, channel.id),
    attachmentsForChannel(db, channel.id),
  ]);
  const rows = raw.slice().reverse();

  const byMessage = new Map();
  for (const a of attachmentRows) {
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

router.use('*', requireMember);

/* ---------------------------------------------------------------- the index */

async function renderIndex(c, channel, conversationFocused) {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const me = user.id;

  const [general, myGroups, joinable, dms, people, partner, transcript, memberCount] =
    await Promise.all([
      ensureGeneralChannel(db),
      myGroupsOf(db, me),
      joinableGroupsOf(db, me),
      myDmsOf(db, me),
      otherActiveMembers(db, me),
      isDm(channel) ? dmPartnerOf(db, channel.id, me) : null,
      channel._read
        ? buildTranscript(db, channel, user, c.req.query('show'))
        : { messages: [], show: PAGE_SIZE, hasEarlier: false, total: 0 },
      isGeneral(channel) ? activeMemberCount(db) : memberCountOf(db, channel.id),
    ]);

  const title = channelTitleOf(channel, partner && partner.display_name);

  noStore(c);
  return render(c, 'chat/index', {
    title,
    bodyClass: 'page-chat',
    pageCss: ['/css/chat.css'],
    pageJs: ['/js/chat.js'],
    general,
    channel,
    partner,
    channelTitle: title,
    memberCount,
    myGroups,
    joinable,
    dms,
    people,
    messages: transcript.messages,
    show: transcript.show,
    hasEarlier: transcript.hasEarlier,
    pageSize: PAGE_SIZE,
    canRead: channel._read,
    canPost: canPostTo(channel),
    canAdmin: canAdminChannel(channel, user),
    joined: !isGeneral(channel) && !!channel._member,
    // Only a /chat/c/:id URL means "the member picked this conversation"; the
    // bare /chat lands on #general and stays on the list at phone width.
    conversationFocused,
    limits: { maxFiles: MAX_FILES, maxFileMb: MAX_FILE_BYTES / 1024 / 1024, maxChars: MAX_MESSAGE_CHARS },
    channelHref,
  });
}

router.get('/', async (c) => {
  const general = await ensureGeneralChannel(c.env.DB);
  return renderIndex(c, { ...general, _read: true, _member: null }, false);
});

router.get('/c/:channelId', async (c) => {
  const channel = await loadChannel(c.env.DB, c, c.get('currentUser'));
  if (!channel) return notHere(c, 'html');
  return renderIndex(c, channel, true);
});

/* ------------------------------------------------- poll head + list fragment */

/**
 * The 20-second poll, deliberately boring: two integers and the newest deletion
 * stamp, from ONE aggregate query over idx_chat_messages_channel. This is the
 * hottest path in the app — public/js/chat.js asks every 20 seconds per open
 * tab — so nothing else belongs here. In particular it does NOT call
 * ensureGeneralChannel: #general either exists by now or the page that would
 * have polled it was never rendered.
 */
router.get('/c/:channelId/head', async (c) => {
  const db = c.env.DB;
  const channel = await loadChannel(db, c, c.get('currentUser'));
  if (!channel || !channel._read) return notHere(c, 'json');

  const head = await one(
    db,
    'SELECT MAX(id) AS latest_id, COUNT(*) AS count, MAX(deleted_at) AS last_delete FROM chat_messages WHERE channel_id = ?',
    channel.id
  );
  return c.json(
    {
      ok: true,
      latest_id: head.latest_id || 0,
      count: head.count || 0,
      last_delete: head.last_delete || null,
    },
    200,
    NO_STORE
  );
});

router.get('/c/:channelId/fragment', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const channel = await loadChannel(db, c, user);
  if (!channel || !channel._read) return notHere(c, 'bytes');

  const transcript = await buildTranscript(db, channel, user, c.req.query('show'));
  noStore(c);
  return renderBare(c, 'chat/messages', {
    channel,
    messages: transcript.messages,
    show: transcript.show,
    hasEarlier: transcript.hasEarlier,
    pageSize: PAGE_SIZE,
  });
});

/* ------------------------------------------------------------ post a message */

const wantsJsonRequest = (c) =>
  String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
  String(c.req.header('accept') || '').includes('application/json');

router.post('/c/:channelId/messages', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const wantsJson = wantsJsonRequest(c);
  const mode = wantsJson ? 'json' : 'html';

  const channel = await loadChannel(db, c, user);
  // A DM the caller is not in is not here — not forbidden, not here.
  if (!channel) return notHere(c, mode);

  const back = channelHref(channel);
  const fail = (status, message) => {
    if (wantsJson) return c.json({ ok: false, errors: [message] }, status, NO_STORE);
    flash(c, 'error', message);
    return c.redirect(back, 302);
  };

  // A live group the caller never joined: the pane exists, the transcript does
  // not. Same sentence and same shape the Express router used.
  if (!channel._read) return fail(404, 'That conversation is not here.');
  if (!canPostTo(channel)) {
    return fail(403, channel.archived_at ? 'This channel is archived.' : 'Join this channel first.');
  }

  if (!(await ratelimit.checkRate(db, 'chat_msg', user.id, MESSAGE_POST_MAX, MESSAGE_POST_WINDOW))) {
    return fail(429, "You're posting a little too fast — wait a few seconds and send that again.");
  }

  const { fields, files: fileMap } = await getFormData(c);
  const files = fileMap.files || [];

  // multer's limits, applied by hand now that there is no streaming parser.
  const limitComplaint = attachments.limitError(files);
  if (limitComplaint) return fail(400, limitComplaint);

  const body = trim(fields.body, MAX_MESSAGE_CHARS);
  if (!body && !files.length) return fail(400, 'Write something (or attach a file) first.');

  const bodyHtml = body ? mdToHtml(body) : '';
  if (body && !toPlainText(bodyHtml).trim() && !files.length) {
    return fail(400, 'Nothing survived the formatting filter — try plain text or simple markdown.');
  }

  /* ---- every attachment is checked before a single byte is kept ---- */
  const checked = [];
  for (const file of files) {
    const name = toPlainText(file.name, 80) || 'that file';
    const ext = attachments.extname(file.name);
    if (!attachments.ALLOWED[ext]) {
      return fail(
        400,
        `“${name}” is not a file type chat accepts (images, PDF, Word, text, markdown or zip).`
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return fail(400, `“${name}” is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    }
    const complaint = attachments.sniff(ext, bytes);
    if (complaint) return fail(400, `“${name}” ${complaint}`);
    checked.push({ file, bytes, ext });
  }

  /* ---- row first (its id names the folder), then the bytes ---- */
  const meta = await run(
    db,
    'INSERT INTO chat_messages (channel_id, user_id, body_html) VALUES (?, ?, ?)',
    channel.id,
    user.id,
    bodyHtml
  );
  const messageId = Number(meta.last_row_id);

  const stored = [];
  try {
    for (const item of checked) {
      stored.push(
        await attachments.store(c.env, channel.id, messageId, item.file, item.bytes, item.ext)
      );
    }
    if (stored.length) {
      await db.batch(
        stored.map((row) =>
          stmt(
            db,
            'INSERT INTO chat_attachments (message_id, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)',
            messageId,
            toPlainText(row.original_name, 160) || `file${attachments.extname(row.stored_name)}`,
            row.stored_name,
            row.mime,
            row.size
          )
        )
      );
    }
  } catch (err) {
    console.error('[afwc] chat attachment store failed:', err);
    for (const row of stored) {
      await attachments.unlinkStored(c.env, channel.id, messageId, row.stored_name);
    }
    try {
      await run(db, 'DELETE FROM chat_messages WHERE id = ?', messageId); // attachments cascade
    } catch {
      /* nothing more to do */
    }
    return fail(500, 'We could not store that attachment. Please try again.');
  }

  if (wantsJson) {
    return c.json({ ok: true, id: messageId, redirect: `${back}#m-${messageId}` }, 201, NO_STORE);
  }
  return c.redirect(`${back}#m-${messageId}`, 302);
});

/* ------------------------------------------------------------ delete a message */

router.post('/messages/:id/delete', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return notFound(c);

  const message = await one(db, 'SELECT * FROM chat_messages WHERE id = ?', id);
  if (!message || message.deleted_at) return notFound(c);

  const channel = await channelById(db, message.channel_id);
  // A DM the caller is not in is 404 all the way down — including its messages.
  if (!channel) return notFound(c);
  const read = isGeneral(channel) || !!(await membershipRow(db, channel.id, user.id));
  if (!read) return notFound(c);

  if (!canDeleteMessage(channel, message, user)) {
    throw new HttpError(
      403,
      isDm(channel)
        ? 'Only the person who wrote a private message can remove it.'
        : 'Only the person who wrote a message (or a leader) can remove it.'
    );
  }

  await run(
    db,
    `UPDATE chat_messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    user.id,
    message.id
  );
  return c.redirect(`${channelHref(channel)}#m-${message.id}`, 302);
});

/* ------------------------------------------------------------------- groups */

router.post('/groups', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const body = await getBody(c);
  const name = trim(body.name, MAX_NAME).replace(/\s+/g, ' ');
  const description = trim(body.description, MAX_DESC).replace(/\s+/g, ' ');

  if (!name) {
    flash(c, 'error', 'Give the group a name.');
    return c.redirect('/chat', 302);
  }

  // The Express db.transaction() becomes one batch: the creator's membership
  // row lands with the channel or not at all, and last_insert_rowid() inside
  // the batch names the row the statement before it just wrote.
  const results = await db.batch([
    insertChannelStmt(db, 'group', name, description || null, null, user.id),
    stmt(
      db,
      'INSERT OR IGNORE INTO chat_members (channel_id, user_id) VALUES (last_insert_rowid(), ?)',
      user.id
    ),
  ]);
  const id = Number(results[0].meta.last_row_id);

  flash(c, 'ok', `“${name}” is open. Anyone in the group can join it.`);
  return c.redirect(`/chat/c/${id}`, 302);
});

router.post('/c/:channelId/rename', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const channel = await loadChannel(db, c, user);
  if (!channel) return notHere(c, 'html');
  if (!canAdminChannel(channel, user)) {
    throw new HttpError(403, 'Only the member who started this group (or a leader) can rename it.');
  }
  const body = await getBody(c);
  const name = trim(body.name, MAX_NAME).replace(/\s+/g, ' ');
  const description = trim(body.description, MAX_DESC).replace(/\s+/g, ' ');
  if (!name) {
    flash(c, 'error', 'A group needs a name.');
    return c.redirect(channelHref(channel), 302);
  }
  await run(
    db,
    'UPDATE chat_channels SET name = ?, description = ? WHERE id = ?',
    name,
    description || null,
    channel.id
  );
  flash(c, 'ok', 'Group updated.');
  return c.redirect(channelHref(channel), 302);
});

router.post('/c/:channelId/join', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const channel = await loadChannel(db, c, user);
  if (!channel) return notHere(c, 'html');
  if (channel.kind !== 'group') {
    flash(c, 'info', 'Everyone is already in #general.');
    return c.redirect(channelHref(channel), 302);
  }
  if (channel.archived_at) {
    flash(c, 'error', 'That group is archived.');
    return c.redirect('/chat', 302);
  }
  await joinChannel(db, channel.id, user.id);
  flash(c, 'ok', `You’re in “${channel.name}”.`);
  return c.redirect(channelHref(channel), 302);
});

router.post('/c/:channelId/leave', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const channel = await loadChannel(db, c, user);
  if (!channel) return notHere(c, 'html');
  if (channel.kind !== 'group') {
    flash(c, 'error', 'You cannot leave that conversation.');
    return c.redirect(channelHref(channel), 302);
  }
  await leaveChannel(db, channel.id, user.id);
  flash(c, 'info', `You left “${channel.name}”.`);
  return c.redirect('/chat', 302);
});

router.post('/c/:channelId/archive', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const channel = await loadChannel(db, c, user);
  if (!channel) return notHere(c, 'html');

  // #general is the one room nobody can close, and a DM is not a room at all.
  if (channel.kind !== 'group') throw new HttpError(403, 'That conversation cannot be archived.');
  if (!canAdminChannel(channel, user)) {
    throw new HttpError(403, 'Only the member who started this group (or a leader) can archive it.');
  }

  if (channel.archived_at) {
    await run(
      db,
      'UPDATE chat_channels SET archived_at = NULL, archived_by = NULL WHERE id = ?',
      channel.id
    );
    flash(c, 'ok', `“${channel.name}” is open again.`);
  } else {
    await run(
      db,
      `UPDATE chat_channels SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), archived_by = ?
        WHERE id = ? AND archived_at IS NULL`,
      user.id,
      channel.id
    );
    flash(c, 'info', `“${channel.name}” is archived. Its messages are still here to read.`);
  }
  return c.redirect(channelHref(channel), 302);
});

/* ------------------------------------------------------------------- DMs */

router.post('/dm', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const body = await getBody(c);
  const targetId = Number(body.user_id);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === user.id) {
    flash(c, 'error', 'Pick somebody to write to.');
    return c.redirect('/chat', 302);
  }
  const target = await one(
    db,
    'SELECT id, display_name, username, is_active FROM users WHERE id = ?',
    targetId
  );
  if (!target || !target.is_active) {
    flash(c, 'error', 'That member is not active any more.');
    return c.redirect('/chat', 302);
  }

  const pairKey = pairKeyFor(user.id, target.id);
  let channel = await dmByPairKey(db, pairKey);
  if (!channel) {
    /*
     * UNIQUE(pair_key) is the real guarantee; two tabs racing here means one
     * batch throws and we re-read the row the other one wrote. The two
     * membership rows name their channel through the pair key rather than
     * last_insert_rowid(), because the second of them would otherwise see the
     * id of the FIRST chat_members row, not the channel's.
     */
    try {
      await db.batch([
        insertChannelStmt(db, 'dm', null, null, pairKey, user.id),
        stmt(
          db,
          "INSERT INTO chat_members (channel_id, user_id) SELECT id, ? FROM chat_channels WHERE pair_key = ?",
          user.id,
          pairKey
        ),
        stmt(
          db,
          "INSERT INTO chat_members (channel_id, user_id) SELECT id, ? FROM chat_channels WHERE pair_key = ?",
          target.id,
          pairKey
        ),
      ]);
      channel = await dmByPairKey(db, pairKey);
    } catch (err) {
      channel = await dmByPairKey(db, pairKey);
      if (!channel) throw err;
    }
  }
  return c.redirect(channelHref(channel), 302);
});

/* ------------------------------------------------------- attachment streams */

/**
 * The only way an attachment's bytes leave this app. ACCESS IS RE-DERIVED FROM
 * THE MESSAGE'S CHANNEL ON EVERY REQUEST — a URL copied out of a DM is dead the
 * moment it reaches anyone who is not one of the two participants, and it 404s
 * rather than 403s so it does not even admit the file exists. R2 has no public
 * hostname; there is no other door.
 */
router.get('/files/:id', async (c) => {
  const db = c.env.DB;
  const user = c.get('currentUser');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return notHere(c, 'bytes');

  const row = await one(
    db,
    `SELECT a.*, m.channel_id, m.deleted_at AS message_deleted_at
       FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id
      WHERE a.id = ?`,
    id
  );
  if (!row || row.message_deleted_at) return notHere(c, 'bytes');

  const channel = await channelById(db, row.channel_id);
  if (!channel) return notHere(c, 'bytes');
  const read = isGeneral(channel) || !!(await membershipRow(db, channel.id, user.id));
  if (!read) return notHere(c, 'bytes');

  const ext = attachments.extname(row.stored_name);
  const rule = attachments.ALLOWED[ext];
  if (!rule) return notHere(c, 'bytes');

  // key() re-checks stored_name against the shape this app generates, so a
  // hand-edited row cannot name an object outside its own message folder.
  const object = await attachments.get(c.env, channel.id, row.message_id, row.stored_name);
  if (!object) return notHere(c, 'bytes');

  const safeName = String(row.original_name || 'file').replace(/["\\\r\n]/g, '');
  return c.body(object.body, 200, {
    ...NO_STORE,
    'Content-Type': row.mime || rule.mime || 'application/octet-stream',
    'Content-Length': String(object.size),
    'Content-Disposition': `${rule.inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
  });
});

export default router;
