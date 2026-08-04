'use strict';

const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { users, meetings, recurring, announcements } = require('../models');
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
    meeting: next,
    memberCount: users.countActive(),
    leaderCount: users.countLeaders(),
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

/** Weekly rules decorated with what a leader needs to see: next date + skips. */
function rulesForList() {
  return recurring.list().map((rule) => {
    const occurrences = dates.nextOccurrences(rule.weekday, rule.time_hhmm, 8);
    const skipped = new Set(recurring.skipDates(rule.id));
    const next = occurrences.find((o) => !skipped.has(o.local_date)) || null;
    return {
      ...rule,
      next,
      // Default the skip form to the next occurrence that is still on.
      skipDefault: next ? next.local_date : occurrences.length ? occurrences[0].local_date : '',
      skips: recurring.skips(rule.id),
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
  });
});

router.get('/meetings/new', (req, res) => {
  res.render('admin/meeting-form', {
    title: 'New meeting',
    bodyClass: 'page-admin',
    pageJs: ['/js/map-picker.js'],
    meeting: null,
    values: { starts_at_local: '', title: '', notes: '', location_label: '', map_x: '', map_y: '' },
    errors: [],
  });
});

function readMeetingForm(body) {
  const values = {
    starts_at_local: String(body.starts_at_local || '').trim(),
    title: trim(body.title, 120) || '',
    notes: trim(body.notes, 2000) || '',
    location_label: trim(body.location_label, 120) || '',
    map_x: coord(body.map_x),
    map_y: coord(body.map_y),
    is_cancelled: body.is_cancelled ? 1 : 0,
  };
  const errors = [];
  const starts_at = dates.localInputToUtcIso(values.starts_at_local);
  if (!starts_at) errors.push('Pick a date and time for the meeting.');
  if ((values.map_x === null) !== (values.map_y === null)) {
    errors.push('Click the floor map to place the marker (or clear it entirely).');
  }
  return { values, starts_at, errors };
}

router.post('/meetings', (req, res) => {
  const { values, starts_at, errors } = readMeetingForm(req.body);
  if (errors.length) {
    return res.status(400).render('admin/meeting-form', {
      title: 'New meeting',
      bodyClass: 'page-admin',
      pageJs: ['/js/map-picker.js'],
      meeting: null,
      values,
      errors,
    });
  }
  meetings.create({
    starts_at,
    title: values.title || null,
    notes: values.notes || null,
    location_label: values.location_label || null,
    map_x: values.map_x,
    map_y: values.map_y,
    is_cancelled: values.is_cancelled,
    created_by: req.user.id,
  });
  flash(res, 'ok', 'Meeting saved. The landing page is updated.');
  return res.redirect('/admin/meetings');
});

router.get('/meetings/:id/edit', (req, res, next) => {
  const meeting = meetings.byId(req.params.id);
  if (!meeting) return next();
  return res.render('admin/meeting-form', {
    title: 'Edit meeting',
    bodyClass: 'page-admin',
    pageJs: ['/js/map-picker.js'],
    meeting,
    values: {
      starts_at_local: dates.utcIsoToLocalInput(meeting.starts_at),
      title: meeting.title || '',
      notes: meeting.notes || '',
      location_label: meeting.location_label || '',
      map_x: meeting.map_x,
      map_y: meeting.map_y,
      is_cancelled: meeting.is_cancelled,
    },
    errors: [],
  });
});

router.post('/meetings/:id', (req, res, next) => {
  const meeting = meetings.byId(req.params.id);
  if (!meeting) return next();
  const { values, starts_at, errors } = readMeetingForm(req.body);
  if (errors.length) {
    return res.status(400).render('admin/meeting-form', {
      title: 'Edit meeting',
      bodyClass: 'page-admin',
      pageJs: ['/js/map-picker.js'],
      meeting,
      values,
      errors,
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
  });
  flash(res, 'ok', 'Meeting updated.');
  return res.redirect('/admin/meetings');
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
