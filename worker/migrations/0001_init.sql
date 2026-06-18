-- Initial schema for the fantasy-live league mirror.
--
-- Design notes (settled in the planning brief):
--   * Every table carries a `season` column from day one.
--   * Natural keys only -- no autoincrement surrogate, no "sheet row number".
--   * owner_id is the lowercased display name. It is the stable join key today
--     (the sheet only gives us names) and a future drafting UI can keep writing
--     the same owner_id or supply its own without schema change.
--   * Draft picks are identified by (season, race_id, owner_id) with a
--     pick_order column, so the same shape accepts direct writes later.
--   * races denormalizes track_name / race_type_id / winner_driver_id from the
--     schedule feed (cheap, saves joins on the read path).

CREATE TABLE owners (
  season       INTEGER NOT NULL,
  owner_id     TEXT    NOT NULL,   -- lowercased display_name
  display_name TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,   -- ISO-8601 UTC
  PRIMARY KEY (season, owner_id)
);

CREATE TABLE standings (
  season        INTEGER NOT NULL,
  owner_id      TEXT    NOT NULL,
  season_points REAL    NOT NULL,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (season, owner_id)
);

CREATE TABLE races (
  season                INTEGER NOT NULL,
  race_id               INTEGER NOT NULL,
  series_id             INTEGER NOT NULL,
  race_name             TEXT,
  track_name            TEXT,
  race_type_id          INTEGER,
  race_date             TEXT,        -- NASCAR race_date string (as published)
  start_time_utc        TEXT,        -- derived ISO-8601 UTC green-flag instant
  winner_driver_id      INTEGER,     -- null until raced
  lap_times_archived_at TEXT,        -- set once lap-times.json is in R2
  r2_key                TEXT,        -- R2 object key for the archived lap-times
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (season, race_id)
);

CREATE TABLE picks (
  season      INTEGER NOT NULL,
  race_id     INTEGER NOT NULL,
  owner_id    TEXT    NOT NULL,
  driver_name TEXT    NOT NULL,   -- canonical (cleanName-resolved) spelling
  pick_order  INTEGER NOT NULL,   -- sequence the pick was entered in the sheet
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (season, race_id, owner_id)
);

CREATE TABLE draft_order (
  season         INTEGER NOT NULL,
  race_id        INTEGER NOT NULL,
  owner_id       TEXT    NOT NULL,
  draft_position INTEGER NOT NULL,  -- 0-based clock order (prev-race finish)
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (season, race_id, owner_id)
);

CREATE TABLE meta (
  key        TEXT PRIMARY KEY,   -- e.g. last_reconcile_at, schedule_refreshed_at
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_races_season_date ON races (season, race_date);
CREATE INDEX idx_picks_season_race ON picks (season, race_id);
CREATE INDEX idx_draft_order_season_race ON draft_order (season, race_id);
