-- 0003 — the file store moves INTO the database.
--
-- WHY THIS EXISTS. Everything this app stores that is not text — draft
-- originals and page images, off-site event attachments, chat attachments —
-- lived in R2 through P4/P5. R2's free tier is generous (10 GB, no egress
-- fee), but enabling R2 on a Cloudflare account requires a payment method on
-- file even when the bill will always be $0. The group's account is owned by a
-- shared mailbox and passed on with it; "a card belonging to whoever is
-- currently holding the mailbox" is not a thing this project can inherit
-- cleanly, and being asked for one is exactly the kind of friction that makes
-- a volunteer board quietly die. D1's 5 GB free tier needs no card at all.
--
-- So the bytes come home: they are rows now, and the whole app has exactly one
-- storage backend. See worker/src/services/filestore.js for the module that
-- owns them and PORT-CLOUDFLARE.md §4 for what this supersedes.
--
-- WHAT THAT COSTS, honestly: SQLite (and therefore D1) has a per-row ceiling,
-- so a file cannot be one row. It is chunked — CHUNK_BYTES in filestore.js,
-- 1,000,000 bytes, comfortably under D1's 2 MB row limit with room for the
-- rest of the row and the query envelope around it. A 10 MB chat attachment is
-- ten rows; a range read touches only the rows that intersect the range.
--
-- The 5 GB ceiling is real but far away for a writing group whose drafts are
-- mostly sub-megabyte prose. The retention policy this migration also
-- introduces (settings.file_retention_days, swept daily by
-- worker/src/scheduled.js) is what keeps it far away: shared files are kept a
-- year, then cleaned up.

/* ------------------------------------------------------------ stored_files --
 * One row per stored file — the metadata half, and the thing rule 4 of THE
 * FILE PATTERN means by "rows own the bytes". A file is addressed by
 * (scope, ref_id, stored_name), which is the port of what used to be an R2
 * object key:
 *
 *     drafts/<draftId>/original.docx   → ('drafts', <draftId>, 'original.docx')
 *     drafts/<draftId>/pages/0001.png  → ('drafts', <draftId>, 'pages/0001.png')
 *     events/<meetingId>/<name>        → ('events', <meetingId>, '<name>')
 *     chat/<channelId>/<messageId>/<n> → ('chat',   <messageId>, '<n>')
 *
 * Chat is the one shape that lost a level: an object key needed the channel to
 * make the path unique, a row does not — chat_messages.channel_id already says
 * which channel a message is in, and the stream route re-derives access from it
 * on every request (worker/src/routes/chat.js). ref_id is therefore the MESSAGE
 * id, and nothing about the DM-privacy rule changes.
 *
 * ref_id is deliberately NOT a foreign key. The three scopes point at three
 * different tables, which SQLite cannot express in one column, and the app
 * already owns the lifecycle from both ends (an upload writes the row first and
 * unwinds on failure; a removal deletes through filestore.removeAllFor).
 *
 * created_at is what the retention sweep reads, and it is the file's OWN age,
 * not its parent row's — a chat message from 2027 carrying a re-shared file
 * expires on the file's clock.
 */
CREATE TABLE stored_files (
  id          INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('drafts','events','chat')),
  ref_id      INTEGER NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope, ref_id, stored_name)
);

/* The two ways this table is ever read that the UNIQUE index above does not
 * already answer: "everything belonging to X" (removeAllFor, and the joins that
 * decide whether an attachment chip is still live) is served by the UNIQUE
 * index's (scope, ref_id) prefix; "everything older than T" is this one. */
CREATE INDEX idx_stored_files_created ON stored_files(created_at);

/* ------------------------------------------------------------- file_chunks --
 * The bytes half. chunk_no is 0-based and contiguous; every chunk is exactly
 * CHUNK_BYTES long except the last. ON DELETE CASCADE is the whole rollback
 * story: a half-written file is undone by deleting its stored_files row, and a
 * retention purge or a removal does the same thing on purpose.
 *
 * No index beyond the primary key: (file_id, chunk_no) is exactly the lookup —
 * a range read computes the chunk numbers it needs with arithmetic and asks for
 * that closed interval, never a scan.
 */
CREATE TABLE file_chunks (
  file_id  INTEGER NOT NULL REFERENCES stored_files(id) ON DELETE CASCADE,
  chunk_no INTEGER NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (file_id, chunk_no)
);

/* ------------------------------------------------------- retention setting --
 * Shared files are kept for a year, then cleaned up automatically. A leader can
 * change the number on /admin (30..3650 days, clamped in
 * worker/src/routes/admin.js); the daily Cron Trigger reads it.
 *
 * INSERT OR IGNORE rather than INSERT: settings.key is the primary key, and a
 * migration that has to be re-runnable against a database somebody already
 * poked at by hand should not fall over on a row that is already correct.
 */
INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('file_retention_days', '365', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
