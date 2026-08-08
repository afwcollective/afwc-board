'use strict';

/**
 * Small query helpers shared by more than one router. Anything used by a single
 * router lives next to that router instead. All statements are prepared through
 * better-sqlite3; there is no ORM and there never will be.
 */

const { db, getSetting, setSetting } = require('./db');
const dates = require('./util/dates');
const roles = require('./auth/roles');

/* ---------------- users ---------------- */

const users = {
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  countActive: () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get().n,
  /** Active accounts with admin-console access — leaders plus the architect. */
  countLeaders: () =>
    db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('leader','architect') AND is_active = 1")
      .get().n,
  /** Leaders whose time-boxed term runs out within `days` days — the dashboard's nag. */
  countExpiringLeaders: (days = 14) => {
    const until = new Date(Date.now() + days * 24 * 3600e3).toISOString();
    return db
      .prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'leader' AND is_active = 1 AND role_expires_at IS NOT NULL AND role_expires_at <= ?"
      )
      .get(until).n;
  },
  /** The one architect, or undefined on a board that has not run /setup yet. */
  architect: () => db.prepare("SELECT * FROM users WHERE role = 'architect' ORDER BY id LIMIT 1").get(),
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
        role: roles.isRole(role) ? role : roles.MEMBER,
      }),
  touchLogin: (id) =>
    db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id),

  /** Everyone, for the leader-only /admin/members table. Architect, leaders, then A–Z. */
  list: () =>
    db
      .prepare(
        `SELECT id, username, display_name, role, role_expires_at, is_active, created_at, last_login_at
           FROM users
          ORDER BY CASE role WHEN 'architect' THEN 0 WHEN 'leader' THEN 1 ELSE 2 END,
                   is_active DESC, display_name COLLATE NOCASE`
      )
      .all(),
  setActive: (id, active) => db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id),

  /** Active accounts only, A–Z — the pool a leader picks a session host from. */
  listActive: () =>
    db
      .prepare(
        `SELECT id, username, display_name, role FROM users
          WHERE is_active = 1 ORDER BY display_name COLLATE NOCASE`
      )
      .all(),

  /**
   * Set a role, and with it the term. `expiresAt` is a UTC ISO string or null
   * (permanent) and is only kept for the leader tier — a member has nothing to
   * expire and the architect chair never does, so both are stored NULL. An
   * unknown role falls back to 'member' rather than throwing at a CHECK.
   */
  setRole: (id, role, expiresAt = null) => {
    const next = roles.isRole(role) ? role : roles.MEMBER;
    const expires = next === roles.LEADER && expiresAt ? String(expiresAt) : null;
    return db.prepare('UPDATE users SET role = ?, role_expires_at = ? WHERE id = ?').run(next, expires, id);
  },
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

/*
 * A meetings row as the rest of the app wants it: the leader-set columns, the
 * off-site fields added in 004, and the host's display name resolved in the
 * same query (hosting is public information — the name, and only the name).
 *
 * PRIVACY: `address` and `body_html` belong to members only when kind =
 * 'offsite'. That rule is enforced where the row is rendered — see
 * meetings.publicSafe() below, which src/routes/public.js runs over the row
 * before handing it to a logged-out visitor.
 */
const MEETING_SELECT = `
  SELECT m.id, m.starts_at, m.title, m.notes, m.location_label, m.map_x, m.map_y,
         m.is_cancelled, m.kind, m.address, m.body_html, m.host_user_id,
         hu.display_name AS host_name
    FROM meetings m
    LEFT JOIN users hu ON hu.id = m.host_user_id`;

const meetings = {
  /** The one the landing page shows: soonest future, not cancelled, not deleted. */
  next: () =>
    db
      .prepare(
        `${MEETING_SELECT}
          WHERE m.deleted_at IS NULL AND m.is_cancelled = 0 AND m.starts_at >= ?
          ORDER BY m.starts_at ASC LIMIT 1`
      )
      .get(new Date().toISOString()),

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
  nextUnified: (from = new Date()) => {
    const candidates = [];

    const oneOff = meetings.next();
    if (oneOff) {
      candidates.push({
        ...oneOff,
        is_recurring: false,
        recurring_id: null,
        local_date: dates.localDateKey(oneOff.starts_at),
        overridden: false,
      });
    }

    for (const rule of recurring.listActive()) {
      const occ = recurring.nextOccurrence(rule, from);
      if (!occ) continue;
      candidates.push(
        recurring.asMeeting(rule, occ, {
          override: hosts.override(rule.id, occ.local_date),
          host: hosts.forOccurrence(rule.id, occ.local_date),
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

  upcoming: (limit = 50) =>
    db
      .prepare(
        `${MEETING_SELECT}
          WHERE m.deleted_at IS NULL AND m.starts_at >= ?
          ORDER BY m.starts_at ASC LIMIT ?`
      )
      .all(new Date().toISOString(), limit),

  /**
   * The landing page's "special events" list: every future, non-cancelled
   * one-off meeting (R. House or off-site) EXCEPT `excludeId` — the meeting
   * already shown as the next-session card, so nothing appears twice on the
   * page. Weekly sessions never appear here; they are the staples, not a
   * special event, and live in `recurring`.
   *
   * PRIVACY: this returns raw rows, same as `upcoming`/`next`. A caller
   * rendering to a logged-out visitor must still map each row through
   * `meetings.publicSafe` before it reaches a template — this helper does not
   * do that itself, so it stays a plain read like its siblings.
   */
  upcomingSpecial: (limit = 20, excludeId = null) =>
    db
      .prepare(
        `${MEETING_SELECT}
          WHERE m.deleted_at IS NULL AND m.is_cancelled = 0 AND m.starts_at >= @now
            AND (@excludeId IS NULL OR m.id != @excludeId)
          ORDER BY m.starts_at ASC LIMIT @limit`
      )
      .all({ now: new Date().toISOString(), excludeId: excludeId || null, limit }),

  past: (limit = 20) =>
    db
      .prepare(
        `${MEETING_SELECT}
          WHERE m.deleted_at IS NULL AND m.starts_at < ?
          ORDER BY m.starts_at DESC LIMIT ?`
      )
      .all(new Date().toISOString(), limit),
  byId: (id) => db.prepare(`SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL`).get(id),
  /** byId plus the host's display name — what the admin form and /host render. */
  byIdWithHost: (id) =>
    db.prepare(`${MEETING_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`).get(id),
  create: (m) =>
    db
      .prepare(
        `INSERT INTO meetings (starts_at, title, notes, location_label, map_x, map_y,
                               is_cancelled, kind, address, body_html, body_md, host_user_id, created_by)
         VALUES (@starts_at, @title, @notes, @location_label, @map_x, @map_y,
                 @is_cancelled, @kind, @address, @body_html, @body_md, @host_user_id, @created_by)`
      )
      .run(m),
  update: (m) =>
    db
      .prepare(
        `UPDATE meetings SET starts_at = @starts_at, title = @title, notes = @notes,
                location_label = @location_label, map_x = @map_x, map_y = @map_y,
                is_cancelled = @is_cancelled, kind = @kind, address = @address,
                body_html = @body_html, body_md = @body_md, host_user_id = @host_user_id,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @id`
      )
      .run(m),

  /**
   * The narrow update a session HOST is allowed to make to a one-off meeting:
   * when it starts, where in the room, the pin, and a note. Never the title,
   * never the kind, never the address, never who is hosting — those stay with
   * the leaders. Server-side twin of the fields /host/meeting/:id renders.
   */
  updateByHost: (m) =>
    db
      .prepare(
        `UPDATE meetings SET starts_at = @starts_at, location_label = @location_label,
                map_x = @map_x, map_y = @map_y, notes = @notes,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @id`
      )
      .run(m),

  setHost: (id, userId) =>
    db
      .prepare(
        `UPDATE meetings SET host_user_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .run(userId || null, id),
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
   */
  asMeeting: (rule, occ, { override = null, host = null } = {}) => {
    const time = (override && override.time_hhmm) || rule.time_hhmm;
    const starts_at =
      override && override.time_hhmm
        ? dates.localInputToUtcIso(`${occ.local_date}T${override.time_hhmm}`) || occ.starts_at
        : occ.starts_at;
    const pick = (key) => (override && override[key] !== null && override[key] !== undefined
      ? override[key]
      : rule[key]);

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
 * UNASSIGN SEMANTICS (decided here, documented in the leader handbook):
 * removing a weekly host DELETES that date's overrides too. The overrides exist
 * because a particular person was running that day; with them gone the
 * occurrence should read exactly like the rule again, rather than quietly
 * keeping a pin nobody remembers moving. REASSIGNING to a different member
 * keeps them — the session's arrangements stand and the new host can adjust
 * them. A one-off has no override row: unassigning leaves the leader-visible
 * fields exactly as they are, because those fields were always the leaders'.
 */

const hosts = {
  /* ---- weekly occurrences ---- */

  forOccurrence: (recurringId, localDate) =>
    db
      .prepare(
        `SELECT oh.id, oh.recurring_id, oh.local_date, oh.user_id, u.display_name, u.username
           FROM occurrence_hosts oh JOIN users u ON u.id = oh.user_id
          WHERE oh.recurring_id = ? AND oh.local_date = ?`
      )
      .get(recurringId, localDate),

  /** Assignments for one rule, today onward — what the weekly admin row lists. */
  forRule: (recurringId, fromLocalDate = dates.localDateKey(new Date())) =>
    db
      .prepare(
        `SELECT oh.id, oh.recurring_id, oh.local_date, oh.user_id, u.display_name, u.username
           FROM occurrence_hosts oh JOIN users u ON u.id = oh.user_id
          WHERE oh.recurring_id = ? AND oh.local_date >= ?
          ORDER BY oh.local_date ASC`
      )
      .all(recurringId, fromLocalDate),

  assign: (recurringId, localDate, userId, byUserId) =>
    db
      .prepare(
        `INSERT INTO occurrence_hosts (recurring_id, local_date, user_id, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (recurring_id, local_date)
           DO UPDATE SET user_id = excluded.user_id, created_by = excluded.created_by`
      )
      .run(recurringId, localDate, userId, byUserId),

  /** Remove a host from a date — and, with them, that date's overrides. */
  unassign: db.transaction((recurringId, localDate) => {
    db.prepare('DELETE FROM occurrence_hosts WHERE recurring_id = ? AND local_date = ?').run(
      recurringId,
      localDate
    );
    db.prepare('DELETE FROM occurrence_overrides WHERE recurring_id = ? AND local_date = ?').run(
      recurringId,
      localDate
    );
  }),

  override: (recurringId, localDate) =>
    db
      .prepare('SELECT * FROM occurrence_overrides WHERE recurring_id = ? AND local_date = ?')
      .get(recurringId, localDate),

  saveOverride: (o) =>
    db
      .prepare(
        `INSERT INTO occurrence_overrides
           (recurring_id, local_date, time_hhmm, location_label, map_x, map_y, notes, updated_by, updated_at)
         VALUES (@recurring_id, @local_date, @time_hhmm, @location_label, @map_x, @map_y, @notes,
                 @updated_by, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (recurring_id, local_date) DO UPDATE SET
           time_hhmm = excluded.time_hhmm, location_label = excluded.location_label,
           map_x = excluded.map_x, map_y = excluded.map_y, notes = excluded.notes,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(o),

  /* ---- "am I hosting anything?" ---- */

  HOST_WINDOW_DAYS: 30,

  /**
   * One prepared statement, one row, no joins: does this member have any
   * hosting assignment between the start of today (Baltimore) and 30 days out?
   * This is what loadUser calls per request to publish res.locals.isHost, so it
   * has to stay this cheap.
   */
  hasUpcoming: (userId, days = 30) => {
    const today = dates.localDateKey(new Date());
    const until = dates.addLocalDays(today, days);
    const floorIso = dates.localInputToUtcIso(`${today}T00:00`) || new Date().toISOString();
    const untilIso = dates.localInputToUtcIso(`${until}T23:59`) || floorIso;
    const row = db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM occurrence_hosts
                    WHERE user_id = @uid AND local_date >= @today AND local_date <= @until)
           OR
           EXISTS (SELECT 1 FROM meetings
                    WHERE host_user_id = @uid AND deleted_at IS NULL AND is_cancelled = 0
                      AND starts_at >= @floorIso AND starts_at <= @untilIso) AS yes`
      )
      .get({ uid: userId, today, until, floorIso, untilIso });
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
  upcomingForUser: (userId, days = 30) => {
    const today = dates.localDateKey(new Date());
    const until = dates.addLocalDays(today, days);
    const out = [];

    const assignments = db
      .prepare(
        `SELECT oh.recurring_id, oh.local_date, r.weekday, r.time_hhmm, r.title,
                r.location_label, r.map_x, r.map_y, r.notes, r.is_active
           FROM occurrence_hosts oh JOIN recurring_meetings r ON r.id = oh.recurring_id
          WHERE oh.user_id = ? AND oh.local_date >= ? AND oh.local_date <= ?
          ORDER BY oh.local_date ASC`
      )
      .all(userId, today, until);

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
      const override = hosts.override(a.recurring_id, a.local_date);
      const starts_at = dates.localInputToUtcIso(
        `${a.local_date}T${(override && override.time_hhmm) || a.time_hhmm}`
      );
      const shaped = recurring.asMeeting(rule, { local_date: a.local_date, starts_at }, { override });
      out.push({
        ...shaped,
        type: 'recurring',
        editPath: `/host/recurring/${a.recurring_id}/${a.local_date}`,
        paused: !a.is_active,
        skipped: !!db
          .prepare('SELECT 1 AS y FROM recurring_skips WHERE recurring_id = ? AND skip_date = ?')
          .get(a.recurring_id, a.local_date),
      });
    }

    const floorIso = dates.localInputToUtcIso(`${today}T00:00`) || new Date().toISOString();
    const untilIso = dates.localInputToUtcIso(`${until}T23:59`) || floorIso;
    const oneOffs = db
      .prepare(
        `${MEETING_SELECT}
          WHERE m.host_user_id = ? AND m.deleted_at IS NULL
            AND m.starts_at >= ? AND m.starts_at <= ?
          ORDER BY m.starts_at ASC`
      )
      .all(userId, floorIso, untilIso);

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
 * Rows only. The bytes live under DATA_DIR/uploads/events/<meeting_id>/ (see
 * src/services/events/paths.js) and leave only through the members-only stream
 * in src/routes/events.js.
 */

const eventFiles = {
  forMeeting: (meetingId) =>
    db
      .prepare(
        `SELECT id, meeting_id, original_name, stored_name, mime, size, created_at
           FROM event_attachments WHERE meeting_id = ? ORDER BY id ASC`
      )
      .all(meetingId),
  byId: (id, meetingId) =>
    db
      .prepare('SELECT * FROM event_attachments WHERE id = ? AND meeting_id = ?')
      .get(id, meetingId),
  count: (meetingId) =>
    db.prepare('SELECT COUNT(*) AS n FROM event_attachments WHERE meeting_id = ?').get(meetingId).n,
  create: (a) =>
    db
      .prepare(
        `INSERT INTO event_attachments (meeting_id, original_name, stored_name, mime, size)
         VALUES (@meeting_id, @original_name, @stored_name, @mime, @size)`
      )
      .run(a),
  remove: (id, meetingId) =>
    db.prepare('DELETE FROM event_attachments WHERE id = ? AND meeting_id = ?').run(id, meetingId),
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

/* ---------------- about (front-page "The Collective" copy) ---------------- *
 *
 * One markdown blob in the settings key/value table (001 already has the
 * table; this needed no migration). `getMd` bootstraps the default the FIRST
 * time anything asks for it — landing page or /admin/about, whichever loads
 * first after a fresh install — and is otherwise a plain read. Idempotent by
 * construction: it only ever writes when the key is missing, so a leader's
 * saved copy is never clobbered by a later boot or request.
 */

const ABOUT_KEY = 'about_md';

const ABOUT_DEFAULT_MD = `The Agile Fiction Writers Collective is a Baltimore fiction-writers' group
built around timed writing sprints. We meet at R. House in Remington, sit down
together, and write — for a stretch, then stop, talk about how it went, and go
again. Everyone works on their own project; there's no assigned reading and no
round-robin critique.

All genres and formats are welcome: novels, short stories, screenplays, even
graphic novels. Bring a laptop, a notebook, whatever gets the words down.

We grew out of a Meetup group and kept the informal, drop-in spirit. Sharing a
draft is a door, not a requirement — open it in the library whenever a piece
feels ready, never before. New writers are welcome any week; just show up.`;

const about = {
  /** The current markdown, seeding the default on first read. */
  getMd: () => {
    const existing = getSetting(ABOUT_KEY);
    if (existing !== null) return existing;
    setSetting(ABOUT_KEY, ABOUT_DEFAULT_MD);
    return ABOUT_DEFAULT_MD;
  },
  setMd: (md) => setSetting(ABOUT_KEY, md),
};

/* ---------------- quotes (leader-adjustable landing quote rail) ---------------- *
 *
 * A handful of short quotes a leader curates from /admin/quotes. One shows on
 * the landing page at a time — see quotes.ofDay below — picked the same way
 * for everyone on a given day so it reads as a single daily moment rather
 * than a per-visitor random draw.
 */

const QUOTE_SEED = {
  text: 'Not all those who wander are lost',
  attribution: 'J.R.R. Tolkien',
  source_note: 'The Fellowship of the Ring',
};

/**
 * Baltimore-local day-of-year (0-indexed), so the rotation flips over at
 * local midnight rather than UTC midnight — consistent with how every other
 * "today" in this app is decided (src/util/dates.js's localDateKey).
 */
function localDayOfYear(when) {
  const key = dates.localDateKey(when);
  const [y, m, d] = key.split('-').map(Number);
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, d);
  return Math.floor((cur - start) / 86400000);
}

const quotes = {
  /**
   * Idempotent bootstrap, same shape as about.getMd: insert the one starter
   * quote ONLY when the table is empty, so a leader's own edits (including
   * deleting the seed) are never clobbered by a later boot or request.
   */
  ensureSeed: () => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM quotes').get();
    if (n > 0) return false;
    quotes.create({
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
  list: () => {
    quotes.ensureSeed();
    return db.prepare('SELECT * FROM quotes ORDER BY sort_order ASC, id ASC').all();
  },

  /** Active quotes only, in display order — the rotation pool. */
  active: () => {
    quotes.ensureSeed();
    return db.prepare('SELECT * FROM quotes WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all();
  },

  byId: (id) => db.prepare('SELECT * FROM quotes WHERE id = ?').get(id),

  create: (q) =>
    db
      .prepare(
        `INSERT INTO quotes (text, attribution, source_note, is_active, sort_order, created_by)
         VALUES (@text, @attribution, @source_note, @is_active, @sort_order, @created_by)`
      )
      .run(q),

  update: (q) =>
    db
      .prepare(
        `UPDATE quotes SET text = @text, attribution = @attribution, source_note = @source_note,
                sort_order = @sort_order
          WHERE id = @id`
      )
      .run(q),

  setActive: (id, active) => db.prepare('UPDATE quotes SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id),

  remove: (id) => db.prepare('DELETE FROM quotes WHERE id = ?').run(id),

  /**
   * The landing page's quote of the day: a deterministic pick among active
   * quotes, indexed by day-of-year modulo the pool size, so every visitor
   * sees the same one on the same day and it steps forward on its own with
   * no scheduler and no JS. Null when nothing is active — the landing page
   * renders no quote section at all rather than an empty one.
   */
  ofDay: (when = new Date()) => {
    const pool = quotes.active();
    if (!pool.length) return null;
    return pool[localDayOfYear(when) % pool.length];
  },
};

/* ---------------- drafts (cross-router reads only — see src/routes/drafts.js
   for the library query, upload and moderation, which stay route-local) ---------------- *
 *
 * The landing page needs two small reads that belong to no single router:
 * a members-only "fresh pages" preview and a logged-out teaser count that
 * leaks nothing but a number. Both are READY, non-deleted drafts only — a
 * still-converting or failed upload is not "shared" yet.
 */

const drafts = {
  /** Newest ready drafts, newest first — the landing page's members-only preview. */
  recent: (limit = 3) =>
    db
      .prepare(
        `SELECT d.id, d.title, d.kind, d.created_at, d.author_name, u.display_name AS uploader_name
           FROM drafts d JOIN users u ON u.id = d.user_id
          WHERE d.deleted_at IS NULL AND d.status = 'ready'
          ORDER BY d.created_at DESC LIMIT ?`
      )
      .all(limit),

  /** Count of ready drafts — the logged-out teaser's number. No titles, no names. */
  countAll: () =>
    db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE deleted_at IS NULL AND status = 'ready'`).get().n,
};

module.exports = { users, meetings, recurring, announcements, hosts, eventFiles, about, quotes, drafts };
