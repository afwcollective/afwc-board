-- 0005 — Replacing the file under an existing draft, safely.
--
-- /drafts/:id/edit gains a "replace the file" control: a full re-ingest that
-- throws away every converted page and builds new ones, possibly of a
-- different KIND (a Word draft can come back as a PDF). The draft keeps its
-- id, its URL, its discussion thread and its page comments.
--
-- WHY THIS NEEDS TABLES AT ALL, on this stack and not on the Express one.
-- Express converts server-side: src/services/ingest/index.js builds every page
-- in memory and commits them in ONE better-sqlite3 transaction, so "keep the
-- old pages until the new ones exist" is free — the old rows are simply not
-- touched until the last moment. The Worker cannot do that. Conversion happens
-- in the uploader's BROWSER (PORT-CLOUDFLARE.md §6) and arrives as a series of
-- separate HTTP requests over seconds or minutes, with a tab that might close
-- half way through. Somewhere has to hold the half-built replacement, and it
-- cannot be draft_pages: the UNIQUE(draft_id, page_number) index means the new
-- page 1 and the old page 1 cannot both exist, so writing the new one would
-- destroy the old before anyone knows whether the new file even converts.
--
-- So the replacement is STAGED. draft_page_staging is draft_pages column for
-- column; draft_swaps holds the handful of drafts-row fields the swap will
-- rewrite (kind, original_filename, original_path) plus the fact that a swap is
-- in flight at all, which is what makes /drafts/:id/pages, /finalize and /fail
-- behave differently while one is. At finalize the promotion is a single D1
-- batch — delete the live pages, copy the staged ones over, rewrite the draft
-- row, drop the staging rows, and in the same batch delete the old stored files
-- and rename the staged ones into their place. A batch is atomic on D1's side,
-- so there is no instant at which a reader can see half a swap. A failure at
-- any earlier point deletes the staging rows and the staged bytes and leaves
-- the draft exactly as it was.
--
-- The staged BYTES need no schema at all: they go into the existing file store
-- under stored_names prefixed `swap/` (worker/src/services/drafts/attachments.js
-- SAFE_REL), which is a namespace the app could not otherwise produce, and the
-- promotion strips the prefix rather than copying a single byte.
--
-- PRODUCTION D1 IS LIVE. This migration is two CREATE TABLEs and one CREATE
-- INDEX and touches no existing table, column, index or row. Nothing to
-- backfill, nothing to lock, and a board that never uses the feature carries
-- two empty tables. Both are ON DELETE CASCADE from drafts, so removing a
-- draft cleans up an abandoned swap for free.

CREATE TABLE draft_swaps (
  draft_id          INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('docx','pdf','images','text')),
  original_filename TEXT,
  original_path     TEXT,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE draft_page_staging (
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
CREATE UNIQUE INDEX idx_draft_page_staging_unique ON draft_page_staging(draft_id, page_number);
