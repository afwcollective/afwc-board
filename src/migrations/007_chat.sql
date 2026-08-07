-- 007 — Chat: #general, project subgroups, and private one-to-one messages.
--
-- Three surfaces, ONE table of channels, told apart by `kind`:
--
--   'general'  exactly one row, seeded at boot by src/routes/chat.js
--              (ensureGeneralChannel). Every active member is in it by
--              construction — there are deliberately NO chat_members rows for
--              it, because "everyone" is not a list that can drift out of date
--              when somebody registers or is booted.
--   'group'    a project subgroup any member can create ("Sci-fi crew").
--              Membership IS a list here: chat_members decides who can read the
--              messages. Non-members see only the name and the one-line
--              description in the joinable list.
--   'dm'       a private conversation between exactly two members. The two
--              chat_members rows are the whole access-control story: there is
--              no leader override anywhere in src/routes/chat.js, and no admin
--              view lists DM contents. A leader who needs to act on what
--              somebody is sending in a DM deactivates the account
--              (/admin/members) — that is the moderation tool, not reading.
--
-- pair_key — canonical identity of a DM pair, 'dm:<lowId>:<highId>', UNIQUE so
--   the database itself refuses a second conversation between the same two
--   people no matter how many browser tabs race. NULL for 'general'/'group',
--   and SQLite allows any number of NULLs in a UNIQUE column, so one index
--   covers both cases. The route still does find-then-create; the constraint is
--   what makes that safe rather than merely likely.
--
-- Messages carry the same soft-delete pair as posts/comments (deleted_at,
-- deleted_by) so a removed line keeps its slot in the transcript. Attachments
-- hang off the message and are served ONLY through GET /chat/files/:id, which
-- re-checks channel access on every byte — uploads/ is never static.

CREATE TABLE chat_channels (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('general','group','dm')),
  name        TEXT,
  description TEXT,
  pair_key    TEXT UNIQUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT,
  archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE chat_members (
  id         INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel_id, user_id)
);
-- "which channels is this person in" runs on every page load of /chat.
CREATE INDEX idx_chat_members_user ON chat_members(user_id);

CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- may be '' when the message is nothing but an attachment
  body_html  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- The transcript is always read by channel in id order, and the 20s poll asks
-- for MAX(id) of one channel; this index answers both.
CREATE INDEX idx_chat_messages_channel ON chat_messages(channel_id, id);

CREATE TABLE chat_attachments (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  -- file name on disk under DATA_DIR/uploads/chat/<channel_id>/<message_id>/
  stored_name   TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_chat_attachments_message ON chat_attachments(message_id);
