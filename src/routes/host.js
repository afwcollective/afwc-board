'use strict';

/**
 * The session host's own corner of the site (Feature 2).
 *
 *   GET  /host                                 my upcoming sessions (30 days)
 *   GET  /host/recurring/:recurringId/:date    edit one weekly occurrence
 *   POST /host/recurring/:recurringId/:date
 *   GET  /host/meeting/:meetingId              edit one one-off meeting
 *   POST /host/meeting/:meetingId
 *
 * A host runs ONE session. Nothing here is a rank and nothing here is a tier:
 * every route re-checks the assignment for the exact occurrence being edited,
 * so a member who hosts next Saturday cannot touch the Saturday after it. The
 * res.locals.isHost flag published by loadUser is a hint for views, never a
 * gate — see the note in src/auth/middleware.js.
 *
 * What a host may change:
 *   weekly   → occurrence_overrides for that one date: start time, where in
 *              the room, the map pin, a note. The rule itself is untouched, so
 *              next week reverts to normal on its own.
 *   one-off  → the meeting row's time/label/pin/notes only. NOT the title, the
 *              kind, the address or who is hosting: those belong to leaders.
 *
 * Each edit page carries exactly one interactive floor map, because
 * public/js/map-picker.js binds to a single #floormap-svg / #map_x / #map_y —
 * the same reason admin/recurring-form.ejs is its own page.
 */

const express = require('express');

const { meetings, recurring, hosts } = require('../models');
const { requireMember } = require('../auth/middleware');
const { isLeaderUser } = require('../auth/roles');
const dates = require('../util/dates');
const { flash } = require('../util/flash');

const router = express.Router();

router.use(requireMember);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Clamp a map coordinate to a percentage of the SVG viewBox, or null. */
function coord(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

const trim = (v, max = 200) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Where to send the leader/host after a save, when the caller asked for
 * somewhere other than /host — the admin dashboard's next-session card, which
 * posts here (the route leaders already use to move a pin for one date) but
 * wants to land back on /admin. Same-origin relative paths only; anything
 * else falls back to the usual /host redirect, so a host saving their own
 * session is unaffected.
 */
function safeReturnTo(raw, fallback) {
  const v = String(raw == null ? '' : raw);
  return v.startsWith('/') && !v.startsWith('//') ? v : fallback;
}

function forbid(next, message) {
  const err = new Error(message);
  err.status = 403;
  return next(err);
}

const NOT_YOURS =
  'That session is being run by somebody else. Ask a leader if it should be you.';
const IN_THE_PAST = 'That session has already happened — it can be read, but not changed.';

/* ------------------------------------------------------------------ index */

router.get('/', (req, res) => {
  const sessions = hosts.upcomingForUser(req.user.id, hosts.HOST_WINDOW_DAYS);
  res.render('host/index', {
    title: 'Hosting',
    bodyClass: 'page-host',
    pageCss: ['/css/events.css'],
    sessions,
    windowDays: hosts.HOST_WINDOW_DAYS,
  });
});

/* --------------------------------------------------- weekly occurrence ---- */

/**
 * Loads the occurrence named by the URL and decides whether this user may see
 * and edit it. Returns null when the request has already been answered.
 *
 * Authorization is exactly: the assigned user, or a leader/architect. Leaders
 * are included so somebody can fix a host's mistake ten minutes before a
 * session without demoting or reassigning anybody.
 */
function loadOccurrence(req, res, next) {
  const rule = recurring.byId(Number(req.params.recurringId));
  const date = String(req.params.date || '');
  if (!rule || !DATE_RE.test(date)) {
    next();
    return null;
  }
  if (dates.localDayOfWeek(date) !== rule.weekday) {
    next();
    return null;
  }

  const host = hosts.forOccurrence(rule.id, date);
  const mine = !!host && host.user_id === req.user.id;
  if (!mine && !isLeaderUser(req.user)) {
    forbid(next, NOT_YOURS);
    return null;
  }

  const override = hosts.override(rule.id, date);
  const starts_at = dates.localInputToUtcIso(`${date}T${(override && override.time_hhmm) || rule.time_hhmm}`);
  return {
    rule,
    date,
    host,
    mine,
    starts_at,
    override,
    /* Tracks the same dates.SESSION_LINGER_MS window the landing page uses,
       rather than a bare calendar-date check, so a host mid-session keeps
       edit access exactly as long as the front page still shows them as the
       current session — including across a midnight rollover on a session
       that starts late at night. */
    past: Date.now() - new Date(starts_at).getTime() >= dates.SESSION_LINGER_MS,
  };
}

function renderOccurrence(res, ctx, { values, errors = [], status = 200 }) {
  return res.status(status).render('host/occurrence', {
    title: 'Host a session',
    bodyClass: 'page-host',
    pageCss: ['/css/events.css'],
    pageJs: ctx.past ? [] : ['/js/map-picker.js'],
    ctx,
    values,
    errors,
  });
}

function occurrenceValues(ctx) {
  const o = ctx.override || {};
  return {
    time_hhmm: o.time_hhmm || ctx.rule.time_hhmm || '',
    location_label: (o.location_label === null || o.location_label === undefined
      ? ctx.rule.location_label
      : o.location_label) || '',
    map_x: o.map_x === null || o.map_x === undefined ? ctx.rule.map_x : o.map_x,
    map_y: o.map_y === null || o.map_y === undefined ? ctx.rule.map_y : o.map_y,
    notes: (o.notes === null || o.notes === undefined ? ctx.rule.notes : o.notes) || '',
  };
}

router.get('/recurring/:recurringId/:date', (req, res, next) => {
  const ctx = loadOccurrence(req, res, next);
  if (!ctx) return undefined;
  return renderOccurrence(res, ctx, { values: occurrenceValues(ctx) });
});

router.post('/recurring/:recurringId/:date', (req, res, next) => {
  const ctx = loadOccurrence(req, res, next);
  if (!ctx) return undefined;
  if (ctx.past) return forbid(next, IN_THE_PAST);

  const values = {
    time_hhmm: dates.normalizeHhmm(req.body.time_hhmm) || '',
    location_label: trim(req.body.location_label, 120) || '',
    map_x: coord(req.body.map_x),
    map_y: coord(req.body.map_y),
    notes: trim(req.body.notes, 2000) || '',
  };

  const errors = [];
  if (!values.time_hhmm) errors.push('Pick the time this session starts (Baltimore time).');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  if (errors.length) return renderOccurrence(res, ctx, { values, errors, status: 400 });

  /* Store only what actually differs from the rule. An override row that just
     repeats the rule would quietly freeze this date if a leader later edits the
     weekly meeting, so a host who changes nothing leaves nothing behind. */
  const same = (a, b) => String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
  hosts.saveOverride({
    recurring_id: ctx.rule.id,
    local_date: ctx.date,
    time_hhmm: same(values.time_hhmm, ctx.rule.time_hhmm) ? null : values.time_hhmm,
    location_label: same(values.location_label, ctx.rule.location_label) ? null : values.location_label || null,
    map_x: same(values.map_x, ctx.rule.map_x) && same(values.map_y, ctx.rule.map_y) ? null : values.map_x,
    map_y: same(values.map_x, ctx.rule.map_x) && same(values.map_y, ctx.rule.map_y) ? null : values.map_y,
    notes: same(values.notes, ctx.rule.notes) ? null : values.notes || null,
    updated_by: req.user.id,
  });

  flash(res, 'ok', `Saved. The front page shows your changes for ${dates.formatDate(`${ctx.date}T12:00:00Z`)}.`);
  return res.redirect(safeReturnTo(req.body.return_to, '/host'));
});

/* ------------------------------------------------------ one-off meeting ---- */

function loadHostedMeeting(req, res, next) {
  const meeting = meetings.byIdWithHost(Number(req.params.meetingId));
  if (!meeting) {
    next();
    return null;
  }
  const mine = meeting.host_user_id && meeting.host_user_id === req.user.id;
  if (!mine && !isLeaderUser(req.user)) {
    forbid(next, NOT_YOURS);
    return null;
  }
  // Same dates.SESSION_LINGER_MS window as the recurring path above.
  const past = Date.now() - new Date(meeting.starts_at).getTime() >= dates.SESSION_LINGER_MS;
  return { meeting, mine, past };
}

function renderMeeting(res, ctx, { values, errors = [], status = 200 }) {
  return res.status(status).render('host/meeting', {
    title: 'Host a session',
    bodyClass: 'page-host',
    pageCss: ['/css/events.css'],
    pageJs: ctx.past ? [] : ['/js/map-picker.js'],
    ctx,
    values,
    errors,
  });
}

router.get('/meeting/:meetingId', (req, res, next) => {
  const ctx = loadHostedMeeting(req, res, next);
  if (!ctx) return undefined;
  return renderMeeting(res, ctx, {
    values: {
      starts_at_local: dates.utcIsoToLocalInput(ctx.meeting.starts_at),
      location_label: ctx.meeting.location_label || '',
      map_x: ctx.meeting.map_x,
      map_y: ctx.meeting.map_y,
      notes: ctx.meeting.notes || '',
    },
  });
});

router.post('/meeting/:meetingId', (req, res, next) => {
  const ctx = loadHostedMeeting(req, res, next);
  if (!ctx) return undefined;
  if (ctx.past) return forbid(next, IN_THE_PAST);

  const values = {
    starts_at_local: String(req.body.starts_at_local || '').trim(),
    location_label: trim(req.body.location_label, 120) || '',
    map_x: coord(req.body.map_x),
    map_y: coord(req.body.map_y),
    notes: trim(req.body.notes, 2000) || '',
  };

  const errors = [];
  const starts_at = dates.localInputToUtcIso(values.starts_at_local);
  if (!starts_at) errors.push('Pick the date and time this session starts.');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  if (errors.length) return renderMeeting(res, ctx, { values, errors, status: 400 });

  meetings.updateByHost({
    id: ctx.meeting.id,
    starts_at,
    location_label: values.location_label || null,
    map_x: values.map_x,
    map_y: values.map_y,
    notes: values.notes || null,
  });

  flash(res, 'ok', 'Saved. The front page has your changes.');
  return res.redirect(safeReturnTo(req.body.return_to, '/host'));
});

module.exports = router;
