-- AFWC Board on D1 — initial schema.
--
-- This is a SQUASH of the Express app's src/migrations/001–005 into the final
-- shape those five produce. No production data exists on Cloudflare yet, so
-- there is no upgrade path to preserve: 003's users table-rebuild dance and
-- 004/005's ALTER TABLE … ADD COLUMN steps are simply folded into the CREATE
-- statements. The two schemas must stay column-for-column identical; a future
-- change belongs in a NEW worker/migrations/000N_*.sql and a matching
-- src/migrations/00N_*.sql, never in an edit to either of these files.
--
-- Conventions carried over unchanged:
--   * every timestamp column is an ISO-8601 UTC string, so plain string
--     comparison is chronological (display formatting: worker/src/util/dates.js)
--   * content tables carry deleted_at/deleted_by for leader soft-delete
--   * map_x / map_y are PERCENTAGES of the floor-map SVG viewBox, so the
--     drawing can be redrawn without invalidating saved markers
--   * recurring times are LOCAL Baltimore wall-clock ("13:00"), never UTC

/* ------------------------------------------------------------------ users --
 * Final shape from 003: the role CHECK is widened to three tiers and
 * role_expires_at carries a time-boxed leader's term (UTC ISO, NULL =
 * permanent, only meaningful while role = 'leader').
 */
CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  username         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name     TEXT NOT NULL,
  email            TEXT,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member'
                     CHECK (role IN ('member','leader','architect')),
  role_expires_at  TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  reset_code_hash  TEXT,
  reset_expires_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at    TEXT
);

/* --------------------------------------------------------------- sessions -- */
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

/* --------------------------------------------------------------- settings -- */
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);

/* --------------------------------------------------------------- meetings --
 * Final shape from 001 + 004. kind/address/body_html/body_md/host_user_id are
 * the off-site-event and session-host columns 004 added in place.
 *
 * PRIVACY: address and body_html are MEMBERS-ONLY when kind = 'offsite'. The
 * rule is enforced in the query layer (meetings.publicSafe), not the schema.
 */
CREATE TABLE meetings (
  id             INTEGER PRIMARY KEY,
  starts_at      TEXT NOT NULL,
  title          TEXT,
  notes          TEXT,
  location_label TEXT,
  map_x          REAL,
  map_y          REAL,
  is_cancelled   INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'rhouse' CHECK (kind IN ('rhouse','offsite')),
  address        TEXT,
  body_html      TEXT,
  body_md        TEXT,
  host_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT,
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_meetings_starts ON meetings(starts_at);

/* --------------------------------------------- off-site event attachments --
 * Rows only. The bytes live in R2 under uploads/events/<meeting_id>/<stored_name>
 * and leave only through the members-only stream in the events router.
 */
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

/* ---------------------------------------------------------- announcements -- */
CREATE TABLE announcements (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  body_md    TEXT,
  is_pinned  INTEGER NOT NULL DEFAULT 0,
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_announcements_sort ON announcements(is_pinned DESC, created_at DESC);

/* ----------------------------------------------------------------- drafts -- */
CREATE TABLE drafts (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('docx','pdf','images','text')),
  status            TEXT NOT NULL DEFAULT 'processing'
                      CHECK (status IN ('processing','ready','failed')),
  error_msg         TEXT,
  page_count        INTEGER NOT NULL DEFAULT 0,
  original_filename TEXT,
  original_path     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT,
  deleted_at        TEXT,
  deleted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_drafts_created ON drafts(created_at DESC);

CREATE TABLE draft_pages (
  id           INTEGER PRIMARY KEY,
  draft_id     INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  page_number  INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('html','pdf_page','image')),
  content_html TEXT,
  file_path    TEXT,
  width        INTEGER,
  height       INTEGER,
  heading      TEXT
);
CREATE UNIQUE INDEX idx_draft_pages_unique ON draft_pages(draft_id, page_number);

/* --------------------------------------------------------- board: threads -- */
CREATE TABLE threads (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  draft_id     INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  is_locked    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_post_at TEXT,
  deleted_at   TEXT,
  deleted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_threads_activity ON threads(is_pinned DESC, last_post_at DESC);
CREATE INDEX idx_threads_draft ON threads(draft_id);

CREATE TABLE posts (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body_html  TEXT NOT NULL,
  body_md    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_posts_thread ON posts(thread_id, created_at);

/* ------------------------------------------------- draft comments (001+005) --
 * parent_id NULL = this row starts a thread and carries the page anchor;
 * NOT NULL = a reply. Exactly one level of nesting, enforced in the route
 * (SQLite cannot express "the parent's parent must be NULL" as a CHECK).
 * resolved_at/resolved_by are set and cleared together, top-level rows only.
 */
CREATE TABLE comments (
  id          INTEGER PRIMARY KEY,
  draft_id    INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body_html   TEXT NOT NULL,
  body_md     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT,
  deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id   INTEGER REFERENCES comments(id),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_comments_page ON comments(draft_id, page_number, created_at);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_open ON comments(draft_id, page_number, parent_id, resolved_at);

/* ------------------------------------------------ recurring weekly rules -- */
CREATE TABLE recurring_meetings (
  id             INTEGER PRIMARY KEY,
  -- 0 = Sunday … 6 = Saturday, matching JS getDay() and Intl weekday order.
  weekday        INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- "HH:MM" local Baltimore wall-clock, 24-hour.
  time_hhmm      TEXT NOT NULL,
  title          TEXT NOT NULL,
  location_label TEXT,
  map_x          REAL,
  map_y          REAL,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_recurring_active ON recurring_meetings(is_active);

-- One row = "the occurrence of this rule on this LOCAL date does not happen."
CREATE TABLE recurring_skips (
  id           INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_meetings(id) ON DELETE CASCADE,
  skip_date    TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (recurring_id, skip_date)
);

/* ---------------------------------------------------------- session hosts -- */
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

-- What the host changed about their one occurrence. Every column optional:
-- NULL means "use the rule's value". Deleted along with the assignment.
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

/* ------------------------------------------------------------ rate limits --
 * NEW IN THE PORT. src/util/ratelimit.js kept its login/reset buckets in a
 * process-local Map, which works for one long-lived Node process and not at all
 * for Workers: every request may land on a different isolate, and isolates are
 * evicted between requests. The bucket therefore moves into D1 with the same
 * semantics — 10 failures per 15 minutes, keyed by IP + username, cleared on
 * success. `reset_at` is epoch milliseconds (an integer, so the sweep is an
 * index scan rather than a string compare).
 */
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_at);
