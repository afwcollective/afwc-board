-- 002 — recurring weekly meetings.
--
-- The group meets on a fixed weekly rhythm (Saturdays in front of Hilo, Mondays
-- at the r. bar). Leaders should never have to hand-enter those rows, so a rule
-- describes the rhythm once and occurrences are computed at read time. Nothing
-- is materialised into `meetings`; the landing page merges the two sources.
--
-- Times are stored as LOCAL Baltimore wall-clock ("13:00"), not UTC: "every
-- Saturday at 1pm" means 1pm on the wall regardless of daylight saving. The
-- conversion to a UTC instant happens per-occurrence in src/util/dates.js.

CREATE TABLE recurring_meetings (
  id             INTEGER PRIMARY KEY,
  -- 0 = Sunday … 6 = Saturday, matching JS getDay() and Intl weekday order.
  weekday        INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- "HH:MM" local Baltimore wall-clock, 24-hour.
  time_hhmm      TEXT NOT NULL,
  title          TEXT NOT NULL,
  location_label TEXT,
  -- marker position as PERCENT of the floor-map SVG viewBox, same as meetings.
  map_x          REAL,
  map_y          REAL,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_recurring_active ON recurring_meetings(is_active);

-- One row = "the occurrence of this rule on this local date does not happen."
-- skip_date is the LOCAL (Baltimore) calendar date of the skipped occurrence,
-- "YYYY-MM-DD", which is what the occurrence generator hands back.
CREATE TABLE recurring_skips (
  id           INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_meetings(id) ON DELETE CASCADE,
  skip_date    TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (recurring_id, skip_date)
);
