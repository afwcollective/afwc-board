'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');

const { db, getSetting, setSetting } = require('../db');
const { users, meetings, recurring, announcements, hosts, eventFiles, about, quotes } = require('../models');
const attachments = require('../services/events/attachments');
const { TMP_DIR } = require('../services/ingest/paths');
const { requireLeader, requireArchitect } = require('../auth/middleware');
const roles = require('../auth/roles');
const { hashSecret } = require('../auth/passwords');
const sessions = require('../auth/sessions');
const { generateResetCode, RESET_CODE_TTL_MS } = require('../util/resetcode');
const { mdToHtml, toPlainText } = require('../util/sanitize');
const dates = require('../util/dates');
const { flash } = require('../util/flash');
const { streamBackup } = require('../services/backup');

const router = express.Router();

// Every route below is leaders-only.
router.use(requireLeader);

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
 * Where to send a leader after a POST, when the caller asked for somewhere
 * other than that route's own default landing page — e.g. the dashboard's
 * inline host/pin forms, which want to land back on /admin instead of
 * /admin/meetings. Same-origin relative paths only; anything else (missing,
 * absolute URL, protocol-relative "//host") falls back to the route's usual
 * redirect so every existing caller is unaffected.
 */
function safeReturnTo(raw, fallback) {
  const v = String(raw == null ? '' : raw);
  return v.startsWith('/') && !v.startsWith('//') ? v : fallback;
}

/* -------------------------------------------------------------- dashboard */

const BACKUP_STALE_MS = 30 * 24 * 3600e3;

router.get('/', (req, res) => {
  const next = meetings.nextUnified();
  const lastBackupAt = getSetting('last_backup_at', null);
  const backupStale = !lastBackupAt || Date.now() - new Date(lastBackupAt).getTime() > BACKUP_STALE_MS;
  res.render('admin/dashboard', {
    title: 'Admin',
    bodyClass: 'page-admin',
    pageCss: ['/css/admin.css'],
    pageJs: ['/js/map-picker.js'],
    meeting: next,
    // The next-session card's host picker needs the same active-member pool
    // the meeting form and the weekly host-assign form already use.
    memberOptions: users.listActive(),
    memberCount: users.countActive(),
    leaderCount: users.countLeaders(),
    expiringLeaderCount: users.countExpiringLeaders(14),
    announcementCount: announcements.list(100).length,
    passcodeSet: !!getSetting('group_passcode_hash'),
    watermarkOn: getSetting('watermark_on', '1') === '1',
    lastBackupAt,
    backupStale,
  });
});

/* --------------------------------------------------- watermark toggle */

router.post('/settings/watermark', (req, res) => {
  const on = getSetting('watermark_on', '1') === '1';
  setSetting('watermark_on', on ? '0' : '1');
  flash(
    res,
    'info',
    on
      ? 'Watermark turned off. Reader pages no longer show the viewer’s name.'
      : 'Watermark turned on. Reader pages now show a faint tag of the viewer’s name.'
  );
  return res.redirect('/admin');
});

/* --------------------------------------------------------------- meetings */

/** How many dates ahead the "give this one to a host" picker offers. */
const HOST_PICK_AHEAD = 6;

/**
 * Weekly rules decorated with what a leader needs to see: next date, skips, the
 * dates a host can be handed, and who already has one.
 */
function rulesForList() {
  return recurring.list().map((rule) => {
    const occurrences = dates.nextOccurrences(rule.weekday, rule.time_hhmm, 8);
    const skipped = new Set(recurring.skipDates(rule.id));
    const next = occurrences.find((o) => !skipped.has(o.local_date)) || null;
    const assigned = hosts.forRule(rule.id);
    const assignedByDate = new Map(assigned.map((a) => [a.local_date, a]));
    return {
      ...rule,
      next,
      // Default the skip form to the next occurrence that is still on.
      skipDefault: next ? next.local_date : occurrences.length ? occurrences[0].local_date : '',
      skips: recurring.skips(rule.id),
      // Host assignment is per-DATE, mirroring "skip a date": the same list of
      // upcoming occurrences, minus the ones already called off.
      hostDates: occurrences
        .filter((o) => !skipped.has(o.local_date))
        .slice(0, HOST_PICK_AHEAD)
        .map((o) => ({ ...o, host: assignedByDate.get(o.local_date) || null })),
      hosts: assigned,
    };
  });
}

router.get('/meetings', (req, res) => {
  res.render('admin/meetings', {
    title: 'Meetings',
    bodyClass: 'page-admin',
    upcoming: meetings.upcoming(),
    past: meetings.past(10),
    rules: rulesForList(),
    memberOptions: users.listActive(),
  });
});

/* ---- one-off meetings: R. House tables and off-site events ----------------
 *
 * One form covers both, because to a leader they are the same errand ("the
 * group is meeting here, then"). `kind` swaps the second half of the form:
 *   rhouse  → the floor map picker, as it has always been.
 *   offsite → an address, markdown details, and up to five attachments — all
 *             three MEMBERS-ONLY on the front page (see views/home.ejs and
 *             meetings.publicSafe in src/models.js).
 *
 * MULTIPART + CSRF: attachments make this a multipart form, and checkCsrf runs
 * before any body parser sees a multipart request — so, exactly like the draft
 * upload, the page posts itself as an XHR carrying X-CSRF-Token and this route
 * answers JSON (public/js/event-form.js). The non-XHR path still works and
 * redirects, so the route survives the day the CSRF middleware learns to read
 * multipart bodies.
 */

const KINDS = new Set(['rhouse', 'offsite']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(String(file.originalname || '')).toLowerCase().slice(0, 12);
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: {
    fileSize: attachments.MAX_BYTES,
    files: attachments.MAX_FILES,
    fields: 24,
    parts: attachments.MAX_FILES + 28,
  },
});

function acceptAttachments(req, res, next) {
  upload.array('attachments', attachments.MAX_FILES)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = `Attachments are limited to ${attachments.MAX_BYTES / 1024 / 1024} MB each.`;
      } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT') {
        req.uploadError = `An event can carry up to ${attachments.MAX_FILES} attachments.`;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        req.uploadError = 'That form had a file field we do not recognise.';
      } else {
        req.uploadError = 'The upload did not arrive intact. Please try again.';
      }
    }
    next();
  });
}

const wantsJson = (req) =>
  req.xhr ||
  String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
  String(req.get('accept') || '').includes('application/json');

function renderMeetingForm(res, { meeting, values, errors, files = [], memberOptions, status = 200 }) {
  return res.status(status).render('admin/meeting-form', {
    title: meeting ? 'Edit meeting' : 'New meeting',
    bodyClass: 'page-admin',
    pageCss: ['/css/events.css'],
    pageJs: ['/js/map-picker.js', '/js/event-form.js'],
    meeting,
    values,
    files,
    memberOptions,
    limits: {
      maxFiles: attachments.MAX_FILES,
      maxMb: attachments.MAX_BYTES / 1024 / 1024,
      formats: attachments.EXT_LIST,
    },
    errors,
  });
}

/** Answer a rejected submit the way the caller asked for it. */
function meetingFormFailed(req, res, ctx) {
  attachments.discard(req.files);
  if (wantsJson(req)) return res.status(400).json({ ok: false, errors: ctx.errors });
  return renderMeetingForm(res, { ...ctx, status: 400 });
}

const EMPTY_MEETING = {
  starts_at_local: '', title: '', notes: '', location_label: '', map_x: '', map_y: '',
  kind: 'rhouse', address: '', body_md: '', host_user_id: '', is_cancelled: 0,
};

router.get('/meetings/new', (req, res) =>
  renderMeetingForm(res, {
    meeting: null,
    values: { ...EMPTY_MEETING },
    errors: [],
    memberOptions: users.listActive(),
  })
);

function readMeetingForm(body) {
  const kind = KINDS.has(String(body.kind)) ? String(body.kind) : 'rhouse';
  const offsite = kind === 'offsite';
  const values = {
    starts_at_local: String(body.starts_at_local || '').trim(),
    title: trim(body.title, 120) || '',
    notes: trim(body.notes, 2000) || '',
    location_label: offsite ? '' : trim(body.location_label, 120) || '',
    // An off-site event has no table on the R. House floor map — clearing the
    // pin here is what makes the landing card drop the map entirely.
    map_x: offsite ? null : coord(body.map_x),
    map_y: offsite ? null : coord(body.map_y),
    is_cancelled: body.is_cancelled ? 1 : 0,
    kind,
    address: offsite ? trim(body.address, 200) || '' : '',
    body_md: offsite ? String(body.body_md || '').trim().slice(0, 20000) : '',
    host_user_id: String(body.host_user_id || '').trim(),
  };

  const errors = [];
  const starts_at = dates.localInputToUtcIso(values.starts_at_local);
  if (!starts_at) errors.push('Pick a date and time for the meeting.');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  if (offsite) {
    if (!values.title) errors.push('Give the off-site event a title — it is all the public page shows.');
    if (!values.address) errors.push('Add the address. Members see it once they sign in; nobody else does.');
  }

  // "none" and an unknown id both mean nobody. A booted account is not offered.
  let host_user_id = null;
  if (values.host_user_id) {
    const candidate = users.byId(Number(values.host_user_id));
    if (candidate && candidate.is_active) host_user_id = candidate.id;
    else errors.push('That host is not an active member — pick somebody else, or "Nobody yet".');
  }

  const body_html = offsite && values.body_md ? mdToHtml(values.body_md) : null;
  if (offsite && values.body_md && !toPlainText(body_html)) {
    errors.push('Nothing survived the formatting filter in the details — try plain text or simple markdown.');
  }

  return { values, starts_at, host_user_id, body_html, errors };
}

/**
 * Validates and stores this submit's attachments. Returns { rows, errors }:
 * rows are ready for eventFiles.create, and are only written by the caller once
 * everything else about the meeting has succeeded.
 */
function takeAttachments(meetingId, files, existingCount, kind) {
  const list = files || [];
  const errors = [];
  if (!list.length) return { rows: [], errors };
  if (kind !== 'offsite') {
    // Files were attached and then the leader flipped back to R. House.
    return { rows: [], errors: ['Attachments belong to off-site events — switch the kind back, or remove them.'] };
  }
  if (existingCount + list.length > attachments.MAX_FILES) {
    return {
      rows: [],
      errors: [`An event can carry up to ${attachments.MAX_FILES} attachments (this one already has ${existingCount}).`],
    };
  }

  const rows = [];
  for (const file of list) {
    const checked = attachments.validate(file);
    if (checked.error) {
      errors.push(`“${toPlainText(file.originalname, 80)}” ${checked.error}`);
      continue;
    }
    rows.push({ file, checked });
  }
  if (errors.length) return { rows: [], errors };

  return { rows: rows.map(({ file, checked }) => attachments.store(meetingId, file, checked)), errors };
}

/** Ids the edit form ticked for removal, as numbers. */
function removalIds(body) {
  const raw = body.remove_attachment;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

router.post('/meetings', acceptAttachments, (req, res) => {
  const memberOptions = users.listActive();
  const { values, starts_at, host_user_id, body_html, errors } = readMeetingForm(req.body || {});
  if (req.uploadError) errors.unshift(req.uploadError);
  if (errors.length) {
    return meetingFormFailed(req, res, { meeting: null, values, errors, memberOptions });
  }

  const id = Number(
    meetings.create({
      starts_at,
      title: values.title || null,
      notes: values.notes || null,
      location_label: values.location_label || null,
      map_x: values.map_x,
      map_y: values.map_y,
      is_cancelled: values.is_cancelled,
      kind: values.kind,
      address: values.address || null,
      body_html,
      body_md: values.body_md || null,
      host_user_id,
      created_by: req.user.id,
    }).lastInsertRowid
  );

  const stored = takeAttachments(id, req.files, 0, values.kind);
  if (stored.errors.length) {
    // The meeting exists and is correct; only the files were refused. Say so
    // rather than throwing away everything the leader typed.
    for (const row of stored.rows) attachments.unlinkStored(id, row.stored_name);
    attachments.discard(req.files);
    flash(res, 'error', `Meeting saved, but the attachments were not: ${stored.errors.join(' ')}`);
    const location = `/admin/meetings/${id}/edit`;
    if (wantsJson(req)) return res.status(201).json({ ok: true, id, redirect: location });
    return res.redirect(location);
  }
  for (const row of stored.rows) eventFiles.create(row);

  flash(res, 'ok', 'Meeting saved. The landing page is updated.');
  if (wantsJson(req)) return res.status(201).json({ ok: true, id, redirect: '/admin/meetings' });
  return res.redirect('/admin/meetings');
});

function meetingValues(meeting) {
  return {
    starts_at_local: dates.utcIsoToLocalInput(meeting.starts_at),
    title: meeting.title || '',
    notes: meeting.notes || '',
    location_label: meeting.location_label || '',
    map_x: meeting.map_x,
    map_y: meeting.map_y,
    is_cancelled: meeting.is_cancelled,
    kind: meeting.kind || 'rhouse',
    address: meeting.address || '',
    body_md: meeting.body_md || '',
    host_user_id: meeting.host_user_id == null ? '' : String(meeting.host_user_id),
  };
}

router.get('/meetings/:id/edit', (req, res, next) => {
  const meeting = meetings.byId(req.params.id);
  if (!meeting) return next();
  return renderMeetingForm(res, {
    meeting,
    values: meetingValues(meeting),
    errors: [],
    files: eventFiles.forMeeting(meeting.id),
    memberOptions: users.listActive(),
  });
});

router.post('/meetings/:id', acceptAttachments, (req, res, next) => {
  const meeting = meetings.byId(req.params.id);
  if (!meeting) return next();

  const memberOptions = users.listActive();
  const existing = eventFiles.forMeeting(meeting.id);
  const { values, starts_at, host_user_id, body_html, errors } = readMeetingForm(req.body || {});
  if (req.uploadError) errors.unshift(req.uploadError);
  if (errors.length) {
    return meetingFormFailed(req, res, { meeting, values, errors, files: existing, memberOptions });
  }

  const removing = new Set(removalIds(req.body || {}));
  const keeping = existing.filter((f) => !removing.has(f.id));
  const stored = takeAttachments(meeting.id, req.files, keeping.length, values.kind);
  if (stored.errors.length) {
    for (const row of stored.rows) attachments.unlinkStored(meeting.id, row.stored_name);
    return meetingFormFailed(req, res, {
      meeting,
      values,
      errors: stored.errors,
      files: existing,
      memberOptions,
    });
  }

  meetings.update({
    id: meeting.id,
    starts_at,
    title: values.title || null,
    notes: values.notes || null,
    location_label: values.location_label || null,
    map_x: values.map_x,
    map_y: values.map_y,
    is_cancelled: values.is_cancelled,
    kind: values.kind,
    address: values.address || null,
    body_html,
    body_md: values.body_md || null,
    host_user_id,
  });

  for (const file of existing) {
    if (!removing.has(file.id)) continue;
    eventFiles.remove(file.id, meeting.id);
    attachments.unlinkStored(meeting.id, file.stored_name);
  }
  for (const row of stored.rows) eventFiles.create(row);

  flash(res, 'ok', 'Meeting updated.');
  // The dashboard's next-session card reuses this route for its host/pin form
  // and wants to land back on /admin rather than the meetings list.
  const back = safeReturnTo(req.body.return_to, '/admin/meetings');
  if (wantsJson(req)) return res.json({ ok: true, id: meeting.id, redirect: back });
  return res.redirect(back);
});

router.post('/meetings/:id/cancel', (req, res, next) => {
  const meeting = meetings.byId(req.params.id);
  if (!meeting) return next();
  const cancel = meeting.is_cancelled ? 0 : 1;
  meetings.setCancelled(meeting.id, cancel);
  flash(res, 'info', cancel ? 'Meeting marked cancelled.' : 'Meeting is back on.');
  return res.redirect('/admin/meetings');
});

router.post('/meetings/:id/delete', (req, res, next) => {
  const meeting = meetings.byId(req.params.id);
  if (!meeting) return next();
  meetings.softDelete(meeting.id, req.user.id);
  flash(res, 'info', 'Meeting removed.');
  return res.redirect('/admin/meetings');
});

/* ------------------------------------------------- recurring weekly rules */

/* The rule form lives on its own page rather than inline on /admin/meetings:
   it carries the same interactive floor map as the one-off meeting form, and
   map-picker.js binds to a single #floormap-svg / #map_x / #map_y set. */

const EMPTY_RULE = {
  weekday: 6, time_hhmm: '13:00', title: '', location_label: '', notes: '',
  map_x: '', map_y: '', is_active: 1,
};

function renderRuleForm(res, { rule, values, errors, status = 200 }) {
  return res.status(status).render('admin/recurring-form', {
    title: rule ? 'Edit weekly meeting' : 'New weekly meeting',
    bodyClass: 'page-admin',
    pageJs: ['/js/map-picker.js'],
    rule,
    values,
    weekdays: dates.weekdayNames(),
    errors,
  });
}

function readRuleForm(body) {
  const weekdayRaw = Number(body.weekday);
  const values = {
    weekday: Number.isInteger(weekdayRaw) && weekdayRaw >= 0 && weekdayRaw <= 6 ? weekdayRaw : '',
    time_hhmm: dates.normalizeHhmm(body.time_hhmm) || '',
    title: trim(body.title, 120) || '',
    location_label: trim(body.location_label, 120) || '',
    notes: trim(body.notes, 2000) || '',
    map_x: coord(body.map_x),
    map_y: coord(body.map_y),
    is_active: body.is_active ? 1 : 0,
  };
  const errors = [];
  if (values.weekday === '') errors.push('Pick the day of the week this meeting happens on.');
  if (!values.time_hhmm) errors.push('Pick the time the meeting starts (Baltimore time).');
  if (!values.title) errors.push('Give the weekly meeting a title — it shows on the front page.');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  return { values, errors };
}

router.get('/recurring/new', (req, res) => renderRuleForm(res, { rule: null, values: { ...EMPTY_RULE }, errors: [] }));

router.post('/recurring', (req, res) => {
  const { values, errors } = readRuleForm(req.body);
  if (errors.length) return renderRuleForm(res, { rule: null, values, errors, status: 400 });
  recurring.create({
    weekday: values.weekday,
    time_hhmm: values.time_hhmm,
    title: values.title,
    location_label: values.location_label || null,
    notes: values.notes || null,
    map_x: values.map_x,
    map_y: values.map_y,
    is_active: values.is_active,
    created_by: req.user.id,
  });
  flash(res, 'ok', `Weekly meeting saved — every ${dates.weekdayName(values.weekday)}, no re-entry needed.`);
  return res.redirect('/admin/meetings#weekly');
});

function ruleValues(rule) {
  return {
    weekday: rule.weekday,
    time_hhmm: rule.time_hhmm,
    title: rule.title || '',
    location_label: rule.location_label || '',
    notes: rule.notes || '',
    map_x: rule.map_x,
    map_y: rule.map_y,
    is_active: rule.is_active,
  };
}

router.get('/recurring/:id/edit', (req, res, next) => {
  const rule = recurring.byId(req.params.id);
  if (!rule) return next();
  return renderRuleForm(res, { rule, values: ruleValues(rule), errors: [] });
});

// Bare /admin/recurring/:id is the same page, one redirect away.
router.get('/recurring/:id', (req, res) => res.redirect(`/admin/recurring/${encodeURIComponent(req.params.id)}/edit`));

router.post('/recurring/:id', (req, res, next) => {
  const rule = recurring.byId(req.params.id);
  if (!rule) return next();
  const { values, errors } = readRuleForm(req.body);
  if (errors.length) return renderRuleForm(res, { rule, values, errors, status: 400 });
  recurring.update({
    id: rule.id,
    weekday: values.weekday,
    time_hhmm: values.time_hhmm,
    title: values.title,
    location_label: values.location_label || null,
    notes: values.notes || null,
    map_x: values.map_x,
    map_y: values.map_y,
    is_active: values.is_active,
  });
  flash(res, 'ok', 'Weekly meeting updated.');
  return res.redirect('/admin/meetings#weekly');
});

router.post('/recurring/:id/toggle', (req, res, next) => {
  const rule = recurring.byId(req.params.id);
  if (!rule) return next();
  const activate = rule.is_active ? 0 : 1;
  recurring.setActive(rule.id, activate);
  flash(
    res,
    'info',
    activate
      ? `“${rule.title}” is back on the front page every ${dates.weekdayName(rule.weekday)}.`
      : `“${rule.title}” is paused — it no longer appears on the front page.`
  );
  return res.redirect('/admin/meetings#weekly');
});

router.post('/recurring/:id/delete', (req, res, next) => {
  const rule = recurring.byId(req.params.id);
  if (!rule) return next();
  recurring.remove(rule.id);
  flash(res, 'info', `“${rule.title}” was removed from the weekly schedule.`);
  return res.redirect('/admin/meetings#weekly');
});

/* Skipping one week: a date, not a cancellation. The rule keeps running. */

router.post('/recurring/:id/skip', (req, res, next) => {
  const rule = recurring.byId(req.params.id);
  if (!rule) return next();
  const skipDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.skip_date || '').trim())
    ? String(req.body.skip_date).trim()
    : null;
  if (!skipDate) {
    flash(res, 'error', 'Pick the date of the week you want to skip.');
    return res.redirect('/admin/meetings#weekly');
  }
  if (dates.localDayOfWeek(skipDate) !== rule.weekday) {
    flash(
      res,
      'error',
      `${skipDate} is not a ${dates.weekdayName(rule.weekday)} — pick the date of the ${dates.weekdayName(rule.weekday)} you want to skip.`
    );
    return res.redirect('/admin/meetings#weekly');
  }
  recurring.addSkip(rule.id, skipDate, req.user.id);
  flash(res, 'ok', `No meeting on ${dates.formatDate(`${skipDate}T12:00:00Z`)} — the front page skips straight to the next one.`);
  return res.redirect('/admin/meetings#weekly');
});

router.post('/recurring/skips/:skipId/delete', (req, res) => {
  recurring.removeSkip(req.params.skipId);
  flash(res, 'info', 'That week is back on.');
  return res.redirect('/admin/meetings#weekly');
});

/* Handing one session to a host. Per DATE, exactly like skipping a week — a
   host runs one Saturday, not "Saturdays". */

router.post('/recurring/:id/host', (req, res, next) => {
  const rule = recurring.byId(req.params.id);
  if (!rule) return next();

  const back = safeReturnTo(req.body.return_to, '/admin/meetings#weekly');

  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.local_date || '').trim())
    ? String(req.body.local_date).trim()
    : null;
  if (!localDate || dates.localDayOfWeek(localDate) !== rule.weekday) {
    flash(res, 'error', `Pick the date of the ${dates.weekdayName(rule.weekday)} you want to hand over.`);
    return res.redirect(back);
  }

  const raw = String(req.body.user_id || '').trim();
  if (!raw || raw === 'none') {
    /* Unassigning also clears that date's overrides — see the note on
       hosts.unassign in src/models.js. With nobody running the session, the
       occurrence should read exactly like the rule again. */
    const previous = hosts.forOccurrence(rule.id, localDate);
    hosts.unassign(rule.id, localDate);
    flash(
      res,
      'info',
      previous
        ? `${previous.display_name} is no longer hosting ${dates.formatDate(`${localDate}T12:00:00Z`)}. Any changes they made to that session are undone.`
        : 'Nobody was hosting that date.'
    );
    return res.redirect(back);
  }

  const target = users.byId(Number(raw));
  if (!target || !target.is_active) {
    flash(res, 'error', 'Pick an active member to host that session.');
    return res.redirect(back);
  }

  hosts.assign(rule.id, localDate, target.id, req.user.id);
  flash(
    res,
    'ok',
    `${target.display_name} is hosting ${dates.formatDate(`${localDate}T12:00:00Z`)}. ` +
      'They can set the time, the table, the pin and a note for that one session at /host.'
  );
  return res.redirect(back);
});

/* ---------------------------------------------------------- announcements */

router.get('/announcements', (req, res) => {
  res.render('admin/announcements', {
    title: 'Announcements',
    bodyClass: 'page-admin',
    announcements: announcements.list(100),
    values: { title: '', body_md: '' },
    errors: [],
  });
});

router.post('/announcements', (req, res) => {
  const title = trim(req.body.title, 140);
  const body_md = String(req.body.body_md || '').trim();
  const errors = [];
  if (!title) errors.push('Give the announcement a title.');
  if (!body_md) errors.push('Write something in the body.');
  if (body_md.length > 20000) errors.push('That announcement is too long.');

  if (errors.length) {
    return res.status(400).render('admin/announcements', {
      title: 'Announcements',
      bodyClass: 'page-admin',
      announcements: announcements.list(100),
      values: { title: title || '', body_md },
      errors,
    });
  }

  const body_html = mdToHtml(body_md);
  if (!toPlainText(body_html)) {
    return res.status(400).render('admin/announcements', {
      title: 'Announcements',
      bodyClass: 'page-admin',
      announcements: announcements.list(100),
      values: { title, body_md },
      errors: ['Nothing survived the formatting filter — try plain text or simple markdown.'],
    });
  }

  announcements.create({
    title,
    body_html,
    body_md,
    is_pinned: req.body.is_pinned ? 1 : 0,
    author_id: req.user.id,
  });
  flash(res, 'ok', 'Announcement posted.');
  return res.redirect('/admin/announcements');
});

router.post('/announcements/:id/pin', (req, res, next) => {
  const a = announcements.byId(req.params.id);
  if (!a) return next();
  announcements.setPinned(a.id, a.is_pinned ? 0 : 1);
  flash(res, 'info', a.is_pinned ? 'Unpinned.' : 'Pinned to the top.');
  return res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', (req, res, next) => {
  const a = announcements.byId(req.params.id);
  if (!a) return next();
  announcements.softDelete(a.id, req.user.id);
  flash(res, 'info', 'Announcement removed.');
  return res.redirect('/admin/announcements');
});

/* --------------------------------------------------------------- about */

/*
 * The front page's "The Collective" intro — one markdown blob, stored in the
 * settings table (src/models.js's `about` helper, seeded on first read; see
 * that file for why this needed no migration). Same shape as announcements:
 * a form, a length cap, and a check that something survived the sanitizer.
 * A read-only preview underneath shows the leader what the front page will
 * actually render, since markdown-to-HTML has a couple of surprises
 * (unclosed emphasis, stray blank lines) worth catching before saving.
 */

const ABOUT_MAX_CHARS = 6000;

router.get('/about', (req, res) => {
  const body_md = about.getMd();
  res.render('admin/about', {
    title: 'About the group',
    bodyClass: 'page-admin',
    values: { body_md },
    previewHtml: mdToHtml(body_md),
    errors: [],
  });
});

router.post('/about', (req, res) => {
  const body_md = String(req.body.body_md || '').trim();
  const errors = [];
  if (!body_md) errors.push('The about text can’t be empty — write something for new visitors to read.');
  if (body_md.length > ABOUT_MAX_CHARS) errors.push(`That's too long — keep it under ${ABOUT_MAX_CHARS} characters.`);

  const body_html = body_md ? mdToHtml(body_md) : '';
  if (!errors.length && !toPlainText(body_html)) {
    errors.push('Nothing survived the formatting filter — try plain text or simple markdown.');
  }

  if (errors.length) {
    return res.status(400).render('admin/about', {
      title: 'About the group',
      bodyClass: 'page-admin',
      values: { body_md },
      previewHtml: body_html,
      errors,
    });
  }

  about.setMd(body_md);
  flash(res, 'ok', 'About text updated. The front page reflects it now.');
  return res.redirect('/admin/about');
});

/* --------------------------------------------------------------- quotes */

/*
 * The landing page's quote rail — a handful of short quotes a leader curates
 * here. Same shape as announcements: a form up top, the list underneath, one
 * row per quote. Reordering is a plain number input on each row (sort_order)
 * rather than drag-and-drop — a handful of quotes doesn't need more than
 * that, and it needs no JS to work.
 */

const QUOTE_TEXT_MAX = 200;

function readQuoteForm(body) {
  const values = {
    text: trim(body.text, QUOTE_TEXT_MAX) || '',
    attribution: trim(body.attribution, 140) || '',
    source_note: trim(body.source_note, 140) || '',
    sort_order: Number.isFinite(Number(body.sort_order)) ? Math.trunc(Number(body.sort_order)) : 0,
  };
  const errors = [];
  if (!values.text) errors.push('Write the quote itself — keep it to a line or two.');
  if (!values.attribution) errors.push('Who said it? Attribution is required.');
  return { values, errors };
}

router.get('/quotes', (req, res) => {
  res.render('admin/quotes', {
    title: 'Quote rail',
    bodyClass: 'page-admin',
    quotes: quotes.list(),
    values: { text: '', attribution: '', source_note: '', sort_order: 0 },
    errors: [],
  });
});

router.post('/quotes', (req, res) => {
  const { values, errors } = readQuoteForm(req.body || {});
  if (errors.length) {
    return res.status(400).render('admin/quotes', {
      title: 'Quote rail',
      bodyClass: 'page-admin',
      quotes: quotes.list(),
      values,
      errors,
    });
  }
  quotes.create({
    text: values.text,
    attribution: values.attribution,
    source_note: values.source_note || null,
    is_active: 1,
    sort_order: values.sort_order,
    created_by: req.user.id,
  });
  flash(res, 'ok', 'Quote added. It joins the daily rotation on the front page.');
  return res.redirect('/admin/quotes');
});

router.post('/quotes/:id', (req, res, next) => {
  const quote = quotes.byId(req.params.id);
  if (!quote) return next();
  const { values, errors } = readQuoteForm(req.body || {});
  if (errors.length) {
    return res.status(400).render('admin/quotes', {
      title: 'Quote rail',
      bodyClass: 'page-admin',
      quotes: quotes.list(),
      values,
      errors,
    });
  }
  quotes.update({
    id: quote.id,
    text: values.text,
    attribution: values.attribution,
    source_note: values.source_note || null,
    sort_order: values.sort_order,
  });
  flash(res, 'ok', 'Quote updated.');
  return res.redirect('/admin/quotes');
});

router.post('/quotes/:id/toggle', (req, res, next) => {
  const quote = quotes.byId(req.params.id);
  if (!quote) return next();
  const activate = quote.is_active ? 0 : 1;
  quotes.setActive(quote.id, activate);
  flash(res, 'info', activate ? 'Quote reactivated — back in the rotation.' : 'Quote deactivated — no longer shown.');
  return res.redirect('/admin/quotes');
});

router.post('/quotes/:id/delete', (req, res, next) => {
  const quote = quotes.byId(req.params.id);
  if (!quote) return next();
  quotes.remove(quote.id);
  flash(res, 'info', 'Quote removed.');
  return res.redirect('/admin/quotes');
});

/* --------------------------------------------------------------- passcode */

router.get('/passcode', (req, res) => {
  res.render('admin/passcode', {
    title: 'Group passcode',
    bodyClass: 'page-admin',
    passcodeSet: !!getSetting('group_passcode_hash'),
    updatedAt: null,
    errors: [],
  });
});

router.post('/passcode', (req, res) => {
  const passcode = String(req.body.passcode || '').trim();
  const passcode2 = String(req.body.passcode2 || '').trim();
  const errors = [];
  if (passcode.length < 4) errors.push('The passcode must be at least 4 characters.');
  if (passcode !== passcode2) errors.push('The two passcodes do not match.');

  if (errors.length) {
    return res.status(400).render('admin/passcode', {
      title: 'Group passcode',
      bodyClass: 'page-admin',
      passcodeSet: !!getSetting('group_passcode_hash'),
      updatedAt: null,
      errors,
    });
  }
  setSetting('group_passcode_hash', hashSecret(passcode));
  flash(res, 'ok', 'Group passcode changed. Share the new one at the next meeting.');
  return res.redirect('/admin');
});

/* ---------------------------------------------------------------- members
 *
 * The one invariant this screen protects: THERE IS ALWAYS EXACTLY ONE
 * ARCHITECT. It replaces the old "last active leader" head-count entirely —
 * because the architect can never be demoted or deactivated by anybody, the
 * board can never end up with nobody holding the keys, and so demoting or
 * booting an ordinary leader needs no arithmetic at all.
 *
 * Who may act on whom:
 *   target is architect  → nobody, including the architect themselves.
 *                          The only exit is POST /members/transfer.
 *   target is leader     → the architect only.
 *   target is member     → any leader (and the architect).
 * denyReason() is that table; every mutating route below asks it first, so the
 * buttons the view hides are also refused server-side.
 */

const ARCHITECT_ONLY = 'Only the architect can manage leaders.';
const ARCHITECT_PROTECTED =
  'The architect account cannot be deactivated, demoted or reset by anyone. ' +
  'Transfer the architect role first.';

function denyReason(actor, target) {
  if (roles.isArchitectRole(target.role)) return ARCHITECT_PROTECTED;
  if (roles.isLeaderRole(target.role) && !roles.isArchitectUser(actor)) return ARCHITECT_ONLY;
  return null;
}

/** 403 through the shared error view — same shape requireLeader/requireArchitect use. */
function forbid(next, message) {
  const err = new Error(message);
  err.status = 403;
  return next(err);
}

/**
 * Loads the target of a /members/:id action and applies denyReason. Returns the
 * user row, or null when the caller has already answered the request.
 */
function targetFor(req, res, next) {
  const target = users.byId(req.params.id);
  if (!target) {
    next();
    return null;
  }
  const reason = denyReason(req.user, target);
  if (reason) {
    forbid(next, reason);
    return null;
  }
  return target;
}

/** The promote form's duration choices. `until` reads the companion date input. */
const TERM_OPTIONS = [
  { value: 'permanent', label: 'Permanent' },
  { value: '1w', label: '1 week' },
  { value: '1m', label: '1 month' },
  { value: 'until', label: 'Until date…' },
];

/**
 * Turn the promote form's term choice into a UTC ISO expiry (or null for
 * permanent). "Until <date>" means through the END of that Baltimore day, so a
 * leader asked to cover until the 17th still has the keys on the 17th.
 */
function readTerm(body) {
  const term = String(body.term || 'permanent').trim();
  if (term === 'permanent') return { expiresAt: null };
  if (term === '1w') return { expiresAt: new Date(Date.now() + 7 * 24 * 3600e3).toISOString() };
  if (term === '1m') {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 1);
    return { expiresAt: d.toISOString() };
  }
  if (term === 'until') {
    const raw = String(body.until_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return { error: 'Pick the date the temporary leadership should end.' };
    }
    const iso = dates.localInputToUtcIso(`${raw}T23:59`);
    if (!iso) return { error: 'That end date could not be read — pick it from the date box.' };
    if (iso <= new Date().toISOString()) {
      return { error: 'That end date has already passed — pick a date in the future.' };
    }
    return { expiresAt: iso };
  }
  return { error: 'Pick how long the leadership should last.' };
}

/** "until Aug 17" / "permanently", for the flash after a promotion. */
const termPhrase = (expiresAt) =>
  expiresAt ? `until ${dates.formatDate(expiresAt)}` : 'permanently, until someone removes it';

router.get('/members', (req, res) => {
  const people = users.list();
  res.render('admin/members', {
    title: 'Members',
    bodyClass: 'page-admin',
    pageJs: ['/js/members.js'],
    people,
    leaderCount: users.countLeaders(),
    termOptions: TERM_OPTIONS,
    todayLocal: dates.localDateKey(new Date()),
    // Only the architect sees (or can use) the hand-over form.
    transferCandidates: roles.isArchitectUser(req.user)
      ? people.filter((p) => p.is_active && p.id !== req.user.id)
      : [],
  });
});

router.post('/members/:id/deactivate', (req, res, next) => {
  const target = targetFor(req, res, next);
  if (!target) return undefined;
  users.setActive(target.id, 0);
  sessions.destroyAllForUser(target.id);
  flash(res, 'ok', `${target.display_name} was deactivated and signed out everywhere.`);
  return res.redirect('/admin/members');
});

router.post('/members/:id/reactivate', (req, res, next) => {
  const target = targetFor(req, res, next);
  if (!target) return undefined;
  users.setActive(target.id, 1);
  flash(res, 'ok', `${target.display_name} can sign in again.`);
  return res.redirect('/admin/members');
});

/**
 * Promote to leader, permanently or for a fixed term. Leaders may do this to
 * members; changing an existing leader's term is leader management, so
 * denyReason sends it to the architect (shortening a term is a demotion in
 * slow motion). Nothing here can ever mint an architect — only /transfer can.
 */
router.post('/members/:id/promote', (req, res, next) => {
  const target = targetFor(req, res, next);
  if (!target) return undefined;

  const { expiresAt, error } = readTerm(req.body);
  if (error) {
    flash(res, 'error', error);
    return res.redirect('/admin/members');
  }

  users.setRole(target.id, roles.LEADER, expiresAt);
  flash(res, 'ok', `${target.display_name} is now a leader — ${termPhrase(expiresAt)}.`);
  return res.redirect('/admin/members');
});

router.post('/members/:id/demote', (req, res, next) => {
  const target = targetFor(req, res, next);
  if (!target) return undefined;
  users.setRole(target.id, roles.MEMBER);
  flash(res, 'ok', `${target.display_name} is a member again. They stay signed in; the admin console is gone.`);
  return res.redirect('/admin/members');
});

/**
 * Hand the board over. The architect picks an active account, types TRANSFER,
 * and swaps chairs: the target becomes architect, the outgoing architect
 * becomes a permanent leader. Both terms are cleared, and nobody is signed out
 * — a change of role is not a boot.
 */
const CONFIRM_WORD = 'TRANSFER';

router.post('/members/transfer', requireArchitect, (req, res) => {
  const target = users.byId(Number(req.body.user_id));
  const confirm = String(req.body.confirm || '').trim();

  if (!target || !target.is_active) {
    flash(res, 'error', 'Pick an active member or leader to hand the architect role to.');
    return res.redirect('/admin/members#transfer');
  }
  if (target.id === req.user.id) {
    flash(res, 'error', 'You already hold the architect role.');
    return res.redirect('/admin/members#transfer');
  }
  if (confirm !== CONFIRM_WORD) {
    flash(res, 'error', `Nothing changed — type ${CONFIRM_WORD} exactly (capitals) to confirm the hand-over.`);
    return res.redirect('/admin/members#transfer');
  }

  const handOver = db.transaction((fromId, toId) => {
    users.setRole(toId, roles.ARCHITECT, null);
    users.setRole(fromId, roles.LEADER, null);
  });
  handOver(req.user.id, target.id);

  flash(
    res,
    'ok',
    `${target.display_name} (@${target.username}) is now the architect of this board. ` +
      'You are a permanent leader — everyone stays signed in, but only they can manage leaders from here on.'
  );
  return res.redirect('/admin/members');
});

router.post('/members/:id/reset-code', (req, res, next) => {
  const target = targetFor(req, res, next);
  if (!target) return undefined;
  const code = generateResetCode();
  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();
  users.setResetCode(target.id, sessions.sha256(code), expiresAt);
  flash(
    res,
    'ok',
    `Reset code for ${target.display_name} (${target.username}): ${code} — expires in 48 hours. ` +
      `Text this to them now; it will not be shown again. They enter it at /reset.`
  );
  return res.redirect('/admin/members');
});

/* ---------------------------------------------------------------- backup */

router.get('/backup.zip', async (req, res, next) => {
  const stamp = dates.toDate(new Date()).toISOString().slice(0, 10);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="afwc-backup-${stamp}.zip"`);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  try {
    await streamBackup(res);
  } catch (err) {
    console.error('[afwc] backup failed:', err);
    if (!res.headersSent) return next(err);
    // Headers (and possibly some bytes) already went out — nothing left to do
    // but end the connection; a half-written zip will just fail to open.
    return res.destroy();
  }
  return undefined;
});

/* ------------------------------------------------------------------ help */

router.get('/help', (req, res) => {
  res.render('admin/help', {
    title: 'Leader handbook',
    bodyClass: 'page-admin',
    pageCss: ['/css/admin.css'],
  });
});

module.exports = router;
