-- 0002 — quotes + chat, the two tables 0001 could not know about.
--
-- worker/migrations/0001_init.sql is a SQUASH of src/migrations/001–005, taken
-- at the moment the port began. The Express app has moved on twice since:
--   src/migrations/006_quotes.sql  the landing page's quote rail
--   src/migrations/007_chat.sql    #general, project groups, private DMs
-- Neither table existed in the squash, so this migration adds both, verbatim
-- from those two files. The rule from 0001 still stands: the two schemas must
-- stay column-for-column identical, and a future change belongs in a NEW
-- worker/migrations/000N_*.sql beside a matching src/migrations/00N_*.sql.
--
-- The quotes half is used from this phase (P2, /admin/quotes and the landing
-- rail). The chat half is dead weight until P3/P4 port src/routes/chat.js —
-- it lands NOW rather than later so that every later phase, and every local
-- database seeded from here on, already carries the final shape and nobody has
-- to re-migrate a database that has real rows in it.

/* =========================================================== 006 — quotes ==
 *
 * One short quote on the landing page, leader-editable, same spirit as the
 * about_md blob: a handful of rows a leader curates from /admin/quotes rather
 * than a developer editing a template. Unlike about_md this needed a real
 * table — there can be more than one quote, and a leader retires or reorders
 * them without losing the others.
 *
 * is_active   — deactivated quotes stay in the table (so nothing is lost by
 *   accident) but never appear in rotation.
 * sort_order  — a leader-set integer, lower first, ties broken by id. There
 *   is no drag-and-drop; the admin page reorders by editing the number, which
 *   is plenty for a handful of quotes.
 * created_by  — nullable: the bootstrap seed has no user behind it.
 *
 * Rotation itself (deterministic "quote of the day", same for every visitor
 * on a given date) is application logic in worker/src/models.js, not a schema
 * concern — there is nothing here that picks the quote.
 */

CREATE TABLE quotes (
  id           INTEGER PRIMARY KEY,
  text         TEXT NOT NULL,
  attribution  TEXT NOT NULL,
  source_note  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The landing page and the admin list both read "active ones, in order."
CREATE INDEX idx_quotes_active_order ON quotes(is_active, sort_order, id);

-- Seeding the one starter quote happens in worker/src/models.js
-- (quotes.ensureSeed), bootstrapped on first read exactly like about_md —
-- idempotent, and never fighting a leader's own edits on a later request. Not
-- done here: a migration that inserts content, rather than shape, is a
-- migration you can't safely re-run or reason about. (The dev seed script,
-- worker/build/seed.mjs, inserts the same row up front so a freshly seeded
-- local board shows the rail without a first-read write.)

/* ============================================================= 007 — chat ==
 *
 * Three surfaces, ONE table of channels, told apart by `kind`:
 *
 *   'general'  exactly one row, seeded on first use by the chat router
 *              (ensureGeneralChannel). Every active member is in it by
 *              construction — there are deliberately NO chat_members rows for
 *              it, because "everyone" is not a list that can drift out of date
 *              when somebody registers or is booted.
 *   'group'    a project subgroup any member can create ("Sci-fi crew").
 *              Membership IS a list here: chat_members decides who can read the
 *              messages. Non-members see only the name and the one-line
 *              description in the joinable list.
 *   'dm'       a private conversation between exactly two members. The two
 *              chat_members rows are the whole access-control story: there is
 *              no leader override anywhere in the chat router, and no admin
 *              view lists DM contents. A leader who needs to act on what
 *              somebody is sending in a DM deactivates the account
 *              (/admin/members) — that is the moderation tool, not reading.
 *
 * pair_key — canonical identity of a DM pair, 'dm:<lowId>:<highId>', UNIQUE so
 *   the database itself refuses a second conversation between the same two
 *   people no matter how many browser tabs race. NULL for 'general'/'group',
 *   and SQLite allows any number of NULLs in a UNIQUE column, so one index
 *   covers both cases. The route still does find-then-create; the constraint is
 *   what makes that safe rather than merely likely.
 *
 * Messages carry the same soft-delete pair as posts/comments (deleted_at,
 * deleted_by) so a removed line keeps its slot in the transcript. Attachments
 * hang off the message and are served ONLY through GET /chat/files/:id, which
 * re-checks channel access on every byte — R2 is never public.
 */

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
  -- object name under the R2 key prefix chat/<channel_id>/<message_id>/
  stored_name   TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_chat_attachments_message ON chat_attachments(message_id);
