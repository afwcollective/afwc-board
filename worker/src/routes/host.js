/**
 * Port of src/routes/host.js — the session host's own corner of the site.
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
 * `isHost` flag published by loadUser is a hint for views, never a gate — see
 * the note in worker/src/auth/middleware.js.
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

import { Hono } from 'hono';

import { meetings, recurring, hosts } from '../models.js';
import { requireMember, HttpError } from '../auth/middleware.js';
import { isLeaderUser } from '../auth/roles.js';
import * as dates from '../util/dates.js';
import { flash } from '../util/flash.js';
import { getBody, field } from '../util/body.js';
import { render } from '../render.js';
import { notFound } from './errors.js';

const router = new Hono();

router.use('*', requireMember);

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

const NOT_YOURS =
  'That session is being run by somebody else. Ask a leader if it should be you.';
const IN_THE_PAST = 'That session has already happened — it can be read, but not changed.';

/* ------------------------------------------------------------------ index */

router.get('/', async (c) => {
  const sessions = await hosts.upcomingForUser(
    c.env.DB,
    c.get('currentUser').id,
    hosts.HOST_WINDOW_DAYS
  );
  return render(c, 'host/index', {
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
 * and edit it. Returns null when there is no such occurrence (the caller 404s)
 * and throws the shared 403 when it belongs to somebody else.
 *
 * Authorization is exactly: the assigned user, or a leader/architect. Leaders
 * are included so somebody can fix a host's mistake ten minutes before a
 * session without demoting or reassigning anybody.
 */
async function loadOccurrence(c) {
  const db = c.env.DB;
  const rule = await recurring.byId(db, Number(c.req.param('recurringId')));
  const date = String(c.req.param('date') || '');
  if (!rule || !DATE_RE.test(date)) return null;
  if (dates.localDayOfWeek(date) !== rule.weekday) return null;

  const user = c.get('currentUser');
  const host = await hosts.forOccurrence(db, rule.id, date);
  const mine = !!host && host.user_id === user.id;
  if (!mine && !isLeaderUser(user)) throw new HttpError(403, NOT_YOURS);

  const starts_at = dates.localInputToUtcIso(`${date}T${rule.time_hhmm}`);
  return {
    rule,
    date,
    host,
    mine,
    starts_at,
    override: await hosts.override(db, rule.id, date),
    past: date < dates.localDateKey(new Date()),
  };
}

function renderOccurrence(c, ctx, { values, errors = [], status = 200 }) {
  return render(
    c,
    'host/occurrence',
    {
      title: 'Host a session',
      bodyClass: 'page-host',
      pageCss: ['/css/events.css'],
      pageJs: ctx.past ? [] : ['/js/map-picker.js'],
      ctx,
      values,
      errors,
    },
    status
  );
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

router.get('/recurring/:recurringId/:date', async (c) => {
  const ctx = await loadOccurrence(c);
  if (!ctx) return notFound(c);
  return renderOccurrence(c, ctx, { values: occurrenceValues(ctx) });
});

router.post('/recurring/:recurringId/:date', async (c) => {
  const ctx = await loadOccurrence(c);
  if (!ctx) return notFound(c);
  if (ctx.past) throw new HttpError(403, IN_THE_PAST);

  const body = await getBody(c);
  const values = {
    time_hhmm: dates.normalizeHhmm(field(body, 'time_hhmm')) || '',
    location_label: trim(field(body, 'location_label'), 120) || '',
    map_x: coord(field(body, 'map_x')),
    map_y: coord(field(body, 'map_y')),
    notes: trim(field(body, 'notes'), 2000) || '',
  };

  const errors = [];
  if (!values.time_hhmm) errors.push('Pick the time this session starts (Baltimore time).');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  if (errors.length) return renderOccurrence(c, ctx, { values, errors, status: 400 });

  /* Store only what actually differs from the rule. An override row that just
     repeats the rule would quietly freeze this date if a leader later edits the
     weekly meeting, so a host who changes nothing leaves nothing behind. */
  const same = (a, b) =>
    String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
  await hosts.saveOverride(c.env.DB, {
    recurring_id: ctx.rule.id,
    local_date: ctx.date,
    time_hhmm: same(values.time_hhmm, ctx.rule.time_hhmm) ? null : values.time_hhmm,
    location_label: same(values.location_label, ctx.rule.location_label) ? null : values.location_label || null,
    map_x: same(values.map_x, ctx.rule.map_x) && same(values.map_y, ctx.rule.map_y) ? null : values.map_x,
    map_y: same(values.map_x, ctx.rule.map_x) && same(values.map_y, ctx.rule.map_y) ? null : values.map_y,
    notes: same(values.notes, ctx.rule.notes) ? null : values.notes || null,
    updated_by: c.get('currentUser').id,
  });

  flash(c, 'ok', `Saved. The front page shows your changes for ${dates.formatDate(`${ctx.date}T12:00:00Z`)}.`);
  return c.redirect('/host', 302);
});

/* ------------------------------------------------------ one-off meeting ---- */

async function loadHostedMeeting(c) {
  const meeting = await meetings.byIdWithHost(c.env.DB, Number(c.req.param('meetingId')));
  if (!meeting) return null;
  const user = c.get('currentUser');
  const mine = !!meeting.host_user_id && meeting.host_user_id === user.id;
  if (!mine && !isLeaderUser(user)) throw new HttpError(403, NOT_YOURS);
  const todayFloor = dates.localInputToUtcIso(`${dates.localDateKey(new Date())}T00:00`);
  return { meeting, mine, past: String(meeting.starts_at) < String(todayFloor) };
}

function renderMeeting(c, ctx, { values, errors = [], status = 200 }) {
  return render(
    c,
    'host/meeting',
    {
      title: 'Host a session',
      bodyClass: 'page-host',
      pageCss: ['/css/events.css'],
      pageJs: ctx.past ? [] : ['/js/map-picker.js'],
      ctx,
      values,
      errors,
    },
    status
  );
}

router.get('/meeting/:meetingId', async (c) => {
  const ctx = await loadHostedMeeting(c);
  if (!ctx) return notFound(c);
  return renderMeeting(c, ctx, {
    values: {
      starts_at_local: dates.utcIsoToLocalInput(ctx.meeting.starts_at),
      location_label: ctx.meeting.location_label || '',
      map_x: ctx.meeting.map_x,
      map_y: ctx.meeting.map_y,
      notes: ctx.meeting.notes || '',
    },
  });
});

router.post('/meeting/:meetingId', async (c) => {
  const ctx = await loadHostedMeeting(c);
  if (!ctx) return notFound(c);
  if (ctx.past) throw new HttpError(403, IN_THE_PAST);

  const body = await getBody(c);
  const values = {
    starts_at_local: String(field(body, 'starts_at_local') || '').trim(),
    location_label: trim(field(body, 'location_label'), 120) || '',
    map_x: coord(field(body, 'map_x')),
    map_y: coord(field(body, 'map_y')),
    notes: trim(field(body, 'notes'), 2000) || '',
  };

  const errors = [];
  const starts_at = dates.localInputToUtcIso(values.starts_at_local);
  if (!starts_at) errors.push('Pick the date and time this session starts.');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  if (errors.length) return renderMeeting(c, ctx, { values, errors, status: 400 });

  await meetings.updateByHost(c.env.DB, {
    id: ctx.meeting.id,
    starts_at,
    location_label: values.location_label || null,
    map_x: values.map_x,
    map_y: values.map_y,
    notes: values.notes || null,
  });

  flash(c, 'ok', 'Saved. The front page has your changes.');
  return c.redirect('/host', 302);
});

export default router;
