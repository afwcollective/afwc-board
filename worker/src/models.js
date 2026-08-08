/**
 * Port of src/models.js — the shared query layer.
 *
 * Same helpers, same names, same SQL semantics. Three mechanical differences,
 * all forced by D1 and all documented once in worker/src/db.js:
 *
 *   1. every helper is async and takes the D1 binding as its first argument
 *      (`meetings.next(db)` rather than `meetings.next()`), because there is no
 *      module-scope database handle to close over on Workers;
 *   2. `@named` bind parameters become positional `?`, listed in order — a name
 *      the original used twice in one statement is bound twice;
 *   3. `db.transaction(fn)` becomes `db.batch([...])`.
 *
 * Everything else — the privacy rule on off-site meetings, the coalesce
 * semantics of occurrence overrides, the unassign-deletes-overrides rule — is
 * behaviour the app depends on and is reproduced exactly.
 */

import { one, all, run, stmt, getSetting, setSetting } from './db.js';
import * as dates from './util/dates.js';
import * as roles from './auth/roles.js';

/* ---------------- users ---------------- */

export const users = {
  count: async (db) => (await one(db, 'SELECT COUNT(*) AS n FROM users')).n,
  countActive: async (db) => (await one(db, 'SELECT COUNT(*) AS n FROM users WHERE is_active = 1')).n,
  /** Active accounts with admin-console access — leaders plus the architect. */
  countLeaders: async (db) =>
    (await one(
      db,
      "SELECT COUNT(*) AS n FROM users WHERE role IN ('leader','architect') AND is_active = 1"
    )).n,
  /** Leaders whose time-boxed term runs out within `days` days — the dashboard's nag. */
  countExpiringLeaders: async (db, days = 14) => {
    const until = new Date(Date.now() + days * 24 * 3600e3).toISOString();
    return (await one(
      db,
      "SELECT COUNT(*) AS n FROM users WHERE role = 'leader' AND is_active = 1 AND role_expires_at IS NOT NULL AND role_expires_at <= ?",
      until
    )).n;
  },
  /** The one architect, or null on a board that has not run /setup yet. */
  architect: (db) => one(db, "SELECT * FROM users WHERE role = 'architect' ORDER BY id LIMIT 1"),
  byUsername: (db, username) =>
    one(db, 'SELECT * FROM users WHERE username = ?', String(username || '').trim()),
  byId: (db, id) => one(db, 'SELECT * FROM users WHERE id = ?', id),

  /** Returns D1 meta; the new id is meta.last_row_id. */
  create: (db, { username, display_name, email, password_hash, role }) =>
    run(
      db,
      `INSERT INTO users (username, display_name, email, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
      String(username).trim(),
      String(display_name).trim(),
      email ? String(email).trim() : null,
      password_hash,
      roles.isRole(role) ? role : roles.MEMBER
    ),

  touchLogin: (db, id) =>
    run(db, "UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", id),

  /** Everyone, for the leader-only /admin/members table. Architect, leaders, then A–Z. */
  list: (db) =>
    all(
      db,
      `SELECT id, username, display_name, role, role_expires_at, is_active, created_at, last_login_at
         FROM users
        ORDER BY CASE role WHEN 'architect' THEN 0 WHEN 'leader' THEN 1 ELSE 2 END,
                 is_active DESC, display_name COLLATE NOCASE`
    ),

  setActive: (db, id, active) =>
    run(db, 'UPDATE users SET is_active = ? WHERE id = ?', active ? 1 : 0, id),

  /** Active accounts only, A–Z — the pool a leader picks a session host from. */
  listActive: (db) =>
    all(
      db,
      `SELECT id, username, display_name, role FROM users
        WHERE is_active = 1 ORDER BY display_name COLLATE NOCASE`
    ),

  /**
   * Set a role, and with it the term. `expiresAt` is a UTC ISO string or null
   * (permanent) and is only kept for the leader tier — a member has nothing to
   * expire and the architect chair never does, so both are stored NULL. An
   * unknown role falls back to 'member' rather than throwing at a CHECK.
   */
  setRole: (db, id, role, expiresAt = null) => {
    const next = roles.isRole(role) ? role : roles.MEMBER;
    const expires = next === roles.LEADER && expiresAt ? String(expiresAt) : null;
    return run(db, 'UPDATE users SET role = ?, role_expires_at = ? WHERE id = ?', next, expires, id);
  },
  setPasswordHash: (db, id, password_hash) =>
    run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', password_hash, id),
  setResetCode: (db, id, reset_code_hash, reset_expires_at) =>
    run(
      db,
      'UPDATE users SET reset_code_hash = ?, reset_expires_at = ? WHERE id = ?',
      reset_code_hash,
      reset_expires_at,
      id
    ),
  clearResetCode: (db, id) =>
    run(db, 'UPDATE users SET reset_code_hash = NULL, reset_expires_at = NULL WHERE id = ?', id),
};

/* ---------------- meetings ---------------- */

/*
 * A meetings row as the rest of the app wants it: the leader-set columns, the
 * off-site fields, and the host's display name resolved in the same query
 * (hosting is public information — the name, and only the name).
 *
 * PRIVACY: `address` and `body_html` belong to members only when kind =
 * 'offsite'. That rule is enforced where the row is rendered — see
 * meetings.publicSafe() below, which worker/src/routes/public.js runs over the
 * row before handing it to a logged-out visitor.
 */
const MEETING_SELECT = `
  SELECT m.id, m.starts_at, m.title, m.notes, m.location_label, m.map_x, m.map_y,
         m.is_cancelled, m.kind, m.address, m.body_html, m.host_user_id,
         hu.display_name AS host_name
    FROM meetings m
    LEFT JOIN users hu ON hu.id = m.host_user_id`;

export const meetings = {
  /** The one the landing page shows: soonest future, not cancelled, not deleted. */
  next: (db) =>
    one(
      db,
      `${MEETING_SELECT}
        WHERE m.deleted_at IS NULL AND m.is_cancelled = 0 AND m.starts_at >= ?
        ORDER BY m.starts_at ASC LIMIT 1`,
      new Date().toISOString()
    ),

  /**
   * What the landing page actually shows: the soonest of (a) the next one-off
   * meeting and (b) each active weekly rule's next unskipped occurrence, with
   * any host assignment and (for weekly occurrences) the host's overrides
   * already merged in.
   *
   * Always returns a meetings-row shape — plus `is_recurring`, `recurring_id`,
   * `local_date`, `host_name` and `overridden` — so home.ejs reads one object
   * either way.
   */
  nextUnified: async (db, from = new Date()) => {
    const candidates = [];

    const oneOff = await meetings.next(db);
    if (oneOff) {
      candidates.push({
        ...oneOff,
        is_recurring: false,
        recurring_id: null,
        local_date: dates.localDateKey(oneOff.starts_at),
        overridden: false,
      });
    }

    for (const rule of await recurring.listActive(db)) {
      const occ = await recurring.nextOccurrence(db, rule, from);
      if (!occ) continue;
      candidates.push(
        recurring.asMeeting(rule, occ, {
          override: await hosts.override(db, rule.id, occ.local_date),
          host: await hosts.forOccurrence(db, rule.id, occ.local_date),
        })
      );
    }

    candidates.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    return candidates[0] || null;
  },

  /**
   * The version of a meeting a LOGGED-OUT visitor may see.
   *
   * An off-site event happens at somebody's home. Its address, its details and
   * even the names of its attachments are for members; the public page gets the
   * title, the date and time, and a sign-in teaser. Everything else about the
   * row (including who is hosting — a first name on a public page is the point)
   * is unchanged, and an R. House meeting passes through untouched.
   *
   * This is a whitelist by construction: the two private columns are replaced
   * with null rather than "hidden by the template", so a future view that
   * forgets the rule still cannot leak them.
   */
  publicSafe: (meeting) => {
    if (!meeting) return meeting;
    if (meeting.kind !== 'offsite') return meeting;
    return { ...meeting, address: null, body_html: null, members_only: true };
  },

  upcoming: (db, limit = 50) =>
    all(
      db,
      `${MEETING_SELECT}
        WHERE m.deleted_at IS NULL AND m.starts_at >= ?
        ORDER BY m.starts_at ASC LIMIT ?`,
      new Date().toISOString(),
      limit
    ),

  /**
   * The landing page's "special events" list: every future, non-cancelled
   * one-off meeting (R. House or off-site) EXCEPT `excludeId` — the meeting
   * already shown as the next-session card, so nothing appears twice on the
   * page. Weekly sessions never appear here; they are the staples, not a
   * special event, and live in `recurring`.
   *
   * PRIVACY: this returns raw rows, same as `upcoming`/`next`. A caller
   * rendering to a logged-out visitor must still map each row through
   * `meetings.publicSafe` before it reaches a template.
   */
  upcomingSpecial: (db, limit = 20, excludeId = null) =>
    all(
      db,
      `${MEETING_SELECT}
        WHERE m.deleted_at IS NULL AND m.is_cancelled = 0 AND m.starts_at >= ?
          AND (? IS NULL OR m.id != ?)
        ORDER BY m.starts_at ASC LIMIT ?`,
      new Date().toISOString(),
      excludeId || null,
      excludeId || null,
      limit
    ),

  past: (db, limit = 20) =>
    all(
      db,
      `${MEETING_SELECT}
        WHERE m.deleted_at IS NULL AND m.starts_at < ?
        ORDER BY m.starts_at DESC LIMIT ?`,
      new Date().toISOString(),
      limit
    ),

  byId: (db, id) => one(db, 'SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL', id),

  /** byId plus the host's display name — what the admin form and /host render. */
  byIdWithHost: (db, id) =>
    one(db, `${MEETING_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`, id),

  create: (db, m) =>
    run(
      db,
      `INSERT INTO meetings (starts_at, title, notes, location_label, map_x, map_y,
                             is_cancelled, kind, address, body_html, body_md, host_user_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.starts_at, m.title, m.notes, m.location_label, m.map_x, m.map_y,
      m.is_cancelled, m.kind, m.address, m.body_html, m.body_md, m.host_user_id, m.created_by
    ),

  update: (db, m) =>
    run(
      db,
      `UPDATE meetings SET starts_at = ?, title = ?, notes = ?,
              location_label = ?, map_x = ?, map_y = ?,
              is_cancelled = ?, kind = ?, address = ?,
              body_html = ?, body_md = ?, host_user_id = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      m.starts_at, m.title, m.notes, m.location_label, m.map_x, m.map_y,
      m.is_cancelled, m.kind, m.address, m.body_html, m.body_md, m.host_user_id, m.id
    ),

  /**
   * The narrow update a session HOST is allowed to make to a one-off meeting:
   * when it starts, where in the room, the pin, and a note. Never the title,
   * never the kind, never the address, never who is hosting — those stay with
   * the leaders.
   */
  updateByHost: (db, m) =>
    run(
      db,
      `UPDATE meetings SET starts_at = ?, location_label = ?,
              map_x = ?, map_y = ?, notes = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      m.starts_at, m.location_label, m.map_x, m.map_y, m.notes, m.id
    ),

  setHost: (db, id, userId) =>
    run(
      db,
      `UPDATE meetings SET host_user_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      userId || null,
      id
    ),
  setCancelled: (db, id, cancelled) =>
    run(
      db,
      `UPDATE meetings SET is_cancelled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      cancelled ? 1 : 0,
      id
    ),
  softDelete: (db, id, byUserId) =>
    run(
      db,
      `UPDATE meetings SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`,
      byUserId,
      id
    ),
};

/* ---------------- recurring weekly rules ---------------- */

const RECURRING_COLS = `id, weekday, time_hhmm, title, location_label, map_x, map_y, notes, is_active`;

/** How far ahead we are willing to look for an unskipped occurrence. */
const SKIP_LOOKAHEAD_WEEKS = 26;

export const recurring = {
  list: (db) =>
    all(
      db,
      `SELECT ${RECURRING_COLS} FROM recurring_meetings
        ORDER BY is_active DESC, weekday ASC, time_hhmm ASC`
    ),
  listActive: (db) =>
    all(
      db,
      `SELECT ${RECURRING_COLS} FROM recurring_meetings
        WHERE is_active = 1 ORDER BY weekday ASC, time_hhmm ASC`
    ),
  byId: (db, id) => one(db, `SELECT * FROM recurring_meetings WHERE id = ?`, id),

  create: (db, r) =>
    run(
      db,
      `INSERT INTO recurring_meetings
         (weekday, time_hhmm, title, location_label, map_x, map_y, notes, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.weekday, r.time_hhmm, r.title, r.location_label, r.map_x, r.map_y, r.notes, r.is_active, r.created_by
    ),
  update: (db, r) =>
    run(
      db,
      `UPDATE recurring_meetings SET weekday = ?, time_hhmm = ?, title = ?,
              location_label = ?, map_x = ?, map_y = ?, notes = ?,
              is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      r.weekday, r.time_hhmm, r.title, r.location_label, r.map_x, r.map_y, r.notes, r.is_active, r.id
    ),
  setActive: (db, id, active) =>
    run(
      db,
      `UPDATE recurring_meetings SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      active ? 1 : 0,
      id
    ),
  /** Rules are cheap to retype, so removing one is a hard delete (skips cascade). */
  remove: (db, id) => run(db, 'DELETE FROM recurring_meetings WHERE id = ?', id),

  /* ---- skipped occurrences ---- */

  /** Local "YYYY-MM-DD" dates this rule is skipping, today onward. */
  skipDates: async (db, recurringId, fromLocalDate = dates.localDateKey(new Date())) =>
    (await all(
      db,
      `SELECT skip_date FROM recurring_skips
        WHERE recurring_id = ? AND skip_date >= ? ORDER BY skip_date ASC`,
      recurringId,
      fromLocalDate
    )).map((row) => row.skip_date),

  skips: (db, recurringId, fromLocalDate = dates.localDateKey(new Date())) =>
    all(
      db,
      `SELECT id, recurring_id, skip_date FROM recurring_skips
        WHERE recurring_id = ? AND skip_date >= ? ORDER BY skip_date ASC`,
      recurringId,
      fromLocalDate
    ),

  addSkip: (db, recurringId, skipDate, byUserId) =>
    run(
      db,
      `INSERT INTO recurring_skips (recurring_id, skip_date, created_by) VALUES (?, ?, ?)
       ON CONFLICT (recurring_id, skip_date) DO NOTHING`,
      recurringId,
      skipDate,
      byUserId
    ),
  removeSkip: (db, id) => run(db, 'DELETE FROM recurring_skips WHERE id = ?', id),

  /**
   * The next occurrence of `rule` that nobody has skipped, or null if every
   * occurrence in the next half-year is skipped (which would be quite the year).
   */
  nextOccurrence: async (db, rule, from = new Date()) => {
    const skipped = new Set(await recurring.skipDates(db, rule.id, dates.localDateKey(from)));
    const candidates = dates.nextOccurrences(rule.weekday, rule.time_hhmm, SKIP_LOOKAHEAD_WEEKS, from);
    return candidates.find((occ) => !skipped.has(occ.local_date)) || null;
  },

  /**
   * Shape a rule + occurrence like a meetings row, so views need no branching.
   *
   * `override` (a row from occurrence_overrides) and `host` (from
   * occurrence_hosts) are optional. An override column that is NULL means "use
   * the rule's value", so this is a field-by-field coalesce rather than a
   * wholesale replacement — a host who only moves the pin does not silently
   * blank the rule's location label. A time override re-derives starts_at
   * through the same local-wall-clock conversion the rule itself uses, so
   * "we're starting an hour later today" survives a DST boundary intact.
   *
   * Weekly occurrences are always R. House meetings: kind is fixed at 'rhouse'
   * and there is no address or body — an off-site night is a one-off row.
   *
   * Pure function: no database, so it keeps the same signature it had on Node.
   */
  asMeeting: (rule, occ, { override = null, host = null } = {}) => {
    const time = (override && override.time_hhmm) || rule.time_hhmm;
    const starts_at =
      override && override.time_hhmm
        ? dates.localInputToUtcIso(`${occ.local_date}T${override.time_hhmm}`) || occ.starts_at
        : occ.starts_at;
    const pick = (key) =>
      override && override[key] !== null && override[key] !== undefined ? override[key] : rule[key];

    return {
      id: null,
      starts_at,
      title: rule.title,
      notes: pick('notes'),
      location_label: pick('location_label'),
      map_x: pick('map_x'),
      map_y: pick('map_y'),
      is_cancelled: 0,
      kind: 'rhouse',
      address: null,
      body_html: null,
      is_recurring: true,
      recurring_id: rule.id,
      weekday: rule.weekday,
      time_hhmm: time,
      local_date: occ.local_date,
      host_user_id: host ? host.user_id : null,
      host_name: host ? host.display_name : null,
      overridden: !!override,
    };
  },
};

/* ---------------- session hosts ---------------- *
 *
 * A host runs ONE meeting. Two storage shapes, because there are two kinds of
 * meeting:
 *   one-off   → meetings.host_user_id, and the host edits the row itself
 *               (meetings.updateByHost — time/label/pin/notes only).
 *   weekly    → occurrence_hosts(recurring_id, local_date), and the host's
 *               changes land in occurrence_overrides for that single date. The
 *               rule is never touched, so next week is unaffected.
 *
 * UNASSIGN SEMANTICS: removing a weekly host DELETES that date's overrides too.
 * The overrides exist because a particular person was running that day; with
 * them gone the occurrence should read exactly like the rule again, rather than
 * quietly keeping a pin nobody remembers moving. REASSIGNING to a different
 * member keeps them — the session's arrangements stand and the new host can
 * adjust them. A one-off has no override row: unassigning leaves the
 * leader-visible fields exactly as they are, because those fields were always
 * the leaders'.
 */

export const hosts = {
  /* ---- weekly occurrences ---- */

  forOccurrence: (db, recurringId, localDate) =>
    one(
      db,
      `SELECT oh.id, oh.recurring_id, oh.local_date, oh.user_id, u.display_name, u.username
         FROM occurrence_hosts oh JOIN users u ON u.id = oh.user_id
        WHERE oh.recurring_id = ? AND oh.local_date = ?`,
      recurringId,
      localDate
    ),

  /** Assignments for one rule, today onward — what the weekly admin row lists. */
  forRule: (db, recurringId, fromLocalDate = dates.localDateKey(new Date())) =>
    all(
      db,
      `SELECT oh.id, oh.recurring_id, oh.local_date, oh.user_id, u.display_name, u.username
         FROM occurrence_hosts oh JOIN users u ON u.id = oh.user_id
        WHERE oh.recurring_id = ? AND oh.local_date >= ?
        ORDER BY oh.local_date ASC`,
      recurringId,
      fromLocalDate
    ),

  assign: (db, recurringId, localDate, userId, byUserId) =>
    run(
      db,
      `INSERT INTO occurrence_hosts (recurring_id, local_date, user_id, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (recurring_id, local_date)
         DO UPDATE SET user_id = excluded.user_id, created_by = excluded.created_by`,
      recurringId,
      localDate,
      userId,
      byUserId
    ),

  /**
   * Remove a host from a date — and, with them, that date's overrides.
   * Was a better-sqlite3 transaction; D1 has no interactive transactions, so
   * the two deletes go down as one atomic batch.
   */
  unassign: (db, recurringId, localDate) =>
    db.batch([
      stmt(db, 'DELETE FROM occurrence_hosts WHERE recurring_id = ? AND local_date = ?', recurringId, localDate),
      stmt(db, 'DELETE FROM occurrence_overrides WHERE recurring_id = ? AND local_date = ?', recurringId, localDate),
    ]),

  override: (db, recurringId, localDate) =>
    one(db, 'SELECT * FROM occurrence_overrides WHERE recurring_id = ? AND local_date = ?', recurringId, localDate),

  saveOverride: (db, o) =>
    run(
      db,
      `INSERT INTO occurrence_overrides
         (recurring_id, local_date, time_hhmm, location_label, map_x, map_y, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (recurring_id, local_date) DO UPDATE SET
         time_hhmm = excluded.time_hhmm, location_label = excluded.location_label,
         map_x = excluded.map_x, map_y = excluded.map_y, notes = excluded.notes,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      o.recurring_id, o.local_date, o.time_hhmm, o.location_label, o.map_x, o.map_y, o.notes, o.updated_by
    ),

  /* ---- "am I hosting anything?" ---- */

  HOST_WINDOW_DAYS: 30,

  /**
   * One statement, one row, no joins: does this member have any hosting
   * assignment between the start of today (Baltimore) and 30 days out? This is
   * what loadUser calls per request to publish isHost, so it has to stay this
   * cheap.
   */
  hasUpcoming: async (db, userId, days = 30) => {
    const today = dates.localDateKey(new Date());
    const until = dates.addLocalDays(today, days);
    const floorIso = dates.localInputToUtcIso(`${today}T00:00`) || new Date().toISOString();
    const untilIso = dates.localInputToUtcIso(`${until}T23:59`) || floorIso;
    const row = await one(
      db,
      `SELECT
         EXISTS (SELECT 1 FROM occurrence_hosts
                  WHERE user_id = ? AND local_date >= ? AND local_date <= ?)
         OR
         EXISTS (SELECT 1 FROM meetings
                  WHERE host_user_id = ? AND deleted_at IS NULL AND is_cancelled = 0
                    AND starts_at >= ? AND starts_at <= ?) AS yes`,
      userId, today, until,
      userId, floorIso, untilIso
    );
    return !!(row && row.yes);
  },

  /**
   * Everything `userId` is hosting in the next `days` days, both shapes, sorted
   * by when it starts. Each entry is a meetings-row shape (so the /host page
   * renders one card template) plus:
   *   type        'recurring' | 'meeting'
   *   editPath    where the host edits it
   *   skipped     weekly only: leaders have called that date off
   *   paused      weekly only: the whole rule is deactivated
   * A date whose rule is paused or skipped still appears — with a note — rather
   * than silently vanishing from the host's list.
   */
  upcomingForUser: async (db, userId, days = 30) => {
    const today = dates.localDateKey(new Date());
    const until = dates.addLocalDays(today, days);
    const out = [];

    const assignments = await all(
      db,
      `SELECT oh.recurring_id, oh.local_date, r.weekday, r.time_hhmm, r.title,
              r.location_label, r.map_x, r.map_y, r.notes, r.is_active
         FROM occurrence_hosts oh JOIN recurring_meetings r ON r.id = oh.recurring_id
        WHERE oh.user_id = ? AND oh.local_date >= ? AND oh.local_date <= ?
        ORDER BY oh.local_date ASC`,
      userId,
      today,
      until
    );

    for (const a of assignments) {
      const rule = {
        id: a.recurring_id,
        weekday: a.weekday,
        time_hhmm: a.time_hhmm,
        title: a.title,
        location_label: a.location_label,
        map_x: a.map_x,
        map_y: a.map_y,
        notes: a.notes,
      };
      const override = await hosts.override(db, a.recurring_id, a.local_date);
      const starts_at = dates.localInputToUtcIso(
        `${a.local_date}T${(override && override.time_hhmm) || a.time_hhmm}`
      );
      const shaped = recurring.asMeeting(rule, { local_date: a.local_date, starts_at }, { override });
      out.push({
        ...shaped,
        type: 'recurring',
        editPath: `/host/recurring/${a.recurring_id}/${a.local_date}`,
        paused: !a.is_active,
        skipped: !!(await one(
          db,
          'SELECT 1 AS y FROM recurring_skips WHERE recurring_id = ? AND skip_date = ?',
          a.recurring_id,
          a.local_date
        )),
      });
    }

    const floorIso = dates.localInputToUtcIso(`${today}T00:00`) || new Date().toISOString();
    const untilIso = dates.localInputToUtcIso(`${until}T23:59`) || floorIso;
    const oneOffs = await all(
      db,
      `${MEETING_SELECT}
        WHERE m.host_user_id = ? AND m.deleted_at IS NULL
          AND m.starts_at >= ? AND m.starts_at <= ?
        ORDER BY m.starts_at ASC`,
      userId,
      floorIso,
      untilIso
    );

    for (const m of oneOffs) {
      out.push({
        ...m,
        is_recurring: false,
        recurring_id: null,
        local_date: dates.localDateKey(m.starts_at),
        type: 'meeting',
        editPath: `/host/meeting/${m.id}`,
      });
    }

    out.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    return out;
  },
};

/* ---------------- off-site event attachments ---------------- *
 *
 * Rows only. The bytes live in R2 under uploads/events/<meeting_id>/ and leave
 * only through the members-only stream in the events router (P2).
 */

export const eventFiles = {
  /*
   * `expired` is the retention window, asked per row: the attachment ROW is the
   * event's permanent record of what was attached, but the BYTES are swept by
   * age (worker/src/scheduled.js). Views that link to a file read this so they
   * can say so quietly instead of offering a link into a 404. The correlated
   * subquery is the same (scope, ref_id, stored_name) lookup the stream route
   * does, against the UNIQUE index on stored_files.
   *
   * This is a WORKER-ONLY column — src/models.js has no counterpart because the
   * Express app keeps uploaded files forever. Shared views therefore read it
   * behind a typeof guard; see views/home.ejs.
   */
  forMeeting: (db, meetingId) =>
    all(
      db,
      `SELECT id, meeting_id, original_name, stored_name, mime, size, created_at,
              NOT EXISTS (SELECT 1 FROM stored_files s
                           WHERE s.scope = 'events' AND s.ref_id = event_attachments.meeting_id
                             AND s.stored_name = event_attachments.stored_name) AS expired
         FROM event_attachments WHERE meeting_id = ? ORDER BY id ASC`,
      meetingId
    ),
  byId: (db, id, meetingId) =>
    one(db, 'SELECT * FROM event_attachments WHERE id = ? AND meeting_id = ?', id, meetingId),
  count: async (db, meetingId) =>
    (await one(db, 'SELECT COUNT(*) AS n FROM event_attachments WHERE meeting_id = ?', meetingId)).n,
  create: (db, a) =>
    run(
      db,
      `INSERT INTO event_attachments (meeting_id, original_name, stored_name, mime, size)
       VALUES (?, ?, ?, ?, ?)`,
      a.meeting_id, a.original_name, a.stored_name, a.mime, a.size
    ),
  remove: (db, id, meetingId) =>
    run(db, 'DELETE FROM event_attachments WHERE id = ? AND meeting_id = ?', id, meetingId),
};

/* ---------------- announcements ---------------- */

export const announcements = {
  list: (db, limit = 20) =>
    all(
      db,
      `SELECT a.*, u.display_name AS author_name
         FROM announcements a LEFT JOIN users u ON u.id = a.author_id
        WHERE a.deleted_at IS NULL
        ORDER BY a.is_pinned DESC, a.created_at DESC
        LIMIT ?`,
      limit
    ),
  byId: (db, id) => one(db, 'SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL', id),

  /**
   * How many live announcements there are, capped — the admin dashboard's stat
   * tile. The Express version read `announcements.list(100).length`, which
   * fetched a hundred rows (body_html and all) to report a number; the LIMIT is
   * kept inside the subquery so the answer is identical while the row cost is
   * not paid on a page that only prints it.
   */
  countUpTo: async (db, limit = 100) =>
    (await one(
      db,
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM announcements WHERE deleted_at IS NULL LIMIT ?)',
      limit
    )).n,

  create: (db, a) =>
    run(
      db,
      `INSERT INTO announcements (title, body_html, body_md, is_pinned, author_id)
       VALUES (?, ?, ?, ?, ?)`,
      a.title, a.body_html, a.body_md, a.is_pinned, a.author_id
    ),
  update: (db, a) =>
    run(
      db,
      `UPDATE announcements SET title = ?, body_html = ?, body_md = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      a.title, a.body_html, a.body_md, a.id
    ),
  setPinned: (db, id, pinned) =>
    run(db, 'UPDATE announcements SET is_pinned = ? WHERE id = ?', pinned ? 1 : 0, id),
  softDelete: (db, id, byUserId) =>
    run(
      db,
      `UPDATE announcements SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?`,
      byUserId,
      id
    ),
};

/* ---------------- about (front-page "The Collective" copy) ---------------- *
 *
 * One markdown blob in the settings key/value table. `getMd` bootstraps the
 * default the FIRST time anything asks for it — landing page or /admin/about,
 * whichever loads first after a fresh install — and is otherwise a plain read.
 * Idempotent by construction: it only ever writes when the key is missing, so a
 * leader's saved copy is never clobbered by a later request.
 */

const ABOUT_KEY = 'about_md';

export const ABOUT_DEFAULT_MD = `The Agile Fiction Writers Collective is a Baltimore fiction-writers' group
built around timed writing sprints. We meet at R. House in Remington, sit down
together, and write — for a stretch, then stop, talk about how it went, and go
again. Everyone works on their own project; there's no assigned reading and no
round-robin critique.

All genres and formats are welcome: novels, short stories, screenplays, even
graphic novels. Bring a laptop, a notebook, whatever gets the words down.

We grew out of a Meetup group and kept the informal, drop-in spirit. Sharing a
draft is a door, not a requirement — open it in the library whenever a piece
feels ready, never before. New writers are welcome any week; just show up.`;

export const about = {
  /** The current markdown, seeding the default on first read. */
  getMd: async (db) => {
    const existing = await getSetting(db, ABOUT_KEY);
    if (existing !== null) return existing;
    await setSetting(db, ABOUT_KEY, ABOUT_DEFAULT_MD);
    return ABOUT_DEFAULT_MD;
  },
  setMd: (db, md) => setSetting(db, ABOUT_KEY, md),
};

/* ---------------- quotes (leader-adjustable landing quote rail) ---------------- *
 *
 * A handful of short quotes a leader curates from /admin/quotes. One shows on
 * the landing page at a time — see quotes.ofDay below — picked the same way
 * for everyone on a given day so it reads as a single daily moment rather
 * than a per-visitor random draw.
 *
 * Table added by worker/migrations/0002_quotes_chat.sql (src/migrations/006).
 */

const QUOTE_SEED = {
  text: 'Not all those who wander are lost',
  attribution: 'J.R.R. Tolkien',
  source_note: 'The Fellowship of the Ring',
};

/**
 * Baltimore-local day-of-year (0-indexed), so the rotation flips over at
 * local midnight rather than UTC midnight — consistent with how every other
 * "today" in this app is decided (worker/src/util/dates.js's localDateKey).
 */
function localDayOfYear(when) {
  const key = dates.localDateKey(when);
  const [y, m, d] = key.split('-').map(Number);
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, d);
  return Math.floor((cur - start) / 86400000);
}

export const quotes = {
  /**
   * Idempotent bootstrap, same shape as about.getMd: insert the one starter
   * quote ONLY when the table is empty, so a leader's own edits (including
   * deleting the seed) are never clobbered by a later request. The dev seed
   * script writes the same row up front, so on a seeded board this is a single
   * COUNT and no write at all.
   */
  ensureSeed: async (db) => {
    const row = await one(db, 'SELECT COUNT(*) AS n FROM quotes');
    if (row && row.n > 0) return false;
    await quotes.create(db, {
      text: QUOTE_SEED.text,
      attribution: QUOTE_SEED.attribution,
      source_note: QUOTE_SEED.source_note,
      is_active: 1,
      sort_order: 0,
      created_by: null,
    });
    return true;
  },

  /** Every quote, active or not — what /admin/quotes lists. */
  list: async (db) => {
    await quotes.ensureSeed(db);
    return all(db, 'SELECT * FROM quotes ORDER BY sort_order ASC, id ASC');
  },

  /** Active quotes only, in display order — the rotation pool. */
  active: async (db) => {
    await quotes.ensureSeed(db);
    return all(db, 'SELECT * FROM quotes WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
  },

  byId: (db, id) => one(db, 'SELECT * FROM quotes WHERE id = ?', id),

  create: (db, q) =>
    run(
      db,
      `INSERT INTO quotes (text, attribution, source_note, is_active, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      q.text, q.attribution, q.source_note, q.is_active, q.sort_order, q.created_by
    ),

  update: (db, q) =>
    run(
      db,
      `UPDATE quotes SET text = ?, attribution = ?, source_note = ?, sort_order = ?
        WHERE id = ?`,
      q.text, q.attribution, q.source_note, q.sort_order, q.id
    ),

  setActive: (db, id, active) =>
    run(db, 'UPDATE quotes SET is_active = ? WHERE id = ?', active ? 1 : 0, id),

  remove: (db, id) => run(db, 'DELETE FROM quotes WHERE id = ?', id),

  /**
   * The landing page's quote of the day: a deterministic pick among active
   * quotes, indexed by day-of-year modulo the pool size, so every visitor
   * sees the same one on the same day and it steps forward on its own with
   * no scheduler and no JS. Null when nothing is active — the landing page
   * renders no quote section at all rather than an empty one.
   */
  ofDay: async (db, when = new Date()) => {
    const pool = await quotes.active(db);
    if (!pool.length) return null;
    return pool[localDayOfYear(when) % pool.length];
  },
};

/* ---------------- drafts (cross-router reads only) ---------------- *
 *
 * The library query, upload and moderation stay route-local and land in P4.
 * The landing page needs two small reads that belong to no single router: a
 * members-only "fresh pages" preview and a logged-out teaser count that leaks
 * nothing but a number. Both are READY, non-deleted drafts only — a
 * still-converting or failed upload is not "shared" yet.
 */

export const drafts = {
  /** Newest ready drafts, newest first — the landing page's members-only preview. */
  recent: (db, limit = 3) =>
    all(
      db,
      `SELECT d.id, d.title, d.kind, d.created_at, u.display_name AS uploader_name
         FROM drafts d JOIN users u ON u.id = d.user_id
        WHERE d.deleted_at IS NULL AND d.status = 'ready'
        ORDER BY d.created_at DESC LIMIT ?`,
      limit
    ),

  /** Count of ready drafts — the logged-out teaser's number. No titles, no names. */
  countAll: async (db) =>
    (await one(db, `SELECT COUNT(*) AS n FROM drafts WHERE deleted_at IS NULL AND status = 'ready'`)).n,
};
