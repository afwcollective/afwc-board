-- AFWC Board — initial schema.
-- All timestamps are ISO-8601 UTC strings ("2026-08-10T22:30:00.000Z") so plain
-- string comparison is chronological. Display formatting happens in
-- src/util/dates.js (America/New_York).
-- Content tables carry deleted_at/deleted_by for leader soft-delete moderation.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name    TEXT NOT NULL,
  email           TEXT,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','leader')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  reset_code_hash TEXT,
  reset_expires_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at   TEXT
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);

CREATE TABLE meetings (
  id             INTEGER PRIMARY KEY,
  starts_at      TEXT NOT NULL,
  title          TEXT,
  notes          TEXT,
  location_label TEXT,
  -- marker position as PERCENT of the floor-map SVG viewBox, so the map can be
  -- redrawn later without invalidating saved markers.
  map_x          REAL,
  map_y          REAL,
  is_cancelled   INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT,
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_meetings_starts ON meetings(starts_at);

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

CREATE TABLE comments (
  id          INTEGER PRIMARY KEY,
  draft_id    INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body_html   TEXT NOT NULL,
  body_md     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT,
  deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_comments_page ON comments(draft_id, page_number, created_at);
