-- 003 — role tiers: member / leader / architect, plus time-boxed leadership.
--
-- SQLite cannot ALTER a CHECK constraint, so widening users.role means the
-- documented table-rebuild dance (https://sqlite.org/lang_altertable.html):
-- create the replacement table, copy every row, drop the old one, rename.
--
-- Two things make that safe here and both live in the runner (src/db.js), not
-- in this file, because PRAGMA is a no-op inside the transaction each migration
-- runs in:
--   * PRAGMA foreign_keys = OFF around the whole run, so DROP TABLE users does
--     not cascade into sessions/drafts/posts/comments/… on the way through;
--   * PRAGMA foreign_key_check before each COMMIT, so a rebuild that orphaned
--     any of the REFERENCES users(id) clauses rolls back instead of shipping.
-- The other tables name `users`, never `users_new`, so the rename does not
-- rewrite their REFERENCES clauses — they simply point at the new table.
--
-- role_expires_at: UTC ISO-8601 ("2026-08-10T22:30:00.000Z"), NULL = permanent.
-- Only meaningful while role = 'leader': a leader whose expiry has passed is
-- demoted to member by the sweep in src/db.js (boot) and in loadUser
-- (src/auth/middleware.js, per request). 'architect' is always permanent — the
-- singular owner tier — and 'member' has nothing to expire.

CREATE TABLE users_new (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name    TEXT NOT NULL,
  email           TEXT,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('member','leader','architect')),
  role_expires_at TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  reset_code_hash TEXT,
  reset_expires_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at   TEXT
);

INSERT INTO users_new
  (id, username, display_name, email, password_hash, role, role_expires_at,
   is_active, reset_code_hash, reset_expires_at, created_at, last_login_at)
SELECT
   id, username, display_name, email, password_hash, role, NULL,
   is_active, reset_code_hash, reset_expires_at, created_at, last_login_at
  FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
