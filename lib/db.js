const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function open() {
  // WINPROB_DB lets you point at a different file (handy for testing).
  const db = new DatabaseSync(process.env.WINPROB_DB || path.join(DATA_DIR, 'winprob.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS teams (
      roster_id INTEGER PRIMARY KEY,
      name TEXT,
      owner TEXT,
      avatar TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      ts INTEGER NOT NULL,          -- unix seconds
      season TEXT NOT NULL,
      week INTEGER NOT NULL,
      matchup_id INTEGER NOT NULL,
      roster_id INTEGER NOT NULL,
      points REAL,
      proj_final REAL,
      win_prob REAL,
      PRIMARY KEY (season, week, matchup_id, roster_id, ts)
    ) WITHOUT ROWID;
    -- One row each time a starter's points change.
    CREATE TABLE IF NOT EXISTS player_points (
      ts INTEGER NOT NULL,
      season TEXT NOT NULL,
      week INTEGER NOT NULL,
      roster_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      points REAL,
      PRIMARY KEY (season, week, roster_id, player_id, ts)
    ) WITHOUT ROWID;
    -- Big win-probability swings and what caused them.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      season TEXT NOT NULL,
      week INTEGER NOT NULL,
      matchup_id INTEGER NOT NULL,
      roster_id INTEGER NOT NULL,   -- team the swing helped
      delta REAL NOT NULL,          -- swing size, 0..1
      win_prob REAL,                -- that team's win prob after the swing
      players_json TEXT,            -- [{player_id, roster_id, name, pos, delta_pts, play}]
      label TEXT,                   -- set when no player scored
      source TEXT DEFAULT 'live'
    );
    CREATE INDEX IF NOT EXISTS events_week ON events (season, week, matchup_id, ts);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  const cols = db.prepare('PRAGMA table_info(teams)').all().map((c) => c.name);
  if (!cols.includes('color')) db.exec('ALTER TABLE teams ADD COLUMN color TEXT');

  // live = 1 while an NFL game was in progress (drives the "Gametime" view).
  const snapCols = db.prepare('PRAGMA table_info(snapshots)').all().map((c) => c.name);
  if (!snapCols.includes('live')) {
    db.exec('ALTER TABLE snapshots ADD COLUMN live INTEGER');
    // Older rows: the collector polls every second during games and every
    // minute otherwise, so rows within 5 s of a neighbor were recorded live.
    db.exec(`
      WITH g AS (
        SELECT season, week, matchup_id, roster_id, ts,
          ts - LAG(ts) OVER w AS gap_prev,
          LEAD(ts) OVER w - ts AS gap_next
        FROM snapshots
        WINDOW w AS (PARTITION BY season, week, matchup_id, roster_id ORDER BY ts)
      )
      UPDATE snapshots SET live = CASE WHEN g.gap_prev <= 5 OR g.gap_next <= 5 THEN 1 ELSE 0 END
      FROM g
      WHERE snapshots.season = g.season AND snapshots.week = g.week AND snapshots.matchup_id = g.matchup_id
        AND snapshots.roster_id = g.roster_id AND snapshots.ts = g.ts;
    `);
  }
  return db;
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

module.exports = { open, getSetting, setSetting, DATA_DIR };
