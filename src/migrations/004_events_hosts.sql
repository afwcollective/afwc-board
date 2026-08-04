-- 004 — off-site events and session hosts.
--
-- Two features, one migration, because they meet in the same place: a single
-- meeting (a one-off row, or one date of a weekly rule) grows a HOST and, if it
-- happens somewhere other than R. House, an ADDRESS and a members-only body.
--
-- SQLite note: unlike 003 (which had to rebuild `users` to widen a CHECK), this
-- migration needs no table-rebuild dance. ALTER TABLE … ADD COLUMN accepts both
-- a CHECK constraint and a REFERENCES clause; the only rules are that a NOT NULL
-- column needs a non-NULL default and a REFERENCES column defaults to NULL, and
-- both hold here. The CHECK on `kind` is therefore real, enforced by the engine
-- on every write, and not merely an app-level convention.

/* ---------------------------------------------------------------- meetings */

-- 'rhouse'  — the usual thing: R. House, a table on the floor map, public.
-- 'offsite' — a leader's home or another venue. address/body_html/attachments
--             are MEMBERS-ONLY (see src/routes/public.js and views/home.ejs);
--             the public front page shows only title + date/time + a teaser.
ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'rhouse'
  CHECK (kind IN ('rhouse','offsite'));

-- Street address of an off-site event. Never rendered to a logged-out visitor.
ALTER TABLE meetings ADD COLUMN address TEXT;

-- Sanitized markdown details for an off-site event (parking, what to bring,
-- the door code). Members only, same rule as address.
ALTER TABLE meetings ADD COLUMN body_html TEXT;
-- The markdown source, kept so the edit form round-trips what the leader typed
-- rather than a de-sanitized approximation of it. Same convention as
-- announcements.body_md.
ALTER TABLE meetings ADD COLUMN body_md TEXT;

-- The member running this one meeting. A host is per-occurrence, never a rank:
-- one-off meetings point at the user here, weekly occurrences go through
-- occurrence_hosts below. NULL = nobody assigned (the usual case).
ALTER TABLE meetings ADD COLUMN host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

/* --------------------------------------------------- off-site attachments */

-- Files a leader attaches to an off-site event: a flyer, a map screenshot, a
-- menu. MEMBERS-ONLY, streamed one at a time through
-- GET /events/:meetingId/files/:attachmentId — DATA_DIR/uploads/events is never
-- a static directory, exactly like uploads/drafts.
--
--   DATA_DIR/uploads/events/<meeting_id>/<stored_name>
--
-- stored_name is a generated, extension-only-from-us filename; original_name is
-- what the leader's computer called it and is only ever shown as text.
CREATE TABLE event_attachments (
  id            INTEGER PRIMARY KEY,
  meeting_id    INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  original_name TEXT,
  stored_name   TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_event_attachments_meeting ON event_attachments(meeting_id);

/* -------------------------------------------------------- session hosts */

-- "This member is running the <local_date> occurrence of weekly rule N."
-- local_date is the Baltimore calendar date the occurrence generator hands back
-- ("YYYY-MM-DD"), the same key recurring_skips uses — so a host and a skip
-- always name a date the same way.
CREATE TABLE occurrence_hosts (
  id           INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_meetings(id) ON DELETE CASCADE,
  local_date   TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (recurring_id, local_date)
);
CREATE INDEX idx_occurrence_hosts_user ON occurrence_hosts(user_id, local_date);

-- What the host changed about their one occurrence. Every column is optional:
-- NULL means "use the rule's value". Nothing here can change the rule itself,
-- and nothing here survives the host being unassigned — see hosts.unassign() in
-- src/models.js, which deletes the override row along with the assignment.
CREATE TABLE occurrence_overrides (
  id             INTEGER PRIMARY KEY,
  recurring_id   INTEGER NOT NULL REFERENCES recurring_meetings(id) ON DELETE CASCADE,
  local_date     TEXT NOT NULL,
  time_hhmm      TEXT,
  location_label TEXT,
  map_x          REAL,
  map_y          REAL,
  notes          TEXT,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (recurring_id, local_date)
);
