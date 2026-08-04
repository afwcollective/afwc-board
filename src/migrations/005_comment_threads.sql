-- 005 — Office-style threaded review comments.
--
-- Page comments were a flat list: one row per note, anchored to a page. This
-- turns them into THREADS, the way a review pane in Word behaves — someone
-- leaves a comment, other people reply underneath it, and whoever owns the
-- draft marks the whole conversation resolved when it has been dealt with.
--
-- Three columns, all nullable, all added in place. Like 004 this needs no
-- table-rebuild dance: ALTER TABLE … ADD COLUMN accepts a REFERENCES clause as
-- long as the column defaults to NULL, which every one of these does. The
-- runner (src/db.js) runs PRAGMA foreign_key_check before COMMIT, so a bad
-- reference rolls the whole migration back rather than shipping.
--
-- parent_id — NULL = this row STARTS a thread and carries the page anchor.
--   NOT NULL = this row is a reply and belongs to the thread whose first
--   comment is parent_id. Exactly ONE level of nesting is allowed, and the
--   rule is enforced in src/routes/reader.js rather than in the schema
--   (SQLite cannot express "the parent's own parent_id must be NULL" as a
--   CHECK): replying to a reply attaches to the same top-level comment, which
--   is what a review pane does. A reply's page_number is copied from its
--   parent on insert, so per-page queries keep working unchanged and a reply
--   can never drift onto a different page than the note it answers.
--
-- resolved_at / resolved_by — set together, cleared together. Non-NULL means
--   the thread is settled: it collapses to one muted line, sinks below the
--   open threads, and refuses new replies until somebody reopens it. Only
--   meaningful on a top-level row; a reply never carries either.
--
-- Soft delete (deleted_at/deleted_by, from 001) is untouched and still
-- author-or-leader. A removed top-level comment whose replies survive is
-- rendered as "Comment removed" so the thread beneath it stays readable; a
-- removed comment with no surviving replies simply disappears.

ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id);
ALTER TABLE comments ADD COLUMN resolved_at TEXT;
ALTER TABLE comments ADD COLUMN resolved_by INTEGER REFERENCES users(id);

-- Replies are always fetched by thread, and the per-page pane fetches every
-- reply on a draft in one statement, so the parent is the hot lookup.
CREATE INDEX idx_comments_parent ON comments(parent_id);

-- The pager badge counts OPEN threads per page: parent_id IS NULL AND
-- resolved_at IS NULL AND deleted_at IS NULL, grouped by page.
CREATE INDEX idx_comments_open ON comments(draft_id, page_number, parent_id, resolved_at);
