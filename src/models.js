'use strict';

/**
 * Small query helpers shared by more than one router. Anything used by a single
 * router lives next to that router instead. All statements are prepared through
 * better-sqlite3; there is no ORM and there never will be.
 */

const { db } = require('./db');
const dates = require('./util/dates');

/* ---------------- users ---------------- */

const users = {
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  countActive: () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get().n,
  countLeaders: () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'leader' AND is_active = 1").get().n,
  byUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()),
  byId: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  create: ({ username, display_name, email, password_hash, role }) =>
    db
      .prepare(
        `INSERT INTO users (username, display_name, email, password_hash, role)
         VALUES (@username, @display_name, @email, @password_hash, @role)`
      )
      .run({
        username: String(username).trim(),
        display_name: String(display_name).trim(),
        email: email ? String(email).trim() : null,
        password_hash,
        role: role === 'leader' ? 'leader' : 'member',
      }),
  touchLogin: (id) =>
    db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id),

  /** Everyone, for the leader-only /admin/members table. Leaders first, then A–Z. */
  list: () =>
    db
      .prepare(
        `SELECT id, username, display_name, role, is_active, created_at, last_login_at
           FROM users
          ORDER BY role = 'leader' DESC, is_active DESC, display_name COLLATE NOCASE`
      )
      .all(),
  setActive: (id, active) => db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id),
  setRole: (id, role) =>
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role === 'leader' ? 'leader' : 'member', id),
  setPasswordHash: (id, password_hash) =>
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id),
  setResetCode: (id, reset_code_hash, reset_expires_at) =>
    db
      .prepare('UPDATE users SET reset_code_hash = ?, reset_expires_at = ? WHERE id = ?')
      .run(reset_code_hash, reset_expires_at, id),
  clearResetCode: (id) =>
    db.prepare('UPDATE users SET reset_code_hash = NULL, reset_expires_at = NULL WHERE id = ?').run(id),
};

/* ---------------- meetings ---------------- */

const MEETING_COLS = `id, starts_at, title, notes, location_label, map_x, map_y, is_cancelled`;

const meetings = {
  /** The one the landing page shows: soonest future, not cancelled, not deleted. */
  next: () =>
    db
      .prepare(
        `SELECT ${MEETING_COLS} FROM meetings
          WHERE deleted_at IS NULL AND is_cancelled = 0 AND starts_at >= ?
          ORDER BY starts_at ASC LIMIT 1`
      )
      .get(new Date().toISOString()),

  /**
   * What the landing page actually shows: the soonest of (a) the next one-off
   * meeting and (b) each active weekly rule's next unskipped occurrence.
   *
   * Always returns a meetings-row shape — plus `is_recurring`, `recurring_id`
   * and `local_date` — so home.ejs reads one object either way.
   */
  nextUnified: (from = new Date()) => {
    const candidates = [];

    const oneOff = meetings.next();
    if (oneOff) {
      candidates.push({
        ...oneOff,
        is_recurring: false,
        recurring_id: null,
        local_date: dates.localDateKey(oneOff.starts_at),
      });
    }

    for (const rule of recurring.listActive()) {
      const occ = recurring.nextOccurrence(rule, from);
      if (occ) candidates.push(recurring.asMeeting(rule, occ));
    }

    candidates.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    return candidates[0] || null;
  },

  upcoming: (limit = 50) =>
    db
      .prepare(
        `SELECT ${MEETING_COLS} FROM meetings
          WHERE deleted_at IS NULL AND starts_at >= ?
          ORDER BY starts_at ASC LIMIT ?`
      )
      .all(new Date().toISOString(), limit),
  past: (limit = 20) =>
    db
      .prepare(
        `SELECT ${MEETING_COLS} FROM meetings
          WHERE deleted_at IS NULL AND starts_at < ?
          ORDER BY starts_at DESC LIMIT ?`
      )
      .all(new Date().toISOString(), limit),
  byId: (id) => db.prepare(`SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL`).get(id),
  create: (m) =>
    db
      .prepare(
        `INSERT INTO meetings (starts_at, title, notes, location_label, map_x, map_y, is_cancelled, created_by)
         VALUES (@starts_at, @title, @notes, @location_label, @map_x, @map_y, @is_cancelled, @created_by)`
      )
      .run(m),
  update: (m) =>
    db
      .prepare(
        `UPDATE meetings SET starts_at = @starts_at, title = @title, notes = @notes,
                location_label = @location_label, map_x = @map_x, map_y = @map_y,
                is_cancelled = @is_cancelled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @id`
      )
      .run(m),
  setCancelled: (id, cancelled) =>
    db
      .prepare(
        `UPDATE meetings SET is_cancelled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      )
      .run(cancelled ? 1 : 0, id),
  softDelete: (id, byUserId) =>
    db
      .prepare(
        `UPDATE meetings SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`
      )
      .run(byUserId, id),
};

/* ---------------- recurring weekly rules ---------------- */

const RECURRING_COLS = `id, weekday, time_hhmm, title, location_label, map_x, map_y, notes, is_active`;

/** How far ahead we are willing to look for an unskipped occurrence. */
const SKIP_LOOKAHEAD_WEEKS = 26;

const recurring = {
  list: () =>
    db
      .prepare(
        `SELECT ${RECURRING_COLS} FROM recurring_meetings
          ORDER BY is_active DESC, weekday ASC, time_hhmm ASC`
      )
      .all(),
  listActive: () =>
    db
      .prepare(
        `SELECT ${RECURRING_COLS} FROM recurring_meetings
          WHERE is_active = 1 ORDER BY weekday ASC, time_hhmm ASC`
      )
      .all(),
  byId: (id) => db.prepare(`SELECT * FROM recurring_meetings WHERE id = ?`).get(id),
  create: (r) =>
    db
      .prepare(
        `INSERT INTO recurring_meetings
           (weekday, time_hhmm, title, location_label, map_x, map_y, notes, is_active, created_by)
         VALUES (@weekday, @time_hhmm, @title, @location_label, @map_x, @map_y, @notes, @is_active, @created_by)`
      )
      .run(r),
  update: (r) =>
    db
      .prepare(
        `UPDATE recurring_meetings SET weekday = @weekday, time_hhmm = @time_hhmm, title = @title,
                location_label = @location_label, map_x = @map_x, map_y = @map_y, notes = @notes,
                is_active = @is_active, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @id`
      )
      .run(r),
  setActive: (id, active) =>
    db
      .prepare(
        `UPDATE recurring_meetings SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .run(active ? 1 : 0, id),
  /** Rules are cheap to retype, so removing one is a hard delete (skips cascade). */
  remove: (id) => db.prepare('DELETE FROM recurring_meetings WHERE id = ?').run(id),

  /* ---- skipped occurrences ---- */

  /** Local "YYYY-MM-DD" dates this rule is skipping, today onward. */
  skipDates: (recurringId, fromLocalDate = dates.localDateKey(new Date())) =>
    db
      .prepare(
        `SELECT skip_date FROM recurring_skips
          WHERE recurring_id = ? AND skip_date >= ? ORDER BY skip_date ASC`
      )
      .all(recurringId, fromLocalDate)
      .map((row) => row.skip_date),
  skips: (recurringId, fromLocalDate = dates.localDateKey(new Date())) =>
    db
      .prepare(
        `SELECT id, recurring_id, skip_date FROM recurring_skips
          WHERE recurring_id = ? AND skip_date >= ? ORDER BY skip_date ASC`
      )
      .all(recurringId, fromLocalDate),
  addSkip: (recurringId, skipDate, byUserId) =>
    db
      .prepare(
        `INSERT INTO recurring_skips (recurring_id, skip_date, created_by) VALUES (?, ?, ?)
         ON CONFLICT (recurring_id, skip_date) DO NOTHING`
      )
      .run(recurringId, skipDate, byUserId),
  removeSkip: (id) => db.prepare('DELETE FROM recurring_skips WHERE id = ?').run(id),

  /**
   * The next occurrence of `rule` that nobody has skipped, or null if every
   * occurrence in the next half-year is skipped (which would be quite the year).
   */
  nextOccurrence: (rule, from = new Date()) => {
    const skipped = new Set(recurring.skipDates(rule.id, dates.localDateKey(from)));
    const candidates = dates.nextOccurrences(rule.weekday, rule.time_hhmm, SKIP_LOOKAHEAD_WEEKS, from);
    return candidates.find((occ) => !skipped.has(occ.local_date)) || null;
  },

  /** Shape a rule + occurrence like a meetings row, so views need no branching. */
  asMeeting: (rule, occ) => ({
    id: null,
    starts_at: occ.starts_at,
    title: rule.title,
    notes: rule.notes,
    location_label: rule.location_label,
    map_x: rule.map_x,
    map_y: rule.map_y,
    is_cancelled: 0,
    is_recurring: true,
    recurring_id: rule.id,
    weekday: rule.weekday,
    time_hhmm: rule.time_hhmm,
    local_date: occ.local_date,
  }),
};

/* ---------------- announcements ---------------- */

const announcements = {
  list: (limit = 20) =>
    db
      .prepare(
        `SELECT a.*, u.display_name AS author_name
           FROM announcements a LEFT JOIN users u ON u.id = a.author_id
          WHERE a.deleted_at IS NULL
          ORDER BY a.is_pinned DESC, a.created_at DESC
          LIMIT ?`
      )
      .all(limit),
  byId: (id) => db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id),
  create: (a) =>
    db
      .prepare(
        `INSERT INTO announcements (title, body_html, body_md, is_pinned, author_id)
         VALUES (@title, @body_html, @body_md, @is_pinned, @author_id)`
      )
      .run(a),
  update: (a) =>
    db
      .prepare(
        `UPDATE announcements SET title = @title, body_html = @body_html, body_md = @body_md,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @id`
      )
      .run(a),
  setPinned: (id, pinned) =>
    db.prepare('UPDATE announcements SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id),
  softDelete: (id, byUserId) =>
    db
      .prepare(
        `UPDATE announcements SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`
      )
      .run(byUserId, id),
};

module.exports = { users, meetings, recurring, announcements };
