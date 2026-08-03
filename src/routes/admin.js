'use strict';

const express = require('express');
const { getSetting, setSetting } = require('../db');
const { users, meetings, announcements } = require('../models');
const { requireLeader } = require('../auth/middleware');
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
  const next = meetings.next();
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

router.get('/meetings', (req, res) => {
  res.render('admin/meetings', {
    title: 'Meetings',
    bodyClass: 'page-admin',
    upcoming: meetings.upcoming(),
    past: meetings.past(10),
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

/* ---------------------------------------------------------------- members */

router.get('/members', (req, res) => {
  res.render('admin/members', {
    title: 'Members',
    bodyClass: 'page-admin',
    people: users.list(),
    leaderCount: users.countLeaders(),
  });
});

/** True while `target` is the only active leader — the one guard everything below respects. */
function isLastActiveLeader(target) {
  return target.role === 'leader' && target.is_active === 1 && users.countLeaders() <= 1;
}

router.post('/members/:id/deactivate', (req, res, next) => {
  const target = users.byId(req.params.id);
  if (!target) return next();
  if (isLastActiveLeader(target)) {
    flash(res, 'error', `${target.display_name} is the only active leader — promote someone else first.`);
    return res.redirect('/admin/members');
  }
  users.setActive(target.id, 0);
  sessions.destroyAllForUser(target.id);
  flash(res, 'ok', `${target.display_name} was deactivated and signed out everywhere.`);
  return res.redirect('/admin/members');
});

router.post('/members/:id/reactivate', (req, res, next) => {
  const target = users.byId(req.params.id);
  if (!target) return next();
  users.setActive(target.id, 1);
  flash(res, 'ok', `${target.display_name} can sign in again.`);
  return res.redirect('/admin/members');
});

router.post('/members/:id/promote', (req, res, next) => {
  const target = users.byId(req.params.id);
  if (!target) return next();
  users.setRole(target.id, 'leader');
  flash(res, 'ok', `${target.display_name} is now a leader.`);
  return res.redirect('/admin/members');
});

router.post('/members/:id/demote', (req, res, next) => {
  const target = users.byId(req.params.id);
  if (!target) return next();
  if (isLastActiveLeader(target)) {
    flash(res, 'error', `${target.display_name} is the only active leader — promote someone else first.`);
    return res.redirect('/admin/members');
  }
  users.setRole(target.id, 'member');
  flash(res, 'ok', `${target.display_name} is a member again.`);
  return res.redirect('/admin/members');
});

router.post('/members/:id/reset-code', (req, res, next) => {
  const target = users.byId(req.params.id);
  if (!target) return next();
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
