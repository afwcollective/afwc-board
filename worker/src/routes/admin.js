/**
 * Port of src/routes/admin.js — the whole leader console.
 *
 * Route for route, guard for guard, message for message. What changed is only
 * what had to:
 *
 *   * every query is awaited (worker/src/db.js), and the handful of places the
 *     Express file looped over rules are gathered with Promise.all rather than
 *     run one after another — same queries, one round-trip's worth of latency;
 *   * ATTACHMENTS GO TO R2, not to a tmp directory and then to disk. multer is
 *     gone; the multipart body is read by the route itself, AFTER checkCsrf has
 *     verified the X-CSRF-Token header, through getFormData()
 *     (worker/src/util/body.js). See worker/src/services/events/attachments.js
 *     for the storage pattern the rest of the port follows;
 *   * `db.transaction` becomes `db.batch` in the one place this file used it —
 *     the architect hand-over, where two role UPDATEs must land together or not
 *     at all;
 *   * /admin/backup.zip forwards to /admin/backup, a real page as of P5 — see
 *     the "backup" section near the bottom of this file and
 *     worker/src/services/backup.js for the whole story.
 *
 * The MULTIPART + CSRF arrangement is unchanged and is the reason the meeting
 * form posts itself as an XHR: checkCsrf runs before any body parser sees a
 * multipart request, so it can only read the token from a header, and the route
 * answers JSON for that path (public/js/event-form.js). The non-XHR path still
 * works and redirects.
 */

import { Hono } from 'hono';

import { getSetting, setSetting, stmt } from '../db.js';
import {
  users,
  meetings,
  recurring,
  announcements,
  hosts,
  eventFiles,
  about,
  quotes,
} from '../models.js';
import * as attachments from '../services/events/attachments.js';
import { requireLeader, requireArchitect, HttpError } from '../auth/middleware.js';
import * as roles from '../auth/roles.js';
import { hashSecret } from '../auth/passwords.js';
import * as sessions from '../auth/sessions.js';
import { generateResetCode, RESET_CODE_TTL_MS } from '../util/resetcode.js';
import { mdToHtml, toPlainText } from '../util/sanitize.js';
import * as dates from '../util/dates.js';
import { flash } from '../util/flash.js';
import { getFormData, field } from '../util/body.js';
import { render } from '../render.js';
import { notFound } from './errors.js';
import * as backup from '../services/backup.js';
import * as retention from '../services/retention.js';

const router = new Hono();

// Every route below is leaders-only.
router.use('*', requireLeader);

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

/** req.body, for a form that may or may not carry files. */
const formBody = async (c) => (await getFormData(c)).fields;

/* -------------------------------------------------------------- dashboard */

const BACKUP_STALE_MS = 30 * 24 * 3600e3;

router.get('/', async (c) => {
  const db = c.env.DB;
  const [meeting, lastBackupAt, memberOptions, memberCount, leaderCount, expiringLeaderCount, announcementCount, passcode, watermark, retentionDays] =
    await Promise.all([
      meetings.nextUnified(db),
      getSetting(db, 'last_backup_at', null),
      // The next-session card's host picker needs the same active-member pool
      // the meeting form and the weekly host-assign form already use.
      users.listActive(db),
      users.countActive(db),
      users.countLeaders(db),
      users.countExpiringLeaders(db, 14),
      announcements.countUpTo(db, 100),
      getSetting(db, 'group_passcode_hash'),
      getSetting(db, 'watermark_on', '1'),
      retention.retentionDays(db),
    ]);

  const backupStale = !lastBackupAt || Date.now() - new Date(lastBackupAt).getTime() > BACKUP_STALE_MS;

  return render(c, 'admin/dashboard', {
    title: 'Admin',
    bodyClass: 'page-admin',
    pageCss: ['/css/admin.css'],
    pageJs: ['/js/map-picker.js'],
    meeting,
    memberOptions,
    memberCount,
    leaderCount,
    expiringLeaderCount,
    announcementCount,
    passcodeSet: !!passcode,
    watermarkOn: watermark === '1',
    lastBackupAt,
    backupStale,
    // views/admin/dashboard.ejs — SHARED with Express, which never sets these
    // and falls back to its own hardcoded /admin/backup.zip + "Download
    // backup" (see the typeof guard there, same pattern P4 used for
    // retryHint on views/drafts/show.ejs). This stack's backup story is a
    // page, not a direct file download — see the "backup" section below.
    backupHref: '/admin/backup',
    backupLabel: 'Backup options',
    /*
     * Three more Worker-only locals on the shared dashboard, same typeof-guard
     * arrangement as backupHref/backupLabel above and P4's retryHint: the
     * Express app keeps uploaded files forever and has no retention card at
     * all, so views/admin/dashboard.ejs renders that card only when these are
     * set. See worker/build/view-parity.mjs's dashboard variants.
     */
    retentionDays,
    retentionMin: retention.MIN_DAYS,
    retentionMax: retention.MAX_DAYS,
  });
});

/* --------------------------------------------------- watermark toggle */

router.post('/settings/watermark', async (c) => {
  const db = c.env.DB;
  const on = (await getSetting(db, 'watermark_on', '1')) === '1';
  await setSetting(db, 'watermark_on', on ? '0' : '1');
  flash(
    c,
    'info',
    on
      ? 'Watermark turned off. Reader pages no longer show the viewer’s name.'
      : 'Watermark turned on. Reader pages now show a faint tag of the viewer’s name.'
  );
  return c.redirect('/admin', 302);
});

/* --------------------------------------------------- file retention -------
 *
 * The one setting on this page that DELETES things, so it clamps rather than
 * validates-and-complains: whatever a leader types, what gets stored is a
 * number between retention.MIN_DAYS and retention.MAX_DAYS, and the flash says
 * what was actually saved. A typo'd "3" becomes 30, not "every file you have,
 * gone tonight". The policy itself — what expiry MEANS for a draft versus a
 * chat attachment — is written down in worker/src/services/retention.js.
 */

router.post('/settings/retention', async (c) => {
  const db = c.env.DB;
  const raw = field(await formBody(c), 'file_retention_days');
  const days = retention.clampDays(raw, await retention.retentionDays(db));
  await setSetting(db, 'file_retention_days', String(days));

  const asked = Math.round(Number(raw));
  const clamped = Number.isFinite(asked) && asked !== days;
  flash(
    c,
    'info',
    clamped
      ? `Shared files are now kept for ${days} days. (${asked} is outside the ${retention.MIN_DAYS}–${retention.MAX_DAYS} day range, so it was adjusted to the nearest allowed setting.)`
      : `Shared files are now kept for ${days} days, then cleaned up automatically.`
  );
  return c.redirect('/admin', 302);
});

/* --------------------------------------------------------------- meetings */

/** How many dates ahead the "give this one to a host" picker offers. */
const HOST_PICK_AHEAD = 6;

/**
 * Weekly rules decorated with what a leader needs to see: next date, skips, the
 * dates a host can be handed, and who already has one.
 *
 * Two queries per rule, run together: the skip rows and the host assignments.
 * (The Express version asked for the skips TWICE — once as dates for the set,
 * once as rows for the list — from the same table with the same WHERE. One read
 * answers both.) The occurrence arithmetic itself is pure and touches no
 * database, so a board with a dozen rules still costs a constant two round
 * trips.
 */
async function rulesForList(db) {
  const rules = await recurring.list(db);
  return Promise.all(
    rules.map(async (rule) => {
      const occurrences = dates.nextOccurrences(rule.weekday, rule.time_hhmm, 8);
      const [skips, assigned] = await Promise.all([
        recurring.skips(db, rule.id),
        hosts.forRule(db, rule.id),
      ]);
      const skipped = new Set(skips.map((s) => s.skip_date));
      const next = occurrences.find((o) => !skipped.has(o.local_date)) || null;
      const assignedByDate = new Map(assigned.map((a) => [a.local_date, a]));
      return {
        ...rule,
        next,
        // Default the skip form to the next occurrence that is still on.
        skipDefault: next ? next.local_date : occurrences.length ? occurrences[0].local_date : '',
        skips,
        // Host assignment is per-DATE, mirroring "skip a date": the same list of
        // upcoming occurrences, minus the ones already called off.
        hostDates: occurrences
          .filter((o) => !skipped.has(o.local_date))
          .slice(0, HOST_PICK_AHEAD)
          .map((o) => ({ ...o, host: assignedByDate.get(o.local_date) || null })),
        hosts: assigned,
      };
    })
  );
}

router.get('/meetings', async (c) => {
  const db = c.env.DB;
  const [upcoming, past, rules, memberOptions] = await Promise.all([
    meetings.upcoming(db),
    meetings.past(db, 10),
    rulesForList(db),
    users.listActive(db),
  ]);
  return render(c, 'admin/meetings', {
    title: 'Meetings',
    bodyClass: 'page-admin',
    upcoming,
    past,
    rules,
    memberOptions,
  });
});

/* ---- one-off meetings: R. House tables and off-site events ----------------
 *
 * One form covers both, because to a leader they are the same errand ("the
 * group is meeting here, then"). `kind` swaps the second half of the form:
 *   rhouse  → the floor map picker, as it has always been.
 *   offsite → an address, markdown details, and up to five attachments — all
 *             three MEMBERS-ONLY on the front page (see views/home.ejs and
 *             meetings.publicSafe in worker/src/models.js).
 */

const KINDS = new Set(['rhouse', 'offsite']);

/**
 * The limits multer used to enforce before the route ever ran. There is no
 * multer here, so the same two complaints are raised from the parsed parts —
 * before any file is read in full, so an oversized submit is refused rather
 * than buffered.
 */
function uploadLimitError(files) {
  if (files.length > attachments.MAX_FILES) {
    return `An event can carry up to ${attachments.MAX_FILES} attachments.`;
  }
  if (files.some((f) => f.size > attachments.MAX_BYTES)) {
    return `Attachments are limited to ${attachments.MAX_BYTES / 1024 / 1024} MB each.`;
  }
  return null;
}

const wantsJson = (c) =>
  String(c.req.header('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' ||
  String(c.req.header('accept') || '').includes('application/json');

function renderMeetingForm(c, { meeting, values, errors, files = [], memberOptions, status = 200 }) {
  return render(
    c,
    'admin/meeting-form',
    {
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
    },
    status
  );
}

/** Answer a rejected submit the way the caller asked for it. */
function meetingFormFailed(c, ctx) {
  if (wantsJson(c)) return c.json({ ok: false, errors: ctx.errors }, 400);
  return renderMeetingForm(c, { ...ctx, status: 400 });
}

const EMPTY_MEETING = {
  starts_at_local: '', title: '', notes: '', location_label: '', map_x: '', map_y: '',
  kind: 'rhouse', address: '', body_md: '', host_user_id: '', is_cancelled: 0,
};

router.get('/meetings/new', async (c) =>
  renderMeetingForm(c, {
    meeting: null,
    values: { ...EMPTY_MEETING },
    errors: [],
    memberOptions: await users.listActive(c.env.DB),
  })
);

async function readMeetingForm(db, body) {
  const kindRaw = String(field(body, 'kind') || '');
  const kind = KINDS.has(kindRaw) ? kindRaw : 'rhouse';
  const offsite = kind === 'offsite';
  const values = {
    starts_at_local: String(field(body, 'starts_at_local') || '').trim(),
    title: trim(field(body, 'title'), 120) || '',
    notes: trim(field(body, 'notes'), 2000) || '',
    location_label: offsite ? '' : trim(field(body, 'location_label'), 120) || '',
    // An off-site event has no table on the R. House floor map — clearing the
    // pin here is what makes the landing card drop the map entirely.
    map_x: offsite ? null : coord(field(body, 'map_x')),
    map_y: offsite ? null : coord(field(body, 'map_y')),
    is_cancelled: field(body, 'is_cancelled') ? 1 : 0,
    kind,
    address: offsite ? trim(field(body, 'address'), 200) || '' : '',
    body_md: offsite ? String(field(body, 'body_md') || '').trim().slice(0, 20000) : '',
    host_user_id: String(field(body, 'host_user_id') || '').trim(),
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
    const candidate = await users.byId(db, Number(values.host_user_id));
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
 *
 * NOTHING IS PUT TO R2 UNTIL EVERY FILE HAS PASSED — the whole submit is read
 * and checked first. If a put fails part-way through the ones already written
 * are removed again, so a refused submit never leaves an orphan object.
 */
async function takeAttachments(env, meetingId, files, existingCount, kind) {
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

  const checked = [];
  for (const file of list) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const verdict = attachments.validate(file, bytes);
    if (verdict.error) {
      errors.push(`“${toPlainText(file.name, 80)}” ${verdict.error}`);
      continue;
    }
    checked.push({ file, bytes, verdict });
  }
  if (errors.length) return { rows: [], errors };

  const rows = [];
  try {
    for (const item of checked) {
      rows.push(await attachments.store(env, meetingId, item.file, item.bytes, item.verdict));
    }
  } catch (err) {
    console.error('[afwc] event attachment upload failed:', err);
    for (const row of rows) await attachments.unlinkStored(env, meetingId, row.stored_name);
    return { rows: [], errors: ['The upload did not arrive intact. Please try again.'] };
  }
  return { rows, errors };
}

/** Ids the edit form ticked for removal, as numbers. */
function removalIds(body) {
  const raw = body.remove_attachment;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

router.post('/meetings', async (c) => {
  const db = c.env.DB;
  const { fields, files } = await getFormData(c);
  const incoming = files.attachments || [];

  const memberOptions = await users.listActive(db);
  const { values, starts_at, host_user_id, body_html, errors } = await readMeetingForm(db, fields);
  const uploadError = uploadLimitError(incoming);
  if (uploadError) errors.unshift(uploadError);
  if (errors.length) {
    return meetingFormFailed(c, { meeting: null, values, errors, memberOptions });
  }

  const meta = await meetings.create(db, {
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
    created_by: c.get('currentUser').id,
  });
  const id = Number(meta.last_row_id);

  const stored = await takeAttachments(c.env, id, incoming, 0, values.kind);
  if (stored.errors.length) {
    // The meeting exists and is correct; only the files were refused. Say so
    // rather than throwing away everything the leader typed.
    for (const row of stored.rows) await attachments.unlinkStored(c.env, id, row.stored_name);
    flash(c, 'error', `Meeting saved, but the attachments were not: ${stored.errors.join(' ')}`);
    const location = `/admin/meetings/${id}/edit`;
    if (wantsJson(c)) return c.json({ ok: true, id, redirect: location }, 201);
    return c.redirect(location, 302);
  }
  for (const row of stored.rows) await eventFiles.create(db, row);

  flash(c, 'ok', 'Meeting saved. The landing page is updated.');
  if (wantsJson(c)) return c.json({ ok: true, id, redirect: '/admin/meetings' }, 201);
  return c.redirect('/admin/meetings', 302);
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

router.get('/meetings/:id/edit', async (c) => {
  const db = c.env.DB;
  const meeting = await meetings.byId(db, c.req.param('id'));
  if (!meeting) return notFound(c);
  const [files, memberOptions] = await Promise.all([
    eventFiles.forMeeting(db, meeting.id),
    users.listActive(db),
  ]);
  return renderMeetingForm(c, {
    meeting,
    values: meetingValues(meeting),
    errors: [],
    files,
    memberOptions,
  });
});

router.post('/meetings/:id', async (c) => {
  const db = c.env.DB;
  const meeting = await meetings.byId(db, c.req.param('id'));
  if (!meeting) return notFound(c);

  const { fields, files } = await getFormData(c);
  const incoming = files.attachments || [];

  const [memberOptions, existing] = await Promise.all([
    users.listActive(db),
    eventFiles.forMeeting(db, meeting.id),
  ]);
  const { values, starts_at, host_user_id, body_html, errors } = await readMeetingForm(db, fields);
  const uploadError = uploadLimitError(incoming);
  if (uploadError) errors.unshift(uploadError);
  if (errors.length) {
    return meetingFormFailed(c, { meeting, values, errors, files: existing, memberOptions });
  }

  const removing = new Set(removalIds(fields));
  const keeping = existing.filter((f) => !removing.has(f.id));
  const stored = await takeAttachments(c.env, meeting.id, incoming, keeping.length, values.kind);
  if (stored.errors.length) {
    for (const row of stored.rows) await attachments.unlinkStored(c.env, meeting.id, row.stored_name);
    return meetingFormFailed(c, {
      meeting,
      values,
      errors: stored.errors,
      files: existing,
      memberOptions,
    });
  }

  await meetings.update(db, {
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
    await eventFiles.remove(db, file.id, meeting.id);
    await attachments.unlinkStored(c.env, meeting.id, file.stored_name);
  }
  for (const row of stored.rows) await eventFiles.create(db, row);

  flash(c, 'ok', 'Meeting updated.');
  // The dashboard's next-session card reuses this route for its host/pin form
  // and wants to land back on /admin rather than the meetings list.
  const back = safeReturnTo(field(fields, 'return_to'), '/admin/meetings');
  if (wantsJson(c)) return c.json({ ok: true, id: meeting.id, redirect: back });
  return c.redirect(back, 302);
});

router.post('/meetings/:id/cancel', async (c) => {
  const db = c.env.DB;
  const meeting = await meetings.byId(db, c.req.param('id'));
  if (!meeting) return notFound(c);
  const cancel = meeting.is_cancelled ? 0 : 1;
  await meetings.setCancelled(db, meeting.id, cancel);
  flash(c, 'info', cancel ? 'Meeting marked cancelled.' : 'Meeting is back on.');
  return c.redirect('/admin/meetings', 302);
});

router.post('/meetings/:id/delete', async (c) => {
  const db = c.env.DB;
  const meeting = await meetings.byId(db, c.req.param('id'));
  if (!meeting) return notFound(c);
  await meetings.softDelete(db, meeting.id, c.get('currentUser').id);
  flash(c, 'info', 'Meeting removed.');
  return c.redirect('/admin/meetings', 302);
});

/* ------------------------------------------------- recurring weekly rules */

/* The rule form lives on its own page rather than inline on /admin/meetings:
   it carries the same interactive floor map as the one-off meeting form, and
   map-picker.js binds to a single #floormap-svg / #map_x / #map_y set. */

const EMPTY_RULE = {
  weekday: 6, time_hhmm: '13:00', title: '', location_label: '', notes: '',
  map_x: '', map_y: '', is_active: 1,
};

function renderRuleForm(c, { rule, values, errors, status = 200 }) {
  return render(
    c,
    'admin/recurring-form',
    {
      title: rule ? 'Edit weekly meeting' : 'New weekly meeting',
      bodyClass: 'page-admin',
      pageJs: ['/js/map-picker.js'],
      rule,
      values,
      weekdays: dates.weekdayNames(),
      errors,
    },
    status
  );
}

function readRuleForm(body) {
  const weekdayRaw = Number(field(body, 'weekday'));
  const values = {
    weekday: Number.isInteger(weekdayRaw) && weekdayRaw >= 0 && weekdayRaw <= 6 ? weekdayRaw : '',
    time_hhmm: dates.normalizeHhmm(field(body, 'time_hhmm')) || '',
    title: trim(field(body, 'title'), 120) || '',
    location_label: trim(field(body, 'location_label'), 120) || '',
    notes: trim(field(body, 'notes'), 2000) || '',
    map_x: coord(field(body, 'map_x')),
    map_y: coord(field(body, 'map_y')),
    is_active: field(body, 'is_active') ? 1 : 0,
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

router.get('/recurring/new', (c) => renderRuleForm(c, { rule: null, values: { ...EMPTY_RULE }, errors: [] }));

router.post('/recurring', async (c) => {
  const { values, errors } = readRuleForm(await formBody(c));
  if (errors.length) return renderRuleForm(c, { rule: null, values, errors, status: 400 });
  await recurring.create(c.env.DB, {
    weekday: values.weekday,
    time_hhmm: values.time_hhmm,
    title: values.title,
    location_label: values.location_label || null,
    notes: values.notes || null,
    map_x: values.map_x,
    map_y: values.map_y,
    is_active: values.is_active,
    created_by: c.get('currentUser').id,
  });
  flash(c, 'ok', `Weekly meeting saved — every ${dates.weekdayName(values.weekday)}, no re-entry needed.`);
  return c.redirect('/admin/meetings#weekly', 302);
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

router.get('/recurring/:id/edit', async (c) => {
  const rule = await recurring.byId(c.env.DB, c.req.param('id'));
  if (!rule) return notFound(c);
  return renderRuleForm(c, { rule, values: ruleValues(rule), errors: [] });
});

// Bare /admin/recurring/:id is the same page, one redirect away.
router.get('/recurring/:id', (c) =>
  c.redirect(`/admin/recurring/${encodeURIComponent(c.req.param('id'))}/edit`, 302)
);

router.post('/recurring/:id', async (c) => {
  const db = c.env.DB;
  const rule = await recurring.byId(db, c.req.param('id'));
  if (!rule) return notFound(c);
  const { values, errors } = readRuleForm(await formBody(c));
  if (errors.length) return renderRuleForm(c, { rule, values, errors, status: 400 });
  await recurring.update(db, {
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
  flash(c, 'ok', 'Weekly meeting updated.');
  return c.redirect('/admin/meetings#weekly', 302);
});

router.post('/recurring/:id/toggle', async (c) => {
  const db = c.env.DB;
  const rule = await recurring.byId(db, c.req.param('id'));
  if (!rule) return notFound(c);
  const activate = rule.is_active ? 0 : 1;
  await recurring.setActive(db, rule.id, activate);
  flash(
    c,
    'info',
    activate
      ? `“${rule.title}” is back on the front page every ${dates.weekdayName(rule.weekday)}.`
      : `“${rule.title}” is paused — it no longer appears on the front page.`
  );
  return c.redirect('/admin/meetings#weekly', 302);
});

router.post('/recurring/:id/delete', async (c) => {
  const db = c.env.DB;
  const rule = await recurring.byId(db, c.req.param('id'));
  if (!rule) return notFound(c);
  await recurring.remove(db, rule.id);
  flash(c, 'info', `“${rule.title}” was removed from the weekly schedule.`);
  return c.redirect('/admin/meetings#weekly', 302);
});

/* Skipping one week: a date, not a cancellation. The rule keeps running. */

router.post('/recurring/skips/:skipId/delete', async (c) => {
  await recurring.removeSkip(c.env.DB, c.req.param('skipId'));
  flash(c, 'info', 'That week is back on.');
  return c.redirect('/admin/meetings#weekly', 302);
});

router.post('/recurring/:id/skip', async (c) => {
  const db = c.env.DB;
  const rule = await recurring.byId(db, c.req.param('id'));
  if (!rule) return notFound(c);
  const body = await formBody(c);
  const raw = String(field(body, 'skip_date') || '').trim();
  const skipDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  if (!skipDate) {
    flash(c, 'error', 'Pick the date of the week you want to skip.');
    return c.redirect('/admin/meetings#weekly', 302);
  }
  if (dates.localDayOfWeek(skipDate) !== rule.weekday) {
    flash(
      c,
      'error',
      `${skipDate} is not a ${dates.weekdayName(rule.weekday)} — pick the date of the ${dates.weekdayName(rule.weekday)} you want to skip.`
    );
    return c.redirect('/admin/meetings#weekly', 302);
  }
  await recurring.addSkip(db, rule.id, skipDate, c.get('currentUser').id);
  flash(c, 'ok', `No meeting on ${dates.formatDate(`${skipDate}T12:00:00Z`)} — the front page skips straight to the next one.`);
  return c.redirect('/admin/meetings#weekly', 302);
});

/* Handing one session to a host. Per DATE, exactly like skipping a week — a
   host runs one Saturday, not "Saturdays". */

router.post('/recurring/:id/host', async (c) => {
  const db = c.env.DB;
  const rule = await recurring.byId(db, c.req.param('id'));
  if (!rule) return notFound(c);

  const body = await formBody(c);
  const back = safeReturnTo(field(body, 'return_to'), '/admin/meetings#weekly');

  const rawDate = String(field(body, 'local_date') || '').trim();
  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  if (!localDate || dates.localDayOfWeek(localDate) !== rule.weekday) {
    flash(c, 'error', `Pick the date of the ${dates.weekdayName(rule.weekday)} you want to hand over.`);
    return c.redirect(back, 302);
  }

  const raw = String(field(body, 'user_id') || '').trim();
  if (!raw || raw === 'none') {
    /* Unassigning also clears that date's overrides — see the note on
       hosts.unassign in worker/src/models.js, where the two deletes go down as
       one db.batch so an occurrence can never keep a pin whose host is gone. */
    const previous = await hosts.forOccurrence(db, rule.id, localDate);
    await hosts.unassign(db, rule.id, localDate);
    flash(
      c,
      'info',
      previous
        ? `${previous.display_name} is no longer hosting ${dates.formatDate(`${localDate}T12:00:00Z`)}. Any changes they made to that session are undone.`
        : 'Nobody was hosting that date.'
    );
    return c.redirect(back, 302);
  }

  const target = await users.byId(db, Number(raw));
  if (!target || !target.is_active) {
    flash(c, 'error', 'Pick an active member to host that session.');
    return c.redirect(back, 302);
  }

  await hosts.assign(db, rule.id, localDate, target.id, c.get('currentUser').id);
  flash(
    c,
    'ok',
    `${target.display_name} is hosting ${dates.formatDate(`${localDate}T12:00:00Z`)}. ` +
      'They can set the time, the table, the pin and a note for that one session at /host.'
  );
  return c.redirect(back, 302);
});

/* ---------------------------------------------------------- announcements */

const announcementsPage = (c, { list, values, errors, status = 200 }) =>
  render(
    c,
    'admin/announcements',
    {
      title: 'Announcements',
      bodyClass: 'page-admin',
      announcements: list,
      values,
      errors,
    },
    status
  );

router.get('/announcements', async (c) =>
  announcementsPage(c, {
    list: await announcements.list(c.env.DB, 100),
    values: { title: '', body_md: '' },
    errors: [],
  })
);

router.post('/announcements', async (c) => {
  const db = c.env.DB;
  const body = await formBody(c);
  const title = trim(field(body, 'title'), 140);
  const body_md = String(field(body, 'body_md') || '').trim();
  const errors = [];
  if (!title) errors.push('Give the announcement a title.');
  if (!body_md) errors.push('Write something in the body.');
  if (body_md.length > 20000) errors.push('That announcement is too long.');

  if (errors.length) {
    return announcementsPage(c, {
      list: await announcements.list(db, 100),
      values: { title: title || '', body_md },
      errors,
      status: 400,
    });
  }

  const body_html = mdToHtml(body_md);
  if (!toPlainText(body_html)) {
    return announcementsPage(c, {
      list: await announcements.list(db, 100),
      values: { title, body_md },
      errors: ['Nothing survived the formatting filter — try plain text or simple markdown.'],
      status: 400,
    });
  }

  await announcements.create(db, {
    title,
    body_html,
    body_md,
    is_pinned: field(body, 'is_pinned') ? 1 : 0,
    author_id: c.get('currentUser').id,
  });
  flash(c, 'ok', 'Announcement posted.');
  return c.redirect('/admin/announcements', 302);
});

router.post('/announcements/:id/pin', async (c) => {
  const db = c.env.DB;
  const a = await announcements.byId(db, c.req.param('id'));
  if (!a) return notFound(c);
  await announcements.setPinned(db, a.id, a.is_pinned ? 0 : 1);
  flash(c, 'info', a.is_pinned ? 'Unpinned.' : 'Pinned to the top.');
  return c.redirect('/admin/announcements', 302);
});

router.post('/announcements/:id/delete', async (c) => {
  const db = c.env.DB;
  const a = await announcements.byId(db, c.req.param('id'));
  if (!a) return notFound(c);
  await announcements.softDelete(db, a.id, c.get('currentUser').id);
  flash(c, 'info', 'Announcement removed.');
  return c.redirect('/admin/announcements', 302);
});

/* --------------------------------------------------------------- about */

/*
 * The front page's "The Collective" intro — one markdown blob, stored in the
 * settings table (worker/src/models.js's `about` helper, seeded on first read).
 * Same shape as announcements: a form, a length cap, and a check that something
 * survived the sanitizer. A read-only preview underneath shows the leader what
 * the front page will actually render.
 */

const ABOUT_MAX_CHARS = 6000;

router.get('/about', async (c) => {
  const body_md = await about.getMd(c.env.DB);
  return render(c, 'admin/about', {
    title: 'About the group',
    bodyClass: 'page-admin',
    values: { body_md },
    previewHtml: mdToHtml(body_md),
    errors: [],
  });
});

router.post('/about', async (c) => {
  const body = await formBody(c);
  const body_md = String(field(body, 'body_md') || '').trim();
  const errors = [];
  if (!body_md) errors.push('The about text can’t be empty — write something for new visitors to read.');
  if (body_md.length > ABOUT_MAX_CHARS) errors.push(`That's too long — keep it under ${ABOUT_MAX_CHARS} characters.`);

  const body_html = body_md ? mdToHtml(body_md) : '';
  if (!errors.length && !toPlainText(body_html)) {
    errors.push('Nothing survived the formatting filter — try plain text or simple markdown.');
  }

  if (errors.length) {
    return render(
      c,
      'admin/about',
      {
        title: 'About the group',
        bodyClass: 'page-admin',
        values: { body_md },
        previewHtml: body_html,
        errors,
      },
      400
    );
  }

  await about.setMd(c.env.DB, body_md);
  flash(c, 'ok', 'About text updated. The front page reflects it now.');
  return c.redirect('/admin/about', 302);
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
  const sortRaw = Number(field(body, 'sort_order'));
  const values = {
    text: trim(field(body, 'text'), QUOTE_TEXT_MAX) || '',
    attribution: trim(field(body, 'attribution'), 140) || '',
    source_note: trim(field(body, 'source_note'), 140) || '',
    sort_order: Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : 0,
  };
  const errors = [];
  if (!values.text) errors.push('Write the quote itself — keep it to a line or two.');
  if (!values.attribution) errors.push('Who said it? Attribution is required.');
  return { values, errors };
}

const quotesPage = (c, { list, values, errors, status = 200 }) =>
  render(
    c,
    'admin/quotes',
    {
      title: 'Quote rail',
      bodyClass: 'page-admin',
      quotes: list,
      values,
      errors,
    },
    status
  );

router.get('/quotes', async (c) =>
  quotesPage(c, {
    list: await quotes.list(c.env.DB),
    values: { text: '', attribution: '', source_note: '', sort_order: 0 },
    errors: [],
  })
);

router.post('/quotes', async (c) => {
  const db = c.env.DB;
  const { values, errors } = readQuoteForm(await formBody(c));
  if (errors.length) {
    return quotesPage(c, { list: await quotes.list(db), values, errors, status: 400 });
  }
  await quotes.create(db, {
    text: values.text,
    attribution: values.attribution,
    source_note: values.source_note || null,
    is_active: 1,
    sort_order: values.sort_order,
    created_by: c.get('currentUser').id,
  });
  flash(c, 'ok', 'Quote added. It joins the daily rotation on the front page.');
  return c.redirect('/admin/quotes', 302);
});

router.post('/quotes/:id', async (c) => {
  const db = c.env.DB;
  const quote = await quotes.byId(db, c.req.param('id'));
  if (!quote) return notFound(c);
  const { values, errors } = readQuoteForm(await formBody(c));
  if (errors.length) {
    return quotesPage(c, { list: await quotes.list(db), values, errors, status: 400 });
  }
  await quotes.update(db, {
    id: quote.id,
    text: values.text,
    attribution: values.attribution,
    source_note: values.source_note || null,
    sort_order: values.sort_order,
  });
  flash(c, 'ok', 'Quote updated.');
  return c.redirect('/admin/quotes', 302);
});

router.post('/quotes/:id/toggle', async (c) => {
  const db = c.env.DB;
  const quote = await quotes.byId(db, c.req.param('id'));
  if (!quote) return notFound(c);
  const activate = quote.is_active ? 0 : 1;
  await quotes.setActive(db, quote.id, activate);
  flash(c, 'info', activate ? 'Quote reactivated — back in the rotation.' : 'Quote deactivated — no longer shown.');
  return c.redirect('/admin/quotes', 302);
});

router.post('/quotes/:id/delete', async (c) => {
  const db = c.env.DB;
  const quote = await quotes.byId(db, c.req.param('id'));
  if (!quote) return notFound(c);
  await quotes.remove(db, quote.id);
  flash(c, 'info', 'Quote removed.');
  return c.redirect('/admin/quotes', 302);
});

/* --------------------------------------------------------------- passcode */

router.get('/passcode', async (c) =>
  render(c, 'admin/passcode', {
    title: 'Group passcode',
    bodyClass: 'page-admin',
    passcodeSet: !!(await getSetting(c.env.DB, 'group_passcode_hash')),
    updatedAt: null,
    errors: [],
  })
);

router.post('/passcode', async (c) => {
  const db = c.env.DB;
  const body = await formBody(c);
  const passcode = String(field(body, 'passcode') || '').trim();
  const passcode2 = String(field(body, 'passcode2') || '').trim();
  const errors = [];
  if (passcode.length < 4) errors.push('The passcode must be at least 4 characters.');
  if (passcode !== passcode2) errors.push('The two passcodes do not match.');

  if (errors.length) {
    return render(
      c,
      'admin/passcode',
      {
        title: 'Group passcode',
        bodyClass: 'page-admin',
        passcodeSet: !!(await getSetting(db, 'group_passcode_hash')),
        updatedAt: null,
        errors,
      },
      400
    );
  }
  await setSetting(db, 'group_passcode_hash', await hashSecret(passcode));
  flash(c, 'ok', 'Group passcode changed. Share the new one at the next meeting.');
  return c.redirect('/admin', 302);
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

/**
 * Loads the target of a /members/:id action and applies denyReason. Returns the
 * user row, null when there is no such account (the caller 404s), and throws
 * the shared 403 when the actor may not touch them.
 */
async function targetFor(c) {
  const target = await users.byId(c.env.DB, c.req.param('id'));
  if (!target) return null;
  const reason = denyReason(c.get('currentUser'), target);
  if (reason) throw new HttpError(403, reason);
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
  const term = String(field(body, 'term') || 'permanent').trim();
  if (term === 'permanent') return { expiresAt: null };
  if (term === '1w') return { expiresAt: new Date(Date.now() + 7 * 24 * 3600e3).toISOString() };
  if (term === '1m') {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 1);
    return { expiresAt: d.toISOString() };
  }
  if (term === 'until') {
    const raw = String(field(body, 'until_date') || '').trim();
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

router.get('/members', async (c) => {
  const db = c.env.DB;
  const actor = c.get('currentUser');
  const [people, leaderCount] = await Promise.all([users.list(db), users.countLeaders(db)]);
  return render(c, 'admin/members', {
    title: 'Members',
    bodyClass: 'page-admin',
    pageJs: ['/js/members.js'],
    people,
    leaderCount,
    termOptions: TERM_OPTIONS,
    todayLocal: dates.localDateKey(new Date()),
    // Only the architect sees (or can use) the hand-over form.
    transferCandidates: roles.isArchitectUser(actor)
      ? people.filter((p) => p.is_active && p.id !== actor.id)
      : [],
  });
});

/**
 * Hand the board over. The architect picks an active account, types TRANSFER,
 * and swaps chairs: the target becomes architect, the outgoing architect
 * becomes a permanent leader. Both terms are cleared, and nobody is signed out
 * — a change of role is not a boot.
 *
 * Registered BEFORE the /members/:id routes so "transfer" is never read as an
 * id, and guarded by requireArchitect on top of the router-wide requireLeader.
 */
const CONFIRM_WORD = 'TRANSFER';

router.post('/members/transfer', requireArchitect, async (c) => {
  const db = c.env.DB;
  const actor = c.get('currentUser');
  const body = await formBody(c);
  const target = await users.byId(db, Number(field(body, 'user_id')));
  const confirm = String(field(body, 'confirm') || '').trim();

  if (!target || !target.is_active) {
    flash(c, 'error', 'Pick an active member or leader to hand the architect role to.');
    return c.redirect('/admin/members#transfer', 302);
  }
  if (target.id === actor.id) {
    flash(c, 'error', 'You already hold the architect role.');
    return c.redirect('/admin/members#transfer', 302);
  }
  if (confirm !== CONFIRM_WORD) {
    flash(c, 'error', `Nothing changed — type ${CONFIRM_WORD} exactly (capitals) to confirm the hand-over.`);
    return c.redirect('/admin/members#transfer', 302);
  }

  /* Was a better-sqlite3 transaction. The two rows MUST move together: a board
     with two architects, or with none, is the one state this screen exists to
     make impossible — so they go down as a single D1 batch. */
  await db.batch([
    stmt(db, 'UPDATE users SET role = ?, role_expires_at = NULL WHERE id = ?', roles.ARCHITECT, target.id),
    stmt(db, 'UPDATE users SET role = ?, role_expires_at = NULL WHERE id = ?', roles.LEADER, actor.id),
  ]);

  flash(
    c,
    'ok',
    `${target.display_name} (@${target.username}) is now the architect of this board. ` +
      'You are a permanent leader — everyone stays signed in, but only they can manage leaders from here on.'
  );
  return c.redirect('/admin/members', 302);
});

router.post('/members/:id/deactivate', async (c) => {
  const db = c.env.DB;
  const target = await targetFor(c);
  if (!target) return notFound(c);
  await users.setActive(db, target.id, 0);
  await sessions.destroyAllForUser(db, target.id);
  flash(c, 'ok', `${target.display_name} was deactivated and signed out everywhere.`);
  return c.redirect('/admin/members', 302);
});

router.post('/members/:id/reactivate', async (c) => {
  const target = await targetFor(c);
  if (!target) return notFound(c);
  await users.setActive(c.env.DB, target.id, 1);
  flash(c, 'ok', `${target.display_name} can sign in again.`);
  return c.redirect('/admin/members', 302);
});

/**
 * Promote to leader, permanently or for a fixed term. Leaders may do this to
 * members; changing an existing leader's term is leader management, so
 * denyReason sends it to the architect (shortening a term is a demotion in
 * slow motion). Nothing here can ever mint an architect — only /transfer can.
 */
router.post('/members/:id/promote', async (c) => {
  const target = await targetFor(c);
  if (!target) return notFound(c);

  const { expiresAt, error } = readTerm(await formBody(c));
  if (error) {
    flash(c, 'error', error);
    return c.redirect('/admin/members', 302);
  }

  await users.setRole(c.env.DB, target.id, roles.LEADER, expiresAt);
  flash(c, 'ok', `${target.display_name} is now a leader — ${termPhrase(expiresAt)}.`);
  return c.redirect('/admin/members', 302);
});

router.post('/members/:id/demote', async (c) => {
  const target = await targetFor(c);
  if (!target) return notFound(c);
  await users.setRole(c.env.DB, target.id, roles.MEMBER);
  flash(c, 'ok', `${target.display_name} is a member again. They stay signed in; the admin console is gone.`);
  return c.redirect('/admin/members', 302);
});

router.post('/members/:id/reset-code', async (c) => {
  const target = await targetFor(c);
  if (!target) return notFound(c);
  const code = generateResetCode();
  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();
  await users.setResetCode(c.env.DB, target.id, await sessions.sha256(code), expiresAt);
  flash(
    c,
    'ok',
    `Reset code for ${target.display_name} (${target.username}): ${code} — expires in 48 hours. ` +
      `Text this to them now; it will not be shown again. They enter it at /reset.`
  );
  return c.redirect('/admin/members', 302);
});

/* ---------------------------------------------------------------- backup
 *
 * On Node, GET /admin/backup.zip streamed a zip straight from streamBackup()
 * (src/services/backup.js): a filesystem snapshot of the SQLite file plus the
 * uploads/ tree. Workers has neither a filesystem nor a synchronous database
 * snapshot, and building a zip is exactly the kind of CPU work
 * PORT-CLOUDFLARE.md §6 moved off this stack for ingest — so the export here
 * is a from-scratch SQL dump (worker/src/services/backup.js), and "click a
 * link, get a file" becomes "open a page, then choose."
 *
 * /admin/backup.zip ITSELF STILL EXISTS, forwarding to the real page — the
 * shared dashboard view has pointed at that exact URL since before this stack
 * existed (views/admin/help.ejs's handbook remembers it too), and a stale
 * bookmark or a leader's muscle memory should land somewhere useful rather
 * than 404. The dashboard card's own link is the guarded `backupHref` local
 * near the top of this file, which points straight at /admin/backup.
 *
 * WHAT CHANGED WITH THE FILE STORE. There is no R2 bucket any more, so there
 * is no automatic second copy and no fallback to one. Two consequences here:
 *
 *   1. THE DUMP CAN FINALLY BE COMPLETE. The files are rows now, so a database
 *      backup can contain the draft originals, the page images and the
 *      attachments — which the R2-era dump never could. Whether it does depends
 *      on how much there is: hex-encoding blobs costs ~5.7 ms/MB against a
 *      ~10 ms request budget, so a small store goes in the main file and a
 *      larger one is downloaded as numbered PARTS. The page tells the leader
 *      which of those two worlds they are in, in words. See the CPU BUDGET
 *      section of worker/src/services/backup.js for the measurement.
 *   2. THE OLD "too slow → serve last month's snapshot" FALLBACK IS GONE,
 *      because there is nothing to fall back to. Its job is done instead by the
 *      pagination above, which is a better answer anyway: a leader gets THIS
 *      board, today, in pieces, rather than a stale copy of it whole.
 *
 * lastBackupAt vs lastSnapshotAt — the split P5 drew, with one honest
 * relabelling:
 *   - last_backup_at is a LEADER'S action (GET /admin/backup/download.sql) and
 *     is what the dashboard's 30-day nag reads, unchanged from Express.
 *   - last_snapshot_at is the monthly cron's record. It no longer means "a copy
 *     was made" — nothing copies anything now — it means "the automatic check
 *     ran and the numbers on this page are that fresh". The page says so.
 */

router.get('/backup.zip', (c) => c.redirect('/admin/backup', 301));

router.get('/backup', async (c) => {
  const db = c.env.DB;
  const [lastBackupAt, lastSnapshotAt, lastSnapshotMonth, files] = await Promise.all([
    getSetting(db, 'last_backup_at', null),
    getSetting(db, 'last_snapshot_at', null),
    getSetting(db, 'last_snapshot_month', null),
    backup.fileStoreSummary(db),
  ]);
  const backupStale = !lastBackupAt || Date.now() - new Date(lastBackupAt).getTime() > BACKUP_STALE_MS;
  const parts = files.fitsInline ? [] : await backup.planFileParts(db);
  const retentionDays = await retention.retentionDays(db);

  return render(c, 'admin/backup', {
    title: 'Backups',
    bodyClass: 'page-admin',
    pageCss: ['/css/admin.css'],
    lastBackupAt,
    backupStale,
    lastSnapshotAt,
    lastSnapshotMonth,
    fileCount: files.files,
    fileBytes: files.bytes,
    filesInline: files.fitsInline,
    fileParts: parts,
    retentionDays,
  });
});

/**
 * The CPU budget this route reports against. The synchronous cost of a dump is
 * dumpTable's stringify loop plus, when the file store is small enough to
 * inline, the hex encoder — see worker/src/services/backup.js's CPU BUDGET
 * section for both measurements. 8 ms leaves headroom under the ~10 ms/request
 * ceiling the free plan gives every other route in this app for the rest of
 * what a request does (session lookup, rendering).
 *
 * Nothing is REFUSED for exceeding it: the decision that keeps a dump cheap is
 * made before it is built (inline vs. parts), not after. What this constant
 * does is put a loud line in the logs if a real board ever measures past it, so
 * the constants above it can be retuned against evidence rather than a guess.
 */
const BACKUP_CPU_BUDGET_MS = 8;

router.get('/backup/download.sql', async (c) => {
  const db = c.env.DB;
  const files = await backup.fileStoreSummary(db);
  const snapshot = await backup.buildSnapshot(db, { includeFileBlobs: files.fitsInline });
  const extra = files.fitsInline || !files.files
    ? ''
    : await backup.fileManifestComment(db, await backup.planFileParts(db));
  const stamp = new Date().toISOString().slice(0, 10);
  const body = backup.combineSnapshot(snapshot, extra);

  await setSetting(db, 'last_backup_at', new Date().toISOString());
  const source = files.fitsInline ? 'live-with-files' : 'live-metadata-only';
  console.log(
    `[afwc] leader backup download (${source}): ${snapshot.tables.length} table(s), ` +
      `${files.files} stored file(s)/${files.bytes} bytes, cpu~${snapshot.cpuMs.toFixed(2)}ms` +
      (snapshot.cpuMs > BACKUP_CPU_BUDGET_MS ? ` — OVER the ${BACKUP_CPU_BUDGET_MS}ms budget` : '')
  );

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/sql; charset=utf-8',
      'Content-Disposition': `attachment; filename="afwc-backup-${stamp}.sql"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Backup-Source': source,
      'X-Backup-Cpu-Ms': snapshot.cpuMs.toFixed(2),
    },
  });
});

/**
 * One part of the file bytes, for a store too large to inline. The part number
 * is an index into the plan the backup page computed and rendered; an unknown
 * one is a 404 rather than an empty file, because a leader following the page's
 * links can only ever ask for one that exists, and anything else is a typo that
 * should say so.
 */
router.get('/backup/files.sql', async (c) => {
  const db = c.env.DB;
  const wanted = Number(c.req.query('part'));
  const parts = await backup.planFileParts(db);
  const plan = parts.find((p) => p.part === wanted);
  if (!plan) return notFound(c);

  const { text, cpuMs, rows } = await backup.dumpFilePart(db, plan);
  console.log(
    `[afwc] leader backup file part ${plan.part}/${parts.length}: ${rows} chunk row(s), ` +
      `${plan.bytes} bytes, cpu~${cpuMs.toFixed(2)}ms` +
      (cpuMs > BACKUP_CPU_BUDGET_MS ? ` — OVER the ${BACKUP_CPU_BUDGET_MS}ms budget` : '')
  );

  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/sql; charset=utf-8',
      'Content-Disposition': `attachment; filename="afwc-backup-files-${plan.part}-of-${parts.length}.sql"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Backup-Source': `files-part-${plan.part}`,
      'X-Backup-Cpu-Ms': cpuMs.toFixed(2),
    },
  });
});

/* ------------------------------------------------------------------ help */

router.get('/help', async (c) =>
  render(c, 'admin/help', {
    title: 'Leader handbook',
    bodyClass: 'page-admin',
    pageCss: ['/css/admin.css'],
    // Worker-only local; see the guard in views/admin/help.ejs's Backups
    // section. Express keeps files forever and zips a disk, and its half of
    // that section is what renders when this is absent.
    retentionDays: await retention.retentionDays(c.env.DB),
  })
);

export default router;
