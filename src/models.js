'use strict';

/**
 * Small query helpers shared by more than one router. Anything used by a single
 * router lives next to that router instead. All statements are prepared through
 * better-sqlite3; there is no ORM and there never will be.
 */

const { db } = require('./db');

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

module.exports = { users, meetings, announcements };
