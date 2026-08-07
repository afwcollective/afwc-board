-- 006 — Quote rail.
--
-- One short quote on the landing page, leader-editable, same spirit as the
-- about_md blob: a handful of rows a leader curates from /admin/quotes rather
-- than a developer editing a template. Unlike about_md this needed a real
-- table — there can be more than one quote, and a leader retires or reorders
-- them without losing the others.
--
-- is_active   — deactivated quotes stay in the table (so nothing is lost by
--   accident) but never appear in rotation.
-- sort_order  — a leader-set integer, lower first, ties broken by id. There
--   is no drag-and-drop; the admin page reorders by editing the number, which
--   is plenty for a handful of quotes.
-- created_by  — nullable: the bootstrap seed below has no user behind it.
--
-- Rotation itself (deterministic "quote of the day", same for every visitor
-- on a given date) is application logic in src/models.js, not a schema
-- concern — there is nothing here that picks the quote.

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

-- Seeding the one starter quote happens in src/models.js (quotes.ensureSeed),
-- bootstrapped on first read exactly like about_md — idempotent, and never
-- fighting a leader's own edits on a later boot. Not done here: a migration
-- that inserts content, rather than shape, is a migration you can't safely
-- re-run or reason about.
